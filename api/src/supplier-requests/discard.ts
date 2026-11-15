// #156: descartar e refazer o pedido.
import { hasOpenRequest } from '../domain/index.js';
import { openPlanned } from './open.js';
import type { SupplierRequestDeps } from './ports.js';
import { NOT_FOUND, conflict, type Changed } from './results.js';
import { loadPlanned, persist } from './shared.js';

/** #156: o motivo guardado quando a pessoa descarta sem dizer por quê. */
export const DEFAULT_DISCARD_REASON = 'discarded_by_user';

/** #156: a pessoa descarta o pedido escrevendo, em rascunho ou com o envio falhado. */
export async function discardRequest(
  deps: SupplierRequestDeps,
  requestId: string,
  by: string,
  reason?: string,
): Promise<Changed> {
  const request = await deps.requests.findById(requestId);
  if (!request) return NOT_FOUND;
  if (!request.isOpen) return conflict('wrong_state');
  const expected = request.updatedAt;
  const trimmed = reason?.trim();
  request.discard(by, deps.clock.now().toISOString(), trimmed ? trimmed : DEFAULT_DISCARD_REASON);
  if (!(await persist(deps, request, expected))) return conflict('stale');
  return { kind: 'ok', request: request.snapshot() };
}

/**
 * #156/AC-8: refazer um pedido descartado abre um novo, escrevendo, para a mesma nota. Com outro
 * pedido aberto, conflito. A nota já emitida volta pela linha da fila quando a pessoa emitir.
 */
export async function redo(deps: SupplierRequestDeps, requestId: string, by: string): Promise<Changed> {
  const previous = await deps.requests.findById(requestId);
  if (!previous) return NOT_FOUND;
  if (previous.status !== 'discarded') return conflict('wrong_state');
  const siblings = await deps.requests.listByInvoice(previous.invoiceAccessKey);
  if (hasOpenRequest(siblings, previous.invoiceAccessKey, previous.requestType)) return conflict('open_request_exists');
  const planned = await loadPlanned(deps, previous.invoiceAccessKey);
  if (!planned) return conflict('no_longer_qualifies');
  const outcome = await openPlanned(deps, planned, by, deps.clock.now().toISOString());
  if (outcome.kind === 'opened') return { kind: 'ok', request: outcome.request };
  if (outcome.reason === 'open_request_exists' || outcome.reason === 'no_supplier_email' || outcome.reason === 'queue_mismatch') {
    return conflict(outcome.reason);
  }
  return conflict('no_longer_qualifies');
}
