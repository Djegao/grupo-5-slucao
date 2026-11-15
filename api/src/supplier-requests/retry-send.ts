// #156: "tentar de novo": reenvia o e-mail de um pedido `send_failed`, sem reemitir a nota.
import { deliver } from './deliver.js';
import type { SupplierRequestDeps } from './ports.js';
import { NOT_FOUND, conflict, type DeliveryResult } from './results.js';
import { loadPlanned } from './shared.js';

export async function retrySend(deps: SupplierRequestDeps, requestId: string, by: string): Promise<DeliveryResult> {
  const request = await deps.requests.findById(requestId);
  if (!request) return NOT_FOUND;
  if (request.status !== 'send_failed') return conflict('wrong_state');
  const attached = request.attachments.find((a) => a.kind === 'return_note');
  const note = attached ? await deps.emissions.findByNoteId(attached.returnNoteId) : null;
  if (!note) return conflict('wrong_state');
  const planned = await loadPlanned(deps, request.invoiceAccessKey);
  if (!planned) return conflict('no_longer_qualifies');
  const outcome = await deliver(deps, request, note, planned, by);
  if (outcome === 'stale') return conflict('stale');
  return { kind: 'ok', status: outcome, request: request.snapshot(), note };
}
