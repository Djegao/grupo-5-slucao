/**
 * #156 O pedido ao fornecedor: a nota de devolução e o e-mail que o agente prepara, a pessoa revisa, emite e envia.
 * O contrato abaixo é escrito à mão; o teste api/test/supplier-requests/http-contract.test.ts o fixa.
 *
 * Todas as rotas exigem o Access. Quem age (`by`) é o e-mail da identidade do Access, nunca o corpo; sem e-mail
 * nas ações, 403 `{ error: 'forbidden' }`. Um corpo JSON malformado vale corpo vazio.
 *
 *   GET  /api/pedidos-fornecedor?nota=<chave de 44 dígitos>
 *        200 { requests: SupplierRequestView[] }   do mais antigo ao mais novo; [] sem pedido
 *        400 { error: 'invalid_nota' }
 *   POST /api/pedidos-fornecedor/:id/editar          { text: string }   só em rascunho; só o texto muda (AC-7)
 *        200 { request: SupplierRequestView }
 *        404 { error: 'not_found' } · 409 { error: 'conflict', reason } · 422 { error: 'invalid', reason }
 *   POST /api/pedidos-fornecedor/:id/emitir-e-enviar   sem corpo   só em rascunho (AC-3, AC-4, AC-5)
 *        200 { status: 'sent' | 'send_failed', request: SupplierRequestView, note: KitReturnNote }
 *        404 · 409
 *   POST /api/pedidos-fornecedor/:id/reenviar         sem corpo   só em send_failed; não reemite a nota
 *        200 { status: 'sent' | 'send_failed', request: SupplierRequestView, note: KitReturnNote } · 404 · 409
 *   POST /api/pedidos-fornecedor/:id/descartar        { reason?: string }   escrevendo, rascunho ou send_failed
 *        200 { request: SupplierRequestView }   `reason` aparado e cortado em 500; sem ele, 'discarded_by_user'
 *        404 · 409
 *   POST /api/pedidos-fornecedor/:id/refazer          sem corpo   só de um pedido descartado (AC-8)
 *        200 { request: SupplierRequestView }   o pedido novo, `writing`
 *        404 · 409
 *
 * Erros comuns: 401 sem Access; 405 `{ error: 'method_not_allowed' }` com `Allow` no método errado; 404 `not_found`
 * no id fora de [A-Za-z0-9_-]{1,64}; 503 `{ error: 'supabase_not_configured' }`; 502 `{ error: 'supabase_unavailable',
 * correlationId }` quando o Supabase falha, 500 `{ error: 'internal_error', correlationId }` num erro inesperado. Nenhum
 * erro leva o texto da dependência: o detalhe vai ao log do Worker (operação, tabela, status e o correlationId).
 * Depois de uma ação que gravou, a resposta é sempre 200: se só a releitura do dossiê falhar, a visão vem do snapshot,
 * com `body`, `template` e `returnNote` nulos (a próxima leitura traz tudo).
 * 409 `reason`: wrong_state | open_request_exists | stale | no_longer_qualifies | no_supplier_email |
 * queue_mismatch | queue_not_pending. 422 `reason`: a mensagem do domínio, ou 'text_too_long'.
 *
 * SupplierRequestView (campos sempre presentes; o que não se aplica ainda vai como null):
 *   id, invoiceAccessKey, supplierId, requestType ('return_note'|...), to, subject, channel ('mock'|'resend'): string
 *   status: 'writing' | 'draft' | 'sent' | 'send_failed' | 'discarded'
 *   asks: string[]                      o que se pede ao fornecedor, fixo pela regra
 *   body: string | null                 o texto com os {{chave}} trocados pelos valores do banco; null enquanto escreve
 *   template: string | null             o texto cru, com os {{chave}}; é o que a edição envia; null enquanto escreve
 *   dueOn: string | null                'AAAA-MM-DD'; model, draftedAt: string | null
 *   createdAt, createdBy, updatedAt, updatedBy: string        ISO 8601 e e-mail ('system' quando é o sistema)
 *   editedAt, editedBy, sentAt, sentBy, providerMessageId: string | null
 *   sendFailure: string | null          um código curto ('send_error'), nunca o texto do provedor
 *   discardedAt, discardedBy, discardReason: string | null    ('system' + 'number_mismatch'|'invalid_shape'|...)
 *   attachments: { kind: 'return_note', returnNoteId: string, filename: string }[]
 *   returnNote: null
 *             | { state: 'draft', items: DraftItem[], totalCents: number }      a regra, antes de emitir
 *             | { state: 'emitted', note: KitReturnNote }                       a nota que o mock emitiu
 *   DraftItem: { supplierCode: string, sku: string | null, description: string,
 *                quantity: { amount: number, unit: string }, unitPriceCents: number, valueCents: number }
 *
 * Dinheiro: em centavos inteiros em tudo o que é nosso (`unitPriceCents`, `valueCents`, `totalCents`). A exceção é a
 * `KitReturnNote`, que segue o formato do kit (data/kit/notas.json): chaves em português e valores em REAIS.
 *   KitReturnNote: { nota_id, chave (44 dígitos), numero, serie, emitente, fornecedor_id, destino,
 *     data_emissao ('AAAA-MM-DD'), nota_referenciada (a chave da nota de origem), natureza: 'devolucao',
 *     itens: { codigo_fornecedor, sku, descricao, quantidade, unidade, preco_unitario, valor }[], valor_total }
 *     (numero e serie são number).
 */
