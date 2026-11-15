// #156: o Claude escreve o texto do pedido. Fica como caso de uso que o Cron chama (`writeDrafts`),
// e não como ClaudeTask: a tarefa do laço (#66) grava em claude_suggestions e lê o pendente de lá,
// e aqui o pendente e o resultado são do próprio agregado (status `writing`, `acceptDraft`).
import { ClaudeError, DEFAULT_MODEL, type Ask } from '../claude/client.js';
import { SUPPLIER_REQUEST_OUTPUT_SCHEMA, defaultDueOn } from '../domain/index.js';
import type { SupplierRequestDeps } from './ports.js';
import { buildSupplierRequestPrompt } from './prompt.js';
import { NOT_FOUND, conflict, type WriteDraftResult } from './results.js';
import { catalogOf, loadPlanned, persist } from './shared.js';

/**
 * #156/AC-1, AC-6: pergunta ao Claude o texto de um pedido `writing` e o entrega ao agregado, que
 * o aceita (`draft`) ou descarta com o motivo (número fora do catálogo, formato errado). Se o
 * Claude falha, a exceção sobe e o pedido segue `writing` para a próxima rodada.
 */
export async function writeDraft(deps: SupplierRequestDeps, requestId: string, ask: Ask): Promise<WriteDraftResult> {
  const request = await deps.requests.findById(requestId);
  if (!request) return NOT_FOUND;
  if (request.status !== 'writing') return conflict('wrong_state');
  const planned = await loadPlanned(deps, request.invoiceAccessKey);
  if (!planned) return conflict('no_longer_qualifies');

  const draftedAt = deps.clock.now().toISOString();
  const dueOn = defaultDueOn(draftedAt);
  const catalog = catalogOf(planned, dueOn);
  const { system, prompt } = buildSupplierRequestPrompt(catalog, { subject: request.subject, asks: request.asks });
  const model = deps.config.model ?? DEFAULT_MODEL;
  const raw = await ask<unknown>({ system, prompt, schema: SUPPLIER_REQUEST_OUTPUT_SCHEMA, model });

  const expected = request.updatedAt;
  const status = request.acceptDraft(raw, catalog, { draftedAt, model, dueOn });
  if (!(await persist(deps, request, expected))) return conflict('stale');
  return { kind: 'ok', status, request: request.snapshot() };
}

export type WriteDraftsResult = {
  readonly drafted: number;
  readonly discarded: number;
  readonly failed: number;
  /** #156: o limite ou a credencial do Claude recusou: o resto fica para a próxima rodada. */
  readonly stopped: boolean;
};

/** #156: a rodada do Cron: escreve todos os pedidos `writing`, um a um; uma falha não derruba os outros. */
export async function writeDrafts(deps: SupplierRequestDeps, ask: Ask): Promise<WriteDraftsResult> {
  let drafted = 0;
  let discarded = 0;
  let failed = 0;
  for (const request of await deps.requests.listByStatus('writing')) {
    try {
      const result = await writeDraft(deps, request.id, ask);
      if (result.kind === 'ok') {
        if (result.status === 'draft') drafted += 1;
        else discarded += 1;
      } else failed += 1;
    } catch (error) {
      failed += 1;
      if (error instanceof ClaudeError && error.isGlobal) return { drafted, discarded, failed, stopped: true };
    }
  }
  return { drafted, discarded, failed, stopped: false };
}
