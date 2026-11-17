// Registro das tarefas do Claude (#66, #171): uma linha por tarefa. O laço, a tabela e o Cron servem a todas.
import type { SupabaseRest } from '../../connectors/supabase-rest.js';
import type { ClaudeTask } from '../task.js';
import { descriptionMatch } from './description-match.js';
import { probableOrderTask } from './probable-order.js';
import { supplierRequestDraftTask } from '../../supplier/draft-task.js';
import { supplierDeps } from '../../supplier/supabase-deps.js';
import { supplierFollowUpDraftTask } from '../../supplier/follow-up-task.js';
import { supplierReplyReadingTask } from '../../supplier/reply-task.js';
import { replyDeps } from '../../supplier/supabase-reply-deps.js';

/** #36: o casamento de descrição e a ordem provável têm 1 pedido por rodada cada (eram 5, o teto antigo da rodada): ficam 5 vezes mais lentos para caber nas subrequests; a conta está em api/src/claude/cron.ts. */
export const DESCRIPTION_MATCH_LIMIT = 1;
export const PROBABLE_ORDER_LIMIT = 1;

/** #36: a leitura e a cobrança têm um pedido por rodada cada; a conta das subrequests está em api/src/claude/cron.ts. */
export const SUPPLIER_REPLY_LIMIT = 1;

export function tasksFor(rest: SupabaseRest): readonly ClaudeTask<unknown, unknown>[] {
  // #36/AC-3: estas tarefas nunca enviam: o envio da cobrança é só da rota, por uma pessoa; o `mailer` padrão aqui nem é chamado.
  const reply = replyDeps(rest);
  return [
    { ...descriptionMatch, limit: DESCRIPTION_MATCH_LIMIT }, // #66 casamento de descrição do item sem cadastro; #36 de 5 para 1 por rodada (mais lento, para caber nas subrequests)
    { ...probableOrderTask(rest), limit: PROBABLE_ORDER_LIMIT }, // #65 ordem provável da nota sem ordem (E5); #36 de 5 para 1 por rodada (mais lento, para caber nas subrequests)
    supplierRequestDraftTask(supplierDeps(rest)), // #12 rascunho do pedido ao fornecedor (#2/AC-1); não emite nem envia
    { ...supplierReplyReadingTask(reply), limit: SUPPLIER_REPLY_LIMIT }, // #36 leitura da resposta do fornecedor (#4/AC-1); grava só a leitura e o status da mensagem
    { ...supplierFollowUpDraftTask(reply), limit: SUPPLIER_REPLY_LIMIT }, // #36 rascunho da cobrança do pedido atrasado (#4/AC-2); nunca envia
  ] as readonly ClaudeTask<unknown, unknown>[];
}
