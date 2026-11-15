// #156/AC-3, AC-4, AC-5: "Emitir e enviar": só por chamada explícita de uma pessoa.
import { DomainError, Money, assertDraftMatchesQueue, emitReturnNote } from '../domain/index.js';
import { deliver } from './deliver.js';
import type { SupplierRequestDeps } from './ports.js';
import { NOT_FOUND, conflict, type DeliveryResult } from './results.js';
import { loadPlanned, persist, queueRequestOf } from './shared.js';

/**
 * #156/AC-4: emite a nota pelo mock, uma por linha da fila (reemitir devolve a mesma), marca a linha
 * `emitida` com o número, anexa a nota ao pedido e envia. Se o envio falha, a nota segue emitida e
 * o pedido fica `send_failed`; "tentar de novo" reenvia sem reemitir.
 */
export async function emitAndSend(deps: SupplierRequestDeps, requestId: string, by: string): Promise<DeliveryResult> {
  const request = await deps.requests.findById(requestId);
  if (!request) return NOT_FOUND;
  if (request.status !== 'draft' || request.body === null) return conflict('wrong_state');
  const planned = await loadPlanned(deps, request.invoiceAccessKey);
  if (!planned) return conflict('no_longer_qualifies');

  const row = await deps.queue.ensureRow(queueRequestOf(planned));
  try {
    assertDraftMatchesQueue(planned.draft, Money.ofCents(row.valueCents));
  } catch (error) {
    if (error instanceof DomainError) return conflict('queue_mismatch');
    throw error;
  }

  const now = deps.clock.now();
  const existing = await deps.emissions.findByQueueRow(row.id);
  const issued = emitReturnNote(planned.draft, {
    queueRowId: row.id,
    sequence: existing ? 1 : await deps.emissions.nextSequence(),
    issuedOn: now.toISOString().slice(0, 10),
    issuerCnpj: deps.config.issuerCnpj,
    existing,
  });
  const note = existing ? issued : await deps.emissions.save(row.id, issued);

  if ((await deps.queue.markEmitted(row.id, String(note.numero), by, now)) !== 'ok') return conflict('queue_not_pending');

  if (!request.attachments.some((a) => a.kind === 'return_note')) {
    const expected = request.updatedAt;
    request.attachReturnNote(note, by, now.toISOString());
    if (!(await persist(deps, request, expected))) return conflict('stale');
  }

  const outcome = await deliver(deps, request, note, planned, by);
  if (outcome === 'stale') return conflict('stale');
  return { kind: 'ok', status: outcome, request: request.snapshot(), note };
}
