// #156/AC-1, AC-8: abrir o pedido ao fornecedor para as propostas decididas. Nada é emitido nem enviado.
import {
  DomainError,
  SYSTEM_ACTOR,
  SupplierRequest,
  assertDraftMatchesQueue,
  hasOpenRequest,
  Money,
  type SupplierRequestSnapshot,
} from '../domain/index.js';
import type { DecidedCase, SupplierRequestDeps } from './ports.js';
import { planCase, queueRequestOf, subjectOf, type PlannedCase } from './shared.js';

export type SkipReason =
  | 'not_qualifying'
  | 'open_request_exists'
  | 'already_handled'
  | 'no_supplier_email'
  | 'queue_mismatch';

export type OpenOutcome =
  | { readonly kind: 'opened'; readonly request: SupplierRequestSnapshot }
  | { readonly kind: 'skipped'; readonly reason: SkipReason };

const REQUEST_TYPE = 'return_note';

/**
 * #156/AC-1: abre o pedido de um caso já planejado: o e-mail do cadastro, a linha na fila da #140
 * (publicada se falta) e o total da nota conferido com o valor dela (AC-2).
 */
export async function openPlanned(
  deps: SupplierRequestDeps,
  planned: PlannedCase,
  by: string,
  at: string,
): Promise<OpenOutcome> {
  const { invoice } = planned.decided;
  const to = (await deps.directory.emailOf(invoice.supplierId))?.trim() ?? '';
  if (to === '') return { kind: 'skipped', reason: 'no_supplier_email' };
  const row = await deps.queue.ensureRow(queueRequestOf(planned));
  try {
    assertDraftMatchesQueue(planned.draft, Money.ofCents(row.valueCents));
  } catch (error) {
    if (error instanceof DomainError) return { kind: 'skipped', reason: 'queue_mismatch' };
    throw error;
  }
  const request = SupplierRequest.open({
    id: deps.ids.next(),
    createdAt: at,
    createdBy: by,
    invoiceAccessKey: invoice.accessKey,
    supplierId: invoice.supplierId,
    requestType: REQUEST_TYPE,
    to,
    subject: subjectOf(planned),
    asks: planned.plan.asks,
    channel: deps.config.channel,
  });
  if ((await deps.requests.add(request)) === 'duplicate_open') return { kind: 'skipped', reason: 'open_request_exists' };
  return { kind: 'opened', request: request.snapshot() };
}

export type OpenForDecidedResult = {
  readonly opened: string[];
  readonly skipped: { readonly invoiceAccessKey: string; readonly reason: SkipReason }[];
  /** #156: casos cuja abertura lançou; ficam para a próxima rodada sem derrubar os outros. */
  readonly failed: number;
};

/** #156: `limit` é o teto de pedidos abertos por rodada (o Cron tem teto de subrequests); sem ele, todos. */
export type OpenForDecidedOptions = { readonly limit?: number };

async function openOne(deps: SupplierRequestDeps, decided: DecidedCase): Promise<OpenOutcome> {
  const planned = planCase(decided);
  if (!planned) return { kind: 'skipped', reason: 'not_qualifying' };
  const existing = (await deps.requests.listByInvoice(decided.invoice.accessKey)).filter((r) => r.requestType === REQUEST_TYPE);
  if (hasOpenRequest(existing, decided.invoice.accessKey, REQUEST_TYPE)) return { kind: 'skipped', reason: 'open_request_exists' };
  // #156: o que já foi tratado (enviado ou descartado) não reabre pela varredura; "refazer" é da pessoa.
  if (existing.length > 0) return { kind: 'skipped', reason: 'already_handled' };
  return openPlanned(deps, planned, decided.decidedBy ?? SYSTEM_ACTOR, deps.clock.now().toISOString());
}

/**
 * #156/AC-1, AC-8: a varredura das propostas decididas, idempotente como a de dock/publish-decided:
 * com tudo já aberto, lê e não grava nada. Cada caso é independente; o que não qualifica, não tem
 * e-mail, não fecha com a fila ou já tem pedido fica de fora, com o motivo.
 */
export async function openForDecided(deps: SupplierRequestDeps, options: OpenForDecidedOptions = {}): Promise<OpenForDecidedResult> {
  const opened: string[] = [];
  const skipped: OpenForDecidedResult['skipped'][number][] = [];
  let failed = 0;
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  for (const decided of await deps.source.listDecided()) {
    if (opened.length >= limit) break;
    let outcome: OpenOutcome;
    try {
      outcome = await openOne(deps, decided);
    } catch {
      // #156: um caso com defeito não bloqueia os outros; quem chama loga só a contagem.
      failed += 1;
      continue;
    }
    if (outcome.kind === 'opened') opened.push(outcome.request.id);
    else skipped.push({ invoiceAccessKey: decided.invoice.accessKey, reason: outcome.reason });
  }
  return { opened, skipped, failed };
}
