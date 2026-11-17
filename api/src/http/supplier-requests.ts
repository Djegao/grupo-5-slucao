// #13: o pedido ao fornecedor (#2) pela API: a nota de devolução e o e-mail que o agente prepara, a pessoa revisa, emite e envia.
// #13: o contrato abaixo é escrito à mão (contract-first); api/test/http/supplier-requests-contract.test.ts o fixa, uma operação por vez.
// #13:
// #13: as rotas são por chave de acesso (44 dígitos) da nota de origem, porque a tela chama assim e há no máximo um pedido
// #13: aberto por nota. "O pedido da nota" é o aberto, se houver; senão o mais recente.
// #13:
// #13:   GET   /api/supplier-requests/{accessKey}                  200 { request: SupplierRequestView | null }
// #13:           null quando a nota não tem pedido nem devolução pendente na fila; { status: 'writing' } quando a devolução
// #13:           está pendente e o Cron ainda não fez o rascunho
// #13:   PATCH /api/supplier-requests/{accessKey}  { template }    200 { request }   só o corpo de um rascunho (forma com {{chave}}), revalidado
// #13:           422 { error: 'invalid', reason: 'number_mismatch' | 'invalid_shape', field: 'subject' | 'body' | 'asks' }
// #13:   POST  /api/supplier-requests/{accessKey}/send     {}       200 { request }   só de rascunho: emite (mock), fila emitida, e-mail;
// #13:           o resultado é `sent` ou `send_failed` (falha do envio é um estado, continua 200)
// #13:   POST  /api/supplier-requests/{accessKey}/resend   {}       200 { request }   só de send_failed; nunca emite outra nota
// #13:   POST  /api/supplier-requests/{accessKey}/discard  { reason?: string }   200 { request }   só de rascunho; reason aparado, até 500
// #13:           caracteres, padrão 'discarded_by_user'
// #13:   POST  /api/supplier-requests/{accessKey}/redo     {}       200 { request }   só quando o mais recente está descartado e não há aberto;
// #13:           faz o rascunho de novo pelo Claude
// #13:   GET   /api/supplier-requests/{accessKey}/return-note.json  200 a nota emitida no formato do kit; 404 antes da emissão (é o `url` do anexo)
// #13:   GET   /api/supplier-requests?status=draft|sent|send_failed|discarded   200 { requests: SupplierRequestView[] }
// #13:           padrão draft; os 10 mais novos do estado; 400 { error: 'invalid_status' } fora dos quatro
// #13:
// #13: SupplierRequestView (alinhada a web/src/approval/SupplierRequestBlock.tsx):
// #13:   { status: 'writing' }
// #13:   | { status: 'draft' | 'sent' | 'send_failed', invoiceAccessKey, requestType: 'return_note',
// #13:       returnNote: { number: string | null (o ND-n emitido; null antes da emissão), supplier (o código do fornecedor),
// #13:                     reference (o número da nota de origem), lines: [{ description, quantity ("40 UN"), unitPrice: { text }, total: { text } }],
// #13:                     total: { text } },
// #13:       email: { to, dueOn ('AAAA-MM-DD'), subject (renderizado), body (renderizado), template (com {{chave}}; é o que o PATCH envia) },
// #13:       asks: string[] (renderizado), attachment?: { name, url } (depois da emissão),
// #13:       sent: sentBy, sentAt (string | null só se a linha não tem o carimbo); send_failed: failure (código curto, nunca texto do provedor) }
// #13:   | { status: 'discarded', discardedAt, discardedBy }      descartado por uma pessoa
// #13:   | { status: 'failed', failure: 'number_mismatch' | 'invalid_shape' }   nasceu descartado pelo agente: o texto do Claude foi recusado (#2/AC-7)
// #13:   O dinheiro sai em texto pt-BR ("R$ 2.163,20"), feito no servidor a partir dos centavos.
// #13:
// #13: erros (sempre { error, ... }; o texto da dependência nunca sai, só vai ao log do Worker, com operação, tabela, status e correlationId):
// #13:   400 invalid_access_key (não são 44 dígitos) | invalid_status | invalid_json (corpo de escrita que não é um objeto JSON)
// #13:   401 sem o Access, pelo roteador | 403 forbidden (a identidade não tem e-mail, nas escritas)
// #13:   404 not_found | 405 method_not_allowed, com Allow | 415 unsupported_media_type (escrita sem Content-Type JSON, como em admin.ts)
// #13:   409 conflict { reason }: not_sendable | not_draft | not_send_failed | queue_not_pending | queue_entry_missing | issuance_missing |
// #13:       send_in_progress | stale | open_request_exists
// #13:   422 invalid { reason, field? }: number_mismatch | invalid_shape | source_missing | text_invalid | note_not_buildable
// #13:   502 supabase_unavailable { correlationId } | claude_unavailable { correlationId } (falha do Claude que não é de credencial)
// #13:   503 supabase_not_configured | claude_unavailable (sem credencial do Claude, ou 401 e 429 dele; só no redo)
// #13:   500 internal_error { correlationId }
// #13: quem age (`by`) é o e-mail da identidade do Access, nunca o corpo.
import { ClaudeClient, ClaudeError, credentialsFromEnv, type Ask } from '../claude/client.js';
import { SupabaseRestError, type SupabaseRest } from '../connectors/supabase-rest.js';
import type { RequestStatus } from '../domain/index.js';
import type { Env } from '../env.js';
import { mailerFromEnv } from '../supplier/mock-mailer.js';
import { toKitNote } from '../supplier/kit-note.js';
import type { Clock, RequestRecord, SupplierDeps, SupplierMailer } from '../supplier/ports.js';
import { SupplierStoreError } from '../supplier/supabase-store.js';
import { supplierDeps } from '../supplier/supabase-deps.js';
import { createSupplierUseCases, type SupplierUseCases } from '../supplier/use-cases.js';
import type { Identity } from './access.js';
import { viewOf, type ViewResult, type WireRequest } from './supplier-request-view.js';

