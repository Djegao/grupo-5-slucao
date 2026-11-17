import type { SupabaseRest } from '../connectors/supabase-rest.js';
import { replyDeps } from '../supplier/supabase-reply-deps.js';
import { createReplyUseCases } from '../supplier/reply-use-cases.js';
import type { Clock } from '../supplier/reply-ports.js';

// #36/AC-4 (#4/AC-2): a varredura do prazo no Cron. É determinística (sem Claude): roda mesmo sem credencial, e o pedido
// #36/AC-4 enviado sem leitura depois do prazo vira no_reply com follow_up. A cobrança em si é rascunhada pela tarefa do Claude.

/**
 * #36/AC-4: pedidos marcados por rodada. Cada pedido marcado custa 2 subrequests (a gravação da leitura e a releitura que
 * #36/AC-4: diz se outra a vence) e a varredura lê 2 vezes antes (os pedidos enviados e as notas deles): 2 + 2 × 1 = 4 (conta em api/src/claude/cron.ts).
 */
export const SUPPLIER_SWEEP_PER_ROUND = 1;

/** #36/AC-4: marca os atrasados do dia de hoje (em São Paulo, pelo caso de uso), até o teto da rodada; devolve quantos marcou. */
export async function sweepSupplierOverdue(rest: SupabaseRest, clock: Clock = { now: () => new Date() }): Promise<{ readonly marked: number }> {
  const { marked } = await createReplyUseCases(replyDeps(rest, { clock })).sweepOverdue(SUPPLIER_SWEEP_PER_ROUND);
  return { marked: marked.length };
}
