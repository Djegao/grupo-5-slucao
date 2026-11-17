import { filterOf, overdueReading, validateRequestText, type RequestFilter } from '../domain/index.js';
import { catalogOf, todayIso } from './reply-catalog.js';
import type { FollowUpMail, FollowUpMailResult, FollowUpStamp, ReplyDeps, ReplyList, ReplyListRow, ReplyRequest } from './reply-ports.js';

// #34: os casos de uso da leitura da resposta (#4): a varredura do prazo, o envio da cobrança e a lista.
// #34: cada um devolve um resultado tipado que a camada da API mapeia para HTTP; aqui não há HTTP.

const SEND_FAILED_FALLBACK = 'send_failed';
const MAILER_ERROR = 'mailer_error';
const SHORT_REASON = /^[a-z][a-z0-9_]{0,39}$/;

export type SendFollowUpResult =
  | { readonly kind: 'ok'; readonly request: ReplyRequest }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'conflict'; readonly reason: 'not_no_reply' | 'no_draft' | 'already_sent' | 'send_in_progress' }
  | { readonly kind: 'invalid'; readonly reason: 'text_invalid' }
  | { readonly kind: 'send_failed'; readonly reason: string };

export type ReplyUseCases = {
  /** #34/AC-3: cada pedido `sent` sem leitura depois do prazo vira no_reply com follow_up; sem Claude, sem envio. */
  sweepOverdue(): Promise<{ readonly marked: readonly number[] }>;
  /** #34/AC-4: envia a cobrança rascunhada; só uma pessoa chama, e fica gravado quem e quando. */
  sendFollowUp(id: number, by: string): Promise<SendFollowUpResult>;
  /** #34/AC-5: os pedidos de um filtro, com a leitura, e as contagens de todos os filtros. */
  listRequests(filter: RequestFilter, today: string): Promise<ReplyList>;
};

async function sweepOverdue(deps: ReplyDeps): Promise<{ readonly marked: readonly number[] }> {
  const today = todayIso(deps.clock.now());
  const marked: number[] = [];
  for (const request of await deps.requests.listSent()) {
    const overdue = overdueReading(request, request.reading, today);
    if (overdue === null) continue;
    // #34/AC-3: sem mensagem de origem (null): o OLTP só grava se o pedido ainda não tem leitura.
    if ((await deps.requests.recordReading(request.id, overdue, null)) === 'recorded') marked.push(request.id);
  }
  return { marked };
}

/** #34/AC-4: erro lançado pela porta, ou motivo fora do formato curto, vira um motivo próprio; o texto do provedor não é gravado. */
async function dispatch(deps: ReplyDeps, requestId: number, message: FollowUpMail): Promise<FollowUpMailResult> {
  try {
    const result = await deps.mailer.send(message);
    if (result.ok) return result;
    return { ok: false, reason: SHORT_REASON.test(result.reason) ? result.reason : SEND_FAILED_FALLBACK };
  } catch (error) {
    // #34/AC-4: o texto do erro da porta não vai para o pedido nem para quem chama (layer-exposure).
    // #34/AC-4: o adaptador de #12 (mock-mailer) não registra a falha antes de lançar; aqui vai para o log do servidor
    // #34/AC-4: só a classe do erro, a operação e o pedido, como o storedError do runner (#66) faz com o que não é nosso.
    const className = error instanceof Error ? error.constructor.name : '';
    const name = /^\w{1,64}$/.test(className) ? className : 'Error';
    console.error('#34 envio da cobrança falhou', { operation: 'follow-up-send', requestId, error: name });
    return { ok: false, reason: MAILER_ERROR };
  }
}

/** #35: quem perdeu a reivindicação não grava; o log leva só a operação e o pedido (nunca a ficha) e o resultado é o conflito. */
function lostClaim(requestId: number, operation: string): SendFollowUpResult {
  console.error('#35 a reivindicação da cobrança foi perdida antes de gravar o resultado', { operation, requestId });
  return { kind: 'conflict', reason: 'send_in_progress' };
}