export interface SupplierRequestsDeps {
  /** #13: monta o cliente do Supabase a partir do Env; nulo sem credenciais. Os testes injetam um fake. */
  supabase?: (env: Env) => SupabaseRest | null;
  /** #13: o relógio; os testes fixam o dia do rascunho e do envio. */
  clock?: Clock;
  /** #13: o envio; padrão `mailerFromEnv(env)` (a caixa de saída mock sem chave do Resend). */
  mailer?: SupplierMailer;
  /** #13: a pergunta ao Claude do "refazer"; nulo sem credencial. Padrão: o cliente do Env. */
  ask?: (env: Env) => Ask | null;
}

const PATH = /^\/api\/supplier-requests(?:\/([^/]+)(?:\/(send|resend|discard|redo|return-note\.json))?)?$/;
const ACCESS_KEY = /^\d{44}$/;
const REQUEST_TYPE = 'return_note';
const MAX_REASON = 500;
const MAX_TEMPLATE = 20_000;
const DEFAULT_REASON = 'discarded_by_user';
/** #13: pedidos por lista; cada um custa leituras da nota de origem e da nota emitida, e o Worker limita as subrequests. */
const LIST_LIMIT = 10;
const STATUSES: readonly RequestStatus[] = ['draft', 'sent', 'send_failed', 'discarded']; // ADR-002

const ACTIONS = ['send', 'resend', 'discard', 'redo', 'return-note.json'] as const;
type Action = (typeof ACTIONS)[number];
const isAction = (value: string | undefined): value is Action => (ACTIONS as readonly (string | undefined)[]).includes(value);
const isStatus = (value: string): value is RequestStatus => (STATUSES as readonly string[]).includes(value);
type Body = Record<string, unknown>;

const fail = (status: number, error: string, extra: Record<string, unknown> = {}, headers?: HeadersInit): Response =>
  Response.json({ error, ...extra }, { status, headers });

const allowed = (key: string | undefined, action: Action | undefined): readonly string[] => {
  if (key === undefined) return ['GET'];
  if (action === undefined) return ['GET', 'PATCH'];
  return action === 'return-note.json' ? ['GET'] : ['POST'];
};

/** #13: o corpo de uma escrita; vazio vale {}, e o que não é um objeto JSON é nulo. */
async function bodyOf(request: Request): Promise<Body | null> {
  const text = await request.text();
  if (text.trim() === '') return {};
  try {
    const body: unknown = JSON.parse(text);
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Body) : null;
  } catch {
    return null;
  }
}

/** #13: tudo que uma operação precisa, montado uma vez por requisição. */
type Ctx = {
  readonly deps: SupplierDeps;
  readonly cases: SupplierUseCases;
  readonly env: Env;
  readonly routeDeps: SupplierRequestsDeps;
  readonly key: string;
  readonly by: string;
  readonly body: Body;
};

/** #13: o pedido da nota: o aberto, se houver; senão o mais recente. */
const currentOf = async (ctx: Ctx): Promise<RequestRecord | null> =>
  (await ctx.deps.requests.findOpen(ctx.key, REQUEST_TYPE)) ?? (await ctx.deps.requests.findLatest(ctx.key, REQUEST_TYPE));