import { SupabaseRestError, type SupabaseRest } from '../connectors/supabase-rest.js';
import type { Env } from '../env.js';
import {
  discardRequest,
  editBody,
  emitAndSend,
  readSupplierRequests,
  redo,
  retrySend,
  supabaseSupplierRequestDeps,
  supplierRequestOptionsFromEnv,
  viewSupplierRequest,
  type Clock,
  type Conflict,
  type IdGenerator,
  type NotFound,
  type SupplierRequestDeps,
  type SupplierRequestView,
} from '../supplier-requests/index.js';
import type { SupplierRequestSnapshot } from '../domain/index.js';
import type { Identity } from './access.js';

export interface SupplierRequestsDeps {
  /** #156 Monta o cliente do Supabase a partir do Env; nulo sem credenciais. Os testes injetam um fake. */
  supabase?: (env: Env) => SupabaseRest | null;
  clock?: Clock;
  ids?: IdGenerator;
}

const PATH = /^\/api\/pedidos-fornecedor(?:\/([^/]+)\/(editar|emitir-e-enviar|reenviar|descartar|refazer))?$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const ACCESS_KEY = /^\d{44}$/;
const MAX_REASON = 500;
const MAX_TEXT = 20_000;

type Action = 'editar' | 'emitir-e-enviar' | 'reenviar' | 'descartar' | 'refazer';

const fail = (status: number, error: string, extra: Record<string, unknown> = {}, headers?: HeadersInit) =>
  Response.json({ error, ...extra }, { status, headers });

async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** #156: o formato autorado da visão; nada do agregado sai que não esteja nomeado aqui. */
function toJson(view: SupplierRequestView) {
  const r = view.request;
  const returnNote =
    view.returnNote === null
      ? null
      : view.returnNote.state === 'emitted'
        ? { state: 'emitted' as const, note: view.returnNote.note }
        : {
            state: 'draft' as const,
            items: view.returnNote.draft.lines.map((l) => ({
              supplierCode: l.supplierCode,
              sku: l.sku,
              description: l.description,
              quantity: { amount: l.quantity.amount, unit: l.quantity.unit },
              unitPriceCents: l.unitPrice.cents,
              valueCents: l.value.cents,
            })),
            totalCents: view.returnNote.draft.total.cents,
          };
  return {
    id: r.id,
    invoiceAccessKey: r.invoiceAccessKey,
    supplierId: r.supplierId,
    requestType: r.requestType,
    status: r.status,
    to: r.to,
    subject: r.subject,
    asks: [...r.asks],
    body: view.renderedBody,
    template: view.template,
    dueOn: r.dueOn,
    channel: r.channel,
    model: r.model,
    draftedAt: r.draftedAt,
    createdAt: r.createdAt,
    createdBy: r.createdBy,
    updatedAt: r.updatedAt,
    updatedBy: r.updatedBy,
    editedAt: r.editedAt,
    editedBy: r.editedBy,
    sentAt: r.sentAt,
    sentBy: r.sentBy,
    providerMessageId: r.providerMessageId,
    sendFailure: r.sendFailure,
    discardedAt: r.discardedAt,
    discardedBy: r.discardedBy,
    discardReason: r.discardReason,
    attachments: r.attachments.map((a) => ({ kind: a.kind, returnNoteId: a.returnNoteId, filename: a.filename })),
    returnNote,
  };
}

type Outcome = { readonly kind: 'ok'; readonly request: SupplierRequestSnapshot } | NotFound | Conflict | { readonly kind: 'invalid'; readonly reason: string };

