/* #156: o Claude escreve o texto do pedido. Fica como caso de uso que o Cron chama (`writeDrafts`),
   e não como ClaudeTask: a tarefa do laço (#66) grava em claude_suggestions e lê o pendente de lá,
   e aqui o pendente e o resultado são do próprio agregado (status `writing`, `acceptDraft`). */
import { ClaudeError, DEFAULT_MODEL, type Ask } from '../claude/client.js';
import { MAX_PER_RUN, storedError } from '../claude/runner.js';
import type { SupplierRequest } from '../domain/index.js';
import { SUPPLIER_REQUEST_OUTPUT_SCHEMA, SYSTEM_ACTOR, defaultDueOn } from '../domain/index.js';
import type { SupplierRequestDeps } from './ports.js';
import { buildSupplierRequestPrompt } from './prompt.js';
import { NOT_FOUND, conflict, type WriteDraftResult } from './results.js';
import { catalogOf, loadPlanned, persist } from './shared.js';

/** #156/LLM-10: quanto um pedido pode seguir `writing` antes de o sistema desistir do Claude e descartá-lo. */
export const WRITING_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * #156/AC-1, AC-6: pergunta ao Claude o texto de um pedido `writing` e o entrega ao agregado, que
 * o aceita (`draft`) ou descarta com o motivo (número fora do catálogo, formato errado). Se o
 * Claude falha, a exceção sobe e o pedido segue `writing` para a próxima rodada, até a janela
 * `WRITING_WINDOW_MS`; passada a janela, ou se a decisão deixou de qualificar, o sistema o descarta.
 */
export async function writeDraft(deps: SupplierRequestDeps, requestId: string, ask: Ask): Promise<WriteDraftResult> {
  const request = await deps.requests.findById(requestId);
  if (!request) return NOT_FOUND;
  if (request.status !== 'writing') return conflict('wrong_state');
  const planned = await loadPlanned(deps, request.invoiceAccessKey);
  const draftedAt = deps.clock.now().toISOString();
  if (!planned) return discardBySystem(deps, request, 'no_longer_qualifies', draftedAt);
  if (Date.parse(draftedAt) - Date.parse(request.createdAt) > WRITING_WINDOW_MS) {
    return discardBySystem(deps, request, 'claude_unavailable', draftedAt);
  }

  const dueOn = defaultDueOn(draftedAt);
  const catalog = catalogOf(planned, dueOn);
  const { system, prompt } = buildSupplierRequestPrompt(catalog, { subject: request.subject, asks: request.asks });
  const model = DEFAULT_MODEL;
  const raw = await ask<unknown>({ system, prompt, schema: SUPPLIER_REQUEST_OUTPUT_SCHEMA, model });

  const expected = request.updatedAt;
  const status = request.acceptDraft(raw, catalog, { draftedAt, model, dueOn });
  if (!(await persist(deps, request, expected))) return conflict('stale');
  return { kind: 'ok', status, request: request.snapshot() };
}

/** #156: o sistema descarta o pedido `writing` que não vai mais ser escrito, com o motivo registrado. */
async function discardBySystem(
  deps: SupplierRequestDeps,
  request: SupplierRequest,
  reason: 'no_longer_qualifies' | 'claude_unavailable',
  at: string,
): Promise<WriteDraftResult> {
  const expected = request.updatedAt;
  request.discard(SYSTEM_ACTOR, at, reason);
  if (!(await persist(deps, request, expected))) return conflict('stale');
  return { kind: 'ok', status: 'discarded', request: request.snapshot() };
}

export type WriteDraftsResult = {
  readonly drafted: number;
  readonly discarded: number;
  /** #156: conflito esperado (a pessoa descartou ou editou no meio da rodada): o pedido segue com ela, não é falha. */
  readonly skipped: number;
  readonly failed: number;
  /** #156: os ids dos pedidos que falharam nesta rodada, para quem chama acompanhar. */
  readonly failedIds: readonly string[];
  /** #156: o limite ou a credencial do Claude recusou: o resto fica para a próxima rodada. */
  readonly stopped: boolean;
};

/** #156/LLM-10: `limit` é o teto de pedidos por rodada; sem ele, `MAX_PER_RUN`. */
export type WriteDraftsOptions = { readonly limit?: number };

/** #156: a rodada do Cron: escreve até `limit` pedidos `writing`, um a um; uma falha não derruba os outros. */
export async function writeDrafts(deps: SupplierRequestDeps, ask: Ask, options: WriteDraftsOptions = {}): Promise<WriteDraftsResult> {
  let drafted = 0;
  let discarded = 0;
  let skipped = 0;
  const failedIds: string[] = [];
  const result = (stopped: boolean): WriteDraftsResult => ({ drafted, discarded, skipped, failed: failedIds.length, stopped, failedIds });
  const pending = await deps.requests.listByStatus('writing');
  for (const request of pending.slice(0, options.limit ?? MAX_PER_RUN)) {
    try {
      const result = await writeDraft(deps, request.id, ask);
      if (result.kind === 'ok') {
        if (result.status === 'draft') drafted += 1;
        else discarded += 1;
      } else skipped += 1;
    } catch (error) {
      failedIds.push(request.id);
      deps.log(`pedido ${request.id}: falhou (${storedError(error, deps.secrets)})`);
      if (error instanceof ClaudeError && error.isGlobal) return result(true);
    }
  }
  return result(false);
}