async function show(ctx: Ctx, record: RequestRecord): Promise<ViewResult> {
  const source = record.request.status === 'discarded' ? null : await ctx.deps.source.find(record.request.invoiceAccessKey); // ADR-002
  return viewOf(record, source);
}

const shown = (result: ViewResult): Response =>
  result.ok ? Response.json({ request: result.view }) : fail(422, 'invalid', { reason: result.reason });

/** #13: depois de gravar, relê o pedido para a visão trazer o carimbo de quem fez e quando. */
async function shownAfter(ctx: Ctx, id: number): Promise<Response> {
  const record = await ctx.deps.requests.get(id);
  return record === null ? fail(404, 'not_found') : shown(await show(ctx, record));
}

const conflict = (reason: string): Response => fail(409, 'conflict', { reason });

type Outcome = { readonly kind: string; readonly reason?: string; readonly field?: string };

/** #13: o que os casos de uso devolvem além do `ok` vira o status e o motivo da API. */
function refusal(outcome: Outcome): Response {
  if (outcome.kind === 'not_found') return fail(404, 'not_found');
  if (outcome.kind === 'conflict') return conflict(outcome.reason ?? 'stale');
  return fail(422, 'invalid', { reason: outcome.reason ?? 'invalid_shape', ...(outcome.field === undefined ? {} : { field: outcome.field }) });
}

/** #13/AC-1 (#2): sem pedido, a devolução pendente na fila é o "escrevendo" (o Cron ainda não fez o rascunho). */
async function read(ctx: Ctx): Promise<Response> {
  const record = await currentOf(ctx);
  if (record !== null) return shown(await show(ctx, record));
  const pending = (await ctx.deps.queue.list('pendente', ctx.deps.clock.now())).some((e) => e.invoiceAccessKey === ctx.key); // ADR-002
  const writing: WireRequest | null = pending ? { status: 'writing' } : null;
  return Response.json({ request: writing });
}

async function list(ctx: Ctx, status: RequestStatus): Promise<Response> {
  const records = await ctx.deps.requests.listByStatus(status, LIST_LIMIT);
  const views: WireRequest[] = [];
  for (const record of records) {
    const result = await show(ctx, record);
    if (result.ok) views.push(result.view);
  }
  return Response.json({ requests: views });
}

async function edit(ctx: Ctx): Promise<Response> {
  const template = ctx.body.template;
  if (typeof template !== 'string' || template.trim() === '' || template.length > MAX_TEMPLATE) {
    return fail(422, 'invalid', { reason: 'invalid_shape', field: 'body' });
  }
  const record = await currentOf(ctx);
  if (record === null) return fail(404, 'not_found');
  const result = await ctx.cases.editBody(record.request.id, template, ctx.by);
  return result.kind === 'ok' ? shownAfter(ctx, record.request.id) : refusal(result);
}

/** #13: o envio exige o estado de partida da rota (rascunho no `send`, falha no `resend`), e só depois chama o caso de uso. */
async function send(ctx: Ctx, from: RequestStatus, reason: string): Promise<Response> {
  const record = await currentOf(ctx);
  if (record === null) return fail(404, 'not_found');
  if (record.request.status !== from) return conflict(reason);
  const result = await ctx.cases.send(record.request.id, ctx.by);
  return result.kind === 'ok' || result.kind === 'send_failed' ? shownAfter(ctx, record.request.id) : refusal(result); // ADR-002
}

async function discard(ctx: Ctx): Promise<Response> {
  const asked = ctx.body.reason;
  if (asked !== undefined && typeof asked !== 'string') return fail(422, 'invalid', { reason: 'invalid_shape', field: 'reason' });
  const reason = (asked ?? '').trim().slice(0, MAX_REASON);
  const record = await currentOf(ctx);
  if (record === null) return fail(404, 'not_found');
  const result = await ctx.cases.discard(record.request.id, ctx.by, reason === '' ? DEFAULT_REASON : reason);
  return result.kind === 'ok' ? shownAfter(ctx, record.request.id) : refusal(result);
}

/** #13: o `Ask` do "refazer": o injetado, ou o cliente do Claude do Env; sem credencial, nulo. */
function askFor(ctx: Ctx): Ask | null {
  if (ctx.routeDeps.ask !== undefined) return ctx.routeDeps.ask(ctx.env);
  const credentials = credentialsFromEnv(ctx.env);
  return credentials === undefined ? null : new ClaudeClient({ credentials }).ask;
}

