import type { Ask } from '../claude/client.js';
import type { ClaudeTask } from '../claude/task.js';
import { validateRequestText } from '../domain/index.js';
import { catalogOf } from './reply-catalog.js';
import { buildFollowUpPrompt } from './reply-prompt.js';
import type { ReplyDeps, ReplyRequest } from './reply-ports.js';

// #34: a tarefa do Claude (#66, #171) que prepara o rascunho da cobrança (#4/AC-2), pelo mesmo caminho do
// #34: rascunho de #2: catálogo do pedido, prompt com {{chave}} e validateRequestText. Ela nunca envia (#4/AC-3).

export type FollowUpInput = { readonly requestId: number };

export type FollowUpOutput =
  | { readonly requestId: number; readonly status: 'drafted' }
  | { readonly requestId: number; readonly status: 'rejected'; readonly reason: string }
  | { readonly requestId: number; readonly skipped: 'request_not_waiting' };

export const SUPPLIER_FOLLOW_UP_TASK = 'supplier-follow-up-draft';

/** #34/AC-3: a chave estável por pedido. */
export const followUpKey = (requestId: number): string => `follow_up:${requestId}`;

/**
 * #34/AC-3: espera cobrança o pedido `sent` em no_reply sem rascunho e sem recusa registrada: a recusa
 * fica registrada e não se repete a cada rodada. A tarefa volta normalmente com `rejected`, o runner a guarda
 * como ok e não a retenta.
 */
// #34: refazer a cobrança recusada não está nos critérios da #4 e nenhuma rota pede; fica para outra issue.
const awaitsFollowUp = (r: ReplyRequest): boolean =>
  r.status === 'sent' && r.reading?.replyOutcome === 'no_reply' && r.followUp.draft === null && r.followUp.rejection === null;

export const supplierFollowUpDraftTask = (deps: ReplyDeps): ClaudeTask<FollowUpInput, FollowUpOutput> => ({
  name: SUPPLIER_FOLLOW_UP_TASK,

  async pending() {
    const sent = await deps.requests.listSent();
    const requests = sent.filter(awaitsFollowUp).map((r) => ({ key: followUpKey(r.id), input: { requestId: r.id } }));
    return { requests, dropped: 0 };
  },

  /** #34/AC-3: texto recusado volta normalmente, sem rascunho e com o motivo; erro do Claude sobe, sem gravar. */
  async run(input: FollowUpInput, ask: Ask): Promise<FollowUpOutput> {
    const { requestId } = input;
    const request = await deps.requests.get(requestId);
    if (request === null || !awaitsFollowUp(request)) return { requestId, skipped: 'request_not_waiting' };
    const catalog = catalogOf(request);
    const raw = await ask<unknown>(buildFollowUpPrompt({ asks: request.asks, catalog }));
    const checked = validateRequestText(raw, catalog);
    if (!checked.ok) {
      const reason = `${checked.reason}: ${checked.field}`;
      await deps.requests.recordFollowUpRejection(requestId, reason);
      return { requestId, status: 'rejected', reason };
    }
    await deps.requests.saveFollowUpDraft(requestId, checked.text);
    return { requestId, status: 'drafted' };
  },
});
