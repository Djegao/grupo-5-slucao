// #156/AC-5: o envio do e-mail com a nota anexa, usado pelo "Emitir e enviar" e pelo "tentar de novo".
import type { ReturnNote, SupplierRequest } from '../domain/index.js';
import type { SendResult, SupplierRequestDeps } from './ports.js';
import { catalogOf, persist, type PlannedCase } from './shared.js';

const MAX_REASON = 100;
/** #156: o motivo guardado quando a porta lança: um código, nunca o texto da exceção. */
export const SEND_ERROR = 'send_error';

/** #156/AC-5: envia e registra no pedido: `sent` com o id do provedor, ou `send_failed` com o motivo. A nota segue emitida. */
export async function deliver(
  deps: SupplierRequestDeps,
  request: SupplierRequest,
  note: ReturnNote,
  planned: PlannedCase,
  by: string,
): Promise<'sent' | 'send_failed' | 'stale'> {
  const body = request.renderedBody(catalogOf(planned, request.dueOn ?? ''));
  let result: SendResult;
  try {
    result = await deps.sender.send({
      requestId: request.id,
      to: request.to,
      subject: request.subject,
      body,
      attachments: [
        { filename: `nota-devolucao-${note.nota_id}.json`, contentType: 'application/json', content: JSON.stringify(note) },
      ],
    });
  } catch {
    result = { ok: false, reason: SEND_ERROR };
  }
  const at = deps.clock.now().toISOString();
  const expected = request.updatedAt;
  if (result.ok) request.markSent(by, at, result.providerMessageId);
  else request.markSendFailed(result.reason.slice(0, MAX_REASON), by, at);
  if (!(await persist(deps, request, expected))) return 'stale';
  return result.ok ? 'sent' : 'send_failed';
}