async function redo(ctx: Ctx): Promise<Response> {
  const latest = await currentOf(ctx);
  if (latest === null) return fail(404, 'not_found');
  if (latest.request.isOpen) return conflict('open_request_exists');
  const ask = askFor(ctx);
  if (ask === null) return fail(503, 'claude_unavailable');
  const result = await ctx.cases.redraft(latest.request.id, ask);
  return result.kind === 'ok' ? shown(await show(ctx, result.record)) : refusal(result);
}

async function returnNoteJson(ctx: Ctx): Promise<Response> {
  const issued = (await currentOf(ctx))?.request.issuedNote ?? null;
  return issued === null ? fail(404, 'not_found') : Response.json(toKitNote(issued));
}

async function runAction(ctx: Ctx, action: Action | undefined, method: string): Promise<Response> {
  switch (action) {
    case undefined:
      return method === 'PATCH' ? edit(ctx) : read(ctx);
    case 'send':
      return send(ctx, 'draft', 'not_draft'); // ADR-002
    case 'resend':
      return send(ctx, 'send_failed', 'not_send_failed'); // ADR-002
    case 'discard':
      return discard(ctx);
    case 'redo':
      return redo(ctx);
    case 'return-note.json':
      return returnNoteJson(ctx);
  }
}

/** #13: a falha vira resposta genérica com o correlationId; o detalhe vai ao log só como campos nomeados. */
function failureResponse(error: unknown, operation: string): Response {
  const correlationId = crypto.randomUUID();
  if (error instanceof SupabaseRestError || error instanceof SupplierStoreError) {
    console.error('supplier-requests: falha do Supabase', { operation, table: error.table, status: error.status, correlationId });
    return fail(502, 'supabase_unavailable', { correlationId });
  }
  if (error instanceof ClaudeError) {
    console.error('supplier-requests: falha do Claude', { operation, kind: error.kind, status: error.status, correlationId });
    return error.isGlobal ? fail(503, 'claude_unavailable') : fail(502, 'claude_unavailable', { correlationId });
  }
  console.error('supplier-requests: falha inesperada', { operation, errorName: error instanceof Error ? error.name : 'Error', correlationId });
  return fail(500, 'internal_error', { correlationId });
}

const contextOf = (rest: SupabaseRest, env: Env, routeDeps: SupplierRequestsDeps, key: string, by: string, body: Body): Ctx => {
  const deps = supplierDeps(rest, { ...(routeDeps.clock ? { clock: routeDeps.clock } : {}), mailer: routeDeps.mailer ?? mailerFromEnv(env) });
  return { deps, cases: createSupplierUseCases(deps), env, routeDeps, key, by, body };
};

/** #13: a lista tem a sua rota, sem chave: valida o estado pedido e responde. */
async function listRoute(request: Request, rest: SupabaseRest, env: Env, routeDeps: SupplierRequestsDeps): Promise<Response> {
  const status = new URL(request.url).searchParams.get('status') ?? 'draft'; // ADR-002
  if (!isStatus(status)) return fail(400, 'invalid_status');
  try {
    return await list(contextOf(rest, env, routeDeps, '', '', {}), status);
  } catch (error) {
    return failureResponse(error, 'list');
  }
}

/** #13: devolve nulo quando o caminho não é desta API, para o roteador seguir. */
export async function supplierRequestRoutes(
  request: Request,
  identity: Identity,
  env: Env,
  routeDeps: SupplierRequestsDeps,
  fallbackSupabase: (env: Env) => SupabaseRest | null,
): Promise<Response | null> {
  const match = PATH.exec(new URL(request.url).pathname);
  if (!match) return null;
  const [, key, rawAction] = match;
  const action = isAction(rawAction) ? rawAction : undefined;

  const methods = allowed(key, action);
  if (!methods.includes(request.method)) return fail(405, 'method_not_allowed', {}, { Allow: methods.join(', ') });
  if (key !== undefined && !ACCESS_KEY.test(key)) return fail(400, 'invalid_access_key');

  const writing = request.method !== 'GET';
  if (writing && !identity.email) return fail(403, 'forbidden');
  // #13: muda estado e o Access também aceita o cookie: só JSON, que força o preflight de CORS que o Worker não responde (como em admin.ts).
  if (writing && !request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
    return fail(415, 'unsupported_media_type');
  }
  const body = writing ? await bodyOf(request) : {};
  if (body === null) return fail(400, 'invalid_json');

  const rest = (routeDeps.supabase ?? fallbackSupabase)(env);
  if (!rest) return fail(503, 'supabase_not_configured');
  if (key === undefined) return listRoute(request, rest, env, routeDeps);

  try {
    return await runAction(contextOf(rest, env, routeDeps, key, identity.email ?? '', body), action, request.method);
  } catch (error) {
    return failureResponse(error, action ?? request.method.toLowerCase());
  }
}
