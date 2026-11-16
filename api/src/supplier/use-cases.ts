import type { Ask } from '../claude/client.js';
import {
  buildSupplierRequestFacts,
  validateRequestText,
  type IssuedReturnNote,
  type RequestTextRejection,
  type SupplierRequestText,
} from '../domain/index.js';
import { draftRequest, todayIso, type DraftResult } from './draft.js';
import { kitNoteAttachment } from './kit-note.js';
import type { MailMessage, MailResult, RequestRecord, SourceInvoice, SupplierDeps } from './ports.js';

// #11: os casos de uso do pedido ao fornecedor (#2): emitir e enviar, editar o corpo, descartar e refazer.
// #11: cada um devolve um resultado tipado que a camada da API mapeia para HTTP; aqui não há HTTP.
// #11: cada escrita confirma sozinha (PostgREST não tem transação entre tabelas); o pedido (SupplierRequest) é a raiz que manda.
// #11: a ordem do envio é: conferir a fila, emitir (idempotente por devolução), registrar no pedido, mover a fila (com guarda),
// #11: enviar o e-mail e marcar. Uma falha no meio deixa um estado que reenviar conserta, sem segunda nota: a janela é entre
// #11: emitir e registrar (a emissão idempotente devolve a mesma nota) e entre mover a fila e marcar (o reenvio vê a fila emitida
// #11: com o número do pedido e segue). A transação de um só commit, se vier, é da unidade de trabalho do OLTP, não daqui.

const SEND_FAILED_FALLBACK = 'send_failed';
const MAILER_ERROR = 'mailer_error';

export type SendResult =
  | { readonly kind: 'ok'; readonly record: RequestRecord; readonly issued: IssuedReturnNote }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'conflict'; readonly reason: 'not_sendable' | 'queue_not_pending' | 'queue_entry_missing' | 'issuance_missing' }
  | { readonly kind: 'invalid'; readonly reason: 'source_missing' | 'text_invalid' }
  | { readonly kind: 'send_failed'; readonly record: RequestRecord; readonly reason: string };

export type EditResult =
  | { readonly kind: 'ok'; readonly record: RequestRecord; readonly rendered: SupplierRequestText }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'conflict'; readonly reason: 'not_draft' }
  | { readonly kind: 'invalid'; readonly reason: 'source_missing' }
  | ({ readonly kind: 'invalid' } & Pick<RequestTextRejection, 'reason' | 'field'>);

export type DiscardResult =
  | { readonly kind: 'ok'; readonly record: RequestRecord }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'conflict'; readonly reason: 'not_draft' }
  | { readonly kind: 'invalid'; readonly reason: 'reason_required' };

export type RedraftResult = DraftResult | { readonly kind: 'not_found' };

export type SupplierUseCases = {
  /** #11/AC-4, AC-5: emite a nota (uma vez só), passa a fila para emitida e envia o e-mail com a nota anexa. */
  send(id: number, by: string): Promise<SendResult>;
  /** #11/AC-6: troca só o corpo de um rascunho (forma com {{chave}}), revalidado contra o catálogo. */
  editBody(id: number, body: string): Promise<EditResult>;
  /** #11/AC-6: descarta um rascunho, com o motivo e quem descartou. */
  discard(id: number, by: string, reason: string): Promise<DiscardResult>;
  /** #11/AC-6: novo rascunho da devolução de um pedido já feito, só se não houver pedido aberto da nota. */
  redraft(id: number, ask: Ask): Promise<RedraftResult>;
};

/** #11: o catálogo do pedido é refeito da nota guardada, da nota de origem e do prazo gravado. */
const catalogOf = (record: RequestRecord, source: SourceInvoice) =>
  buildSupplierRequestFacts(record.request.note, source.invoice, record.request.dueOn);

/** #11/AC-4: a nota emitida é a do pedido; sem ela, emite (idempotente por devolução) e registra. */
async function ensureIssued(deps: SupplierDeps, record: RequestRecord): Promise<IssuedReturnNote | null> {
  const { request } = record;
  if (request.issuedNote !== null) return request.issuedNote;
  if (request.status !== 'draft') return null;
  const issued = await deps.notes.issue(record.queueId, request.note, todayIso(deps.clock.now()));
  request.recordIssuance(issued);
  await deps.requests.save(request);
  return issued;
}

/** #11/AC-4: a fila é conferida ANTES de emitir: pendente, ou emitida com o número já emitido deste pedido (reenvio). */
async function checkQueue(deps: SupplierDeps, record: RequestRecord): Promise<'pending' | 'already_moved' | SendResult> {
  const now = deps.clock.now();
  const pending = (await deps.queue.list('pendente', now)).find((e) => e.id === record.queueId);
  if (pending !== undefined) return 'pending';
  const done = (await deps.queue.list('emitida', now)).find((e) => e.id === record.queueId);
  if (done !== undefined) {
    const issuedNumber = record.request.issuedNote?.number;
    return issuedNumber !== undefined && done.emitted?.number === String(issuedNumber) ? 'already_moved' : { kind: 'conflict', reason: 'queue_not_pending' };
  }
  const cancelled = (await deps.queue.list('cancelada', now)).find((e) => e.id === record.queueId);
  return { kind: 'conflict', reason: cancelled === undefined ? 'queue_entry_missing' : 'queue_not_pending' };
}