async function sendFollowUp(deps: ReplyDeps, id: number, by: string): Promise<SendFollowUpResult> {
  const request = await deps.requests.get(id);
  if (request === null) return { kind: 'not_found' };
  if (request.status !== 'sent' || request.reading?.replyOutcome !== 'no_reply') return { kind: 'conflict', reason: 'not_no_reply' };
  const { draft, sent } = request.followUp;
  if (sent !== null) return { kind: 'conflict', reason: 'already_sent' };
  if (draft === null) return { kind: 'conflict', reason: 'no_draft' };
  const text = validateRequestText(draft, catalogOf(request));
  if (!text.ok) return { kind: 'invalid', reason: 'text_invalid' };
  // #34/AC-4: a reivindicação vem antes do e-mail; quem não a ganha não envia, e a que fica presa após o envio impede o segundo e-mail.
  const claim = await deps.requests.claimFollowUpSend(id, by);
  if (claim === null) return { kind: 'conflict', reason: 'send_in_progress' };
  const result = await dispatch(deps, id, {
    invoiceAccessKey: request.invoiceAccessKey,
    supplierId: request.note.supplierId,
    requestType: request.requestType,
    to: request.to,
    ...text.rendered,
    attachments: [],
    dueOn: request.dueOn,
  });
  if (!result.ok) {
    // #35: a reivindicação venceu e outro a retomou durante o envio: a falha não é mais deste pedido de envio, e quem manda agora é o outro.
    if ((await deps.requests.recordFollowUpFailure(id, claim, result.reason, by)) === 'lost') return lostClaim(id, 'follow-up-failure');
    return { kind: 'send_failed', reason: result.reason };
  }
  const stamp: FollowUpStamp = { by, at: deps.clock.now(), channel: result.channel, providerMessageId: result.providerMessageId };
  // #34/AC-4: se esta gravação falhar, o e-mail já saiu e a reivindicação só vence depois de LEASE_MS: um envio posterior pode mandar um segundo e-mail, risco aceito e documentado em supabase/persistence-supplier-reply.md (#35).
  // #35: se a reivindicação foi perdida no meio, o carimbo é do outro envio: este e-mail saiu, mas não grava nem se declara enviado.
  if ((await deps.requests.recordFollowUpSent(id, claim, stamp)) === 'lost') return lostClaim(id, 'follow-up-stamp');
  return { kind: 'ok', request: { ...request, followUp: { ...request.followUp, sent: stamp, failure: null } } };
}

const rowOf = (r: ReplyRequest): ReplyListRow => ({
  id: r.id,
  invoiceAccessKey: r.invoiceAccessKey,
  invoiceNumber: r.invoiceNumber,
  supplierId: r.note.supplierId,
  supplierName: r.supplierName,
  requestType: r.requestType,
  totalValue: r.note.total,
  dueOn: r.dueOn,
  status: r.status,
  reading: r.reading,
  followUpDrafted: r.followUp.draft !== null,
  followUpSent: r.followUp.sent !== null,
});

async function listRequests(deps: ReplyDeps, filter: RequestFilter, today: string): Promise<ReplyList> {
  const counts: Record<RequestFilter, number> = { awaiting: 0, answered: 0, needs_you: 0, overdue: 0 };
  const rows: ReplyListRow[] = [];
  for (const request of await deps.requests.listSent()) {
    const placed = filterOf(request, request.reading, today);
    if (placed === null) continue;
    counts[placed] += 1;
    if (placed === filter) rows.push(rowOf(request));
  }
  return { filter, rows, counts: Object.freeze(counts) };
}

/** #34: os casos de uso ligados às portas. */
export const createReplyUseCases = (deps: ReplyDeps): ReplyUseCases => ({
  sweepOverdue: () => sweepOverdue(deps),
  sendFollowUp: (id, by) => sendFollowUp(deps, id, by),
  listRequests: (filter, today) => listRequests(deps, filter, today),
});
