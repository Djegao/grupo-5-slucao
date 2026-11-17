import type { SupabaseRest } from '../connectors/supabase-rest.js';
import { replyDeps } from '../supplier/supabase-reply-deps.js';
import { createReplyUseCases } from '../supplier/reply-use-cases.js';
import type { Clock } from '../supplier/reply-ports.js';

// #36/AC-2 (#4/AC-2): a varredura do prazo no Cron. É determinística (sem Claude): roda mesmo sem credencial, e o pedido
// #36/AC-2 enviado sem leitura depois do prazo vira no_reply com follow_up. A cobrança em si é rascunhada pela tarefa do Claude.

/** #36/AC-2: marca os atrasados do dia de hoje (em São Paulo, pelo caso de uso); devolve quantos marcou. */
export async function sweepSupplierOverdue(rest: SupabaseRest, clock: Clock = { now: () => new Date() }): Promise<{ readonly marked: number }> {
  const { marked } = await createReplyUseCases(replyDeps(rest, { clock })).sweepOverdue();
  return { marked: marked.length };
}