async function answer(deps: SupplierRequestDeps, outcome: Outcome): Promise<Response> {
  if (outcome.kind === 'not_found') return fail(404, 'not_found');
  if (outcome.kind === 'conflict') return fail(409, 'conflict', { reason: outcome.reason });
  if (outcome.kind === 'invalid') return fail(422, 'invalid', { reason: outcome.reason });
  return Response.json({ request: await viewAfterWrite(deps, outcome.request) });
}

/**
 * #156 A ação já gravou: se a releitura do dossiê para montar a visão falha, a resposta continua 200, com a visão só
 * do snapshot (`body` e `template` nulos, `returnNote` nulo). Um 502 aqui diria "não feito" de uma ação feita.
 */
async function viewAfterWrite(deps: SupplierRequestDeps, snapshot: SupplierRequestSnapshot) {
  try {
    return toJson(await viewSupplierRequest(deps, snapshot));
  } catch {
    console.error('pedidos-fornecedor: visão sem o dossiê depois da ação', { id: snapshot.id });
    const bare: SupplierRequestView = { request: snapshot, renderedBody: null, template: null, returnNote: null };
    return toJson(bare);
  }
}

async function deliveryAnswer(
  deps: SupplierRequestDeps,
  outcome: Awaited<ReturnType<typeof emitAndSend>>,
): Promise<Response> {
  if (outcome.kind !== 'ok') return answer(deps, outcome);
  return Response.json({
    status: outcome.status,
    request: await viewAfterWrite(deps, outcome.request),
    note: outcome.note,
  });
}

async function act(deps: SupplierRequestDeps, action: Action, id: string, by: string, request: Request): Promise<Response> {
  const body = await bodyOf(request);
  switch (action) {
    case 'editar': {
      const text = typeof body.text === 'string' ? body.text : '';
      if (text.length > MAX_TEXT) return fail(422, 'invalid', { reason: 'text_too_long' });
      return answer(deps, await editBody(deps, id, text, by));
    }
    case 'emitir-e-enviar':
      return deliveryAnswer(deps, await emitAndSend(deps, id, by));
    case 'reenviar':
      return deliveryAnswer(deps, await retrySend(deps, id, by));
    case 'descartar': {
      const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, MAX_REASON) : '';
      return answer(deps, await discardRequest(deps, id, by, reason === '' ? undefined : reason));
    }
    case 'refazer':
      return answer(deps, await redo(deps, id, by));
  }
}

/** #156 Devolve nulo quando o caminho não é desta API, para o roteador seguir. */
export async function supplierRequestRoutes(
  request: Request,
  identity: Identity,
  env: Env,
  routeDeps: SupplierRequestsDeps,
  fallbackSupabase: (env: Env) => SupabaseRest | null,
): Promise<Response | null> {
  const url = new URL(request.url);
  const match = PATH.exec(url.pathname);
  if (!match) return null;
  const [, rawId, rawAction] = match;
  const action = rawAction as Action | undefined;

  const wanted = action ? 'POST' : 'GET';
  if (request.method !== wanted) return fail(405, 'method_not_allowed', {}, { Allow: wanted });
  if (action && !ID.test(rawId ?? '')) return fail(404, 'not_found');

  let nota = '';
  if (!action) {
    nota = url.searchParams.get('nota') ?? '';
    if (!ACCESS_KEY.test(nota)) return fail(400, 'invalid_nota');
  }
  const by = identity.email;
  if (action && !by) return fail(403, 'forbidden');

  const rest = (routeDeps.supabase ?? fallbackSupabase)(env);
  if (!rest) return fail(503, 'supabase_not_configured');
  const deps = supabaseSupplierRequestDeps(rest, {
    ...supplierRequestOptionsFromEnv(env, (line) => console.log(line)),
    ...(routeDeps.clock ? { clock: routeDeps.clock } : {}),
    ...(routeDeps.ids ? { ids: routeDeps.ids } : {}),
  });

  try {
    if (!action) {
      const { requests } = await readSupplierRequests(deps, nota);
      return Response.json({ requests: requests.map(toJson) });
    }
    return await act(deps, action, rawId ?? '', by ?? '', request);
  } catch (error) {
    const correlationId = crypto.randomUUID();
    const operation = action ?? 'listar';
    if (error instanceof SupabaseRestError) {
      console.error('pedidos-fornecedor: falha do Supabase', { operation, table: error.table, status: error.status, correlationId });
      return fail(502, 'supabase_unavailable', { correlationId });
    }
    console.error('pedidos-fornecedor: falha inesperada', { operation, errorName: error instanceof Error ? error.name : 'Error', correlationId });
    return fail(500, 'internal_error', { correlationId });
  }
}
