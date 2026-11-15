/**
 * #157 As rotas da resposta do fornecedor. Todas exigem o Access; quem age (`by`) é o e-mail da identidade.
 *
 *   GET  /api/pedidos-fornecedor/lista?filtro=aguardando|atendidos|precisam|atrasados
 *        200 { counts: { aguardando, atendidos, precisam, atrasados }, items: ListItem[] }   (AC-5)
 *        400 { error: 'invalid_filter' }
 *   GET  /api/pedidos-fornecedor/:id/conversa
 *        200 { conversation: { messages[], readings[], followUps[], confirmations[] } }
 *   POST /api/pedidos-fornecedor/:id/confirmar-documento   sem corpo   (AC-3: só a pessoa fecha o "atendeu")
 *        200 { conversation } · 404 · 409 { error: 'conflict', reason: 'wrong_state' | 'already_done' }
 *   POST /api/pedidos-fornecedor/:id/cobrar                sem corpo   (AC-2: a cobrança só sai com a pessoa)
 *        200 { conversation } · 404 · 409
 *
 * ListItem: id, invoiceAccessKey, invoiceNumber, supplierId, requestType, valueCents (centavos ou null), dueOn,
 * sentAt, bucket, latest (a última leitura ou null), documentConfirmed, followUpSent.
 * Erros comuns: 405 com Allow, 503 supabase_not_configured, 502 supabase_unavailable sem detalhe.
 */
import { SupabaseRestError, type SupabaseRest } from '../connectors/supabase-rest.js';
import type { Env } from '../env.js';
import type { ReplyBucket } from '../domain/index.js';
import {
  confirmDocument,
  conversationOf,
  overview,
  sendFollowUp,
  supabaseSupplierReplyDeps,
  type ActionResult,
} from '../supplier-replies/index.js';
import type { Identity } from './access.js';
import type { SupplierRequestsDeps } from './supplier-requests.js';

const LIST = '/api/pedidos-fornecedor/lista';
const ITEM = /^\/api\/pedidos-fornecedor\/([A-Za-z0-9_-]{1,64})\/(conversa|confirmar-documento|cobrar)$/;
const BUCKETS: readonly ReplyBucket[] = ['aguardando', 'atendidos', 'precisam', 'atrasados'];
const bucketFrom = (value: string | null): ReplyBucket | undefined => BUCKETS.find((b) => b === value);

const fail = (status: number, error: string, extra: Record<string, unknown> = {}, headers?: HeadersInit) =>
  Response.json({ error, ...extra }, { status, headers });

const answer = (result: ActionResult): Response => {
  if (result.kind === 'not_found') return fail(404, 'not_found');
  if (result.kind === 'conflict') return fail(409, 'conflict', { reason: result.reason });
  return Response.json({ conversation: result.conversation });
};

/** #157 Devolve nulo quando o caminho não é desta API, para o roteador seguir. */
export async function supplierReplyRoutes(
  request: Request,
  identity: Identity,
  env: Env,
  routeDeps: SupplierRequestsDeps,
  fallbackSupabase: (env: Env) => SupabaseRest | null,
): Promise<Response | null> {
  const url = new URL(request.url);
  const isList = url.pathname === LIST;
  const match = isList ? null : ITEM.exec(url.pathname);
  if (!isList && !match) return null;
  const action = match?.[2];
  const wanted = isList || action === 'conversa' ? 'GET' : 'POST';
  if (request.method !== wanted) return fail(405, 'method_not_allowed', {}, { Allow: wanted });

  const filter = url.searchParams.get('filtro');
  const bucket = bucketFrom(filter);
  if (isList && filter !== null && bucket === undefined) return fail(400, 'invalid_filter');
  const by = identity.email;
  if (wanted === 'POST' && !by) return fail(403, 'forbidden');

  const rest = (routeDeps.supabase ?? fallbackSupabase)(env);
  if (!rest) return fail(503, 'supabase_not_configured');
  const deps = supabaseSupplierReplyDeps(rest, {
    ...(routeDeps.clock ? { clock: routeDeps.clock } : {}),
    ...(routeDeps.ids ? { ids: routeDeps.ids } : {}),
  });

  try {
    if (isList) return Response.json(await overview(deps, bucket));
    const id = match?.[1] ?? '';
    if (action === 'conversa') {
      if (!(await deps.requests.findById(id))) return fail(404, 'not_found');
      return Response.json({ conversation: await conversationOf(deps, id) });
    }
    if (action === 'confirmar-documento') return answer(await confirmDocument(deps, id, by ?? ''));
    return answer(await sendFollowUp(deps, id, by ?? ''));
  } catch (error) {
    const correlationId = crypto.randomUUID();
    if (error instanceof SupabaseRestError) {
      console.error('respostas-fornecedor: falha do Supabase', { operation: action ?? 'lista', table: error.table, status: error.status, correlationId });
      return fail(502, 'supabase_unavailable', { correlationId });
    }
    console.error('respostas-fornecedor: falha inesperada', { operation: action ?? 'lista', correlationId });
    return fail(500, 'internal_error', { correlationId });
  }
}