/** #11/AC-4: a devolução pendente vira emitida com o número; se mudou entre a conferência e agora, é conflito. */
async function moveQueue(deps: SupplierDeps, record: RequestRecord, issued: IssuedReturnNote, by: string): Promise<SendResult | null> {
  const moved = await deps.queue.emit(record.queueId, String(issued.number), by, deps.clock.now());
  if (moved.kind === 'ok') return null;
  return { kind: 'conflict', reason: moved.kind === 'not_found' ? 'queue_entry_missing' : 'queue_not_pending' };
}

/** #11/AC-5: o envio; falha do envio, ou erro lançado pela porta, vira send_failed com um motivo sem o texto do erro. */
async function mail(deps: SupplierDeps, record: RequestRecord, message: MailMessage, by: string): Promise<SendResult | null> {
  let result: MailResult;
  try {
    result = await deps.mailer.send(message);
  } catch {
    // #11/AC-5: o texto do erro da porta não vai para o pedido nem para quem chama (layer-exposure).
    result = { ok: false, reason: MAILER_ERROR };
  }
  if (result.ok) {
    record.request.markSent();
    await deps.requests.save(record.request, {
      sent: { by, at: deps.clock.now(), channel: result.channel, providerMessageId: result.providerMessageId },
    });
    return null;
  }
  const reason = result.reason.trim() === '' ? SEND_FAILED_FALLBACK : result.reason;
  record.request.markSendFailed(reason);
  await deps.requests.save(record.request);
  return { kind: 'send_failed', record, reason };
}

async function send(deps: SupplierDeps, id: number, by: string): Promise<SendResult> {
  const record = await deps.requests.get(id);
  if (record === null) return { kind: 'not_found' };
  const { request } = record;
  if (request.status !== 'draft' && request.status !== 'send_failed') return { kind: 'conflict', reason: 'not_sendable' };
  const source = await deps.source.find(request.invoiceAccessKey);
  if (source === null) return { kind: 'invalid', reason: 'source_missing' };
  const text = validateRequestText({ subject: request.subject, body: request.body, asks: request.asks }, catalogOf(record, source));
  if (!text.ok) return { kind: 'invalid', reason: 'text_invalid' };
  const gate = await checkQueue(deps, record);
  if (typeof gate === 'object') return gate;
  const issued = await ensureIssued(deps, record);
  if (issued === null) return { kind: 'conflict', reason: 'issuance_missing' };
  const blocked = gate === 'pending' ? await moveQueue(deps, record, issued, by) : null;
  if (blocked !== null) return blocked;
  const message: MailMessage = {
    invoiceAccessKey: request.invoiceAccessKey,
    supplierId: issued.supplierId,
    requestType: request.requestType,
    to: record.to,
    ...text.rendered,
    attachments: [kitNoteAttachment(issued)],
    dueOn: request.dueOn,
  };
  return (await mail(deps, record, message, by)) ?? { kind: 'ok', record, issued };
}

async function editBody(deps: SupplierDeps, id: number, body: string): Promise<EditResult> {
  const record = await deps.requests.get(id);
  if (record === null) return { kind: 'not_found' };
  if (record.request.status !== 'draft') return { kind: 'conflict', reason: 'not_draft' };
  const source = await deps.source.find(record.request.invoiceAccessKey);
  if (source === null) return { kind: 'invalid', reason: 'source_missing' };
  const result = record.request.editBody(body, catalogOf(record, source));
  if (!result.ok) return { kind: 'invalid', reason: result.reason, field: result.field };
  await deps.requests.save(record.request);
  return { kind: 'ok', record, rendered: result.rendered };
}

async function discard(deps: SupplierDeps, id: number, by: string, reason: string): Promise<DiscardResult> {
  const record = await deps.requests.get(id);
  if (record === null) return { kind: 'not_found' };
  if (record.request.status !== 'draft') return { kind: 'conflict', reason: 'not_draft' };
  if (reason.trim() === '') return { kind: 'invalid', reason: 'reason_required' };
  record.request.discard(reason);
  await deps.requests.save(record.request, { discarded: { by, at: deps.clock.now() } });
  return { kind: 'ok', record };
}

async function redraft(deps: SupplierDeps, id: number, ask: Ask): Promise<RedraftResult> {
  const previous = await deps.requests.get(id);
  if (previous === null) return { kind: 'not_found' };
  return draftRequest(deps, previous.queueId, ask);
}

/** #11: os casos de uso ligados às portas. */
export const createSupplierUseCases = (deps: SupplierDeps): SupplierUseCases => ({
  send: (id, by) => send(deps, id, by),
  editBody: (id, body) => editBody(deps, id, body),
  discard: (id, by, reason) => discard(deps, id, by, reason),
  redraft: (id, ask) => redraft(deps, id, ask),
});
