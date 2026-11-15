import type { Ask } from '../claude/client.js';
import type { ClaudeTask } from '../claude/task.js';
import type { ReplyOutcome } from '../domain/index.js';
import { validateReading } from '../domain/index.js';
import { awaitsReading, catalogOf } from './reply-catalog.js';
import { buildReadingPrompt } from './reply-prompt.js';
import type { ReplyDeps } from './reply-ports.js';

// #34: a tarefa do Claude (#66, #171) que lê a resposta do fornecedor (#4/AC-1). Ela só grava a leitura
// #34: e o status da mensagem; não há porta para a proposta, o título nem o valor em risco (#4/AC-6).

/** #34: a entrada é só os ids; o texto do fornecedor não vai para a linha de claude_suggestions. */
export type ReadingInput = { readonly messageId: number; readonly requestId: number };

/** #34: o que a tarefa deixa registrado: nunca o texto do fornecedor nem o do modelo. */
export type ReadingOutput =
  | { readonly messageId: number; readonly status: 'read'; readonly replyOutcome: ReplyOutcome }
  | { readonly messageId: number; readonly status: 'error'; readonly reason: string }
  | { readonly messageId: number; readonly skipped: 'message_not_pending' | 'request_not_sent' };

export const SUPPLIER_READING_TASK = 'supplier-reply-reading';

/** #34/AC-1: a chave estável por mensagem da caixa de entrada. */
export const readingKey = (messageId: number): string => `inbox_supplier_message:${messageId}`;

export const supplierReplyReadingTask = (deps: ReplyDeps): ClaudeTask<ReadingInput, ReadingOutput> => ({
  name: SUPPLIER_READING_TASK,

  /** #34/AC-1: cada mensagem pendente de um pedido que espera leitura. */
  async pending() {
    const messages = await deps.inbox.listPending();
    const sent = new Map((await deps.requests.listSent()).filter(awaitsReading).map((r) => [r.id, r]));
    const requests = messages.flatMap((m) =>
      sent.has(m.requestId) ? [{ key: readingKey(m.id), input: { messageId: m.id, requestId: m.requestId } }] : [],
    );
    return { requests, dropped: 0 };
  },

  /** #34/AC-1: leitura recusada marca a mensagem com erro; erro do Claude sobe, e nada é gravado. */
  async run(input: ReadingInput, ask: Ask): Promise<ReadingOutput> {
    const { messageId } = input;
    const message = await deps.inbox.get(messageId);
    if (message === null) return { messageId, skipped: 'message_not_pending' };
    const request = await deps.requests.get(message.requestId);
    if (request === null || !awaitsReading(request)) return { messageId, skipped: 'request_not_sent' };
    const context = { asks: request.asks, replyText: message.text, catalog: catalogOf(request) };
    // #34/AC-1: um erro do Claude (401, 429, rede) sobe daqui, antes de qualquer escrita (fail-closed).
    const raw = await ask<unknown>(buildReadingPrompt(context));
    const checked = validateReading(raw, context);
    if (!checked.ok) {
      // #34/AC-1: o motivo é o fechado da regra e o campo; nada do que o modelo ou o fornecedor escreveu.
      const reason = `${checked.reason}: ${checked.field}`;
      await deps.inbox.markError(messageId, reason);
      return { messageId, status: 'error', reason };
    }
    await deps.requests.recordReading(request.id, checked.reading);
    await deps.inbox.markRead(messageId);
    return { messageId, status: 'read', replyOutcome: checked.reading.replyOutcome };
  },
});
