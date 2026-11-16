// #11: a tarefa do Claude (#66, #171) que prepara o rascunho do pedido ao fornecedor (#2/AC-1).
// #11: a tarefa não emite nem envia; o laço registra a linha em claude_suggestions e a pessoa decide.
import type { Ask } from '../claude/client.js';
import type { ClaudeTask } from '../claude/task.js';
import type { RequestStatus } from '../domain/index.js';
import { draftRequest } from './draft.js';
import type { SupplierDeps } from './ports.js';

/** #11: a entrada da tarefa é só o id da devolução da fila; a linha de claude_suggestions guarda isso e mais nada. */
export type SupplierDraftInput = { readonly queueId: number };

/** #11: o que a tarefa deixa registrado: o pedido criado e o estado dele, ou o motivo de não ter criado. */
export type SupplierDraftOutput =
  | { readonly requestId: number; readonly status: RequestStatus }
  | { readonly skipped: 'open_request_exists' | 'queue_not_pending' };

export const SUPPLIER_DRAFT_TASK = 'supplier-request-draft';

/** #11/AC-1: o nome da chave estável por devolução da fila. */
export const draftKey = (queueId: number): string => `return_note:${queueId}`;

export const supplierRequestDraftTask = (deps: SupplierDeps): ClaudeTask<SupplierDraftInput, SupplierDraftOutput> => ({
  name: SUPPLIER_DRAFT_TASK,

  /** #11/AC-1: cada devolução `pendente` da fila sem pedido `return_note` aberto na nota de origem. */
  async pending() {
    const entries = await deps.queue.list('pendente', deps.clock.now());
    const open = await Promise.all(entries.map((e) => deps.requests.findOpen(e.invoiceAccessKey, 'return_note')));
    const requests = entries.flatMap((e, i) => (open[i] === null ? [{ key: draftKey(e.id), input: { queueId: e.id } }] : []));
    return { requests, dropped: 0 };
  },

  /** #11/AC-2: texto recusado volta normalmente (pedido descartado); erro do Claude e dado quebrado lançam. */
  async run(input: SupplierDraftInput, ask: Ask): Promise<SupplierDraftOutput> {
    const result = await draftRequest(deps, input.queueId, ask);
    if (result.kind === 'ok') return { requestId: result.record.request.id, status: result.record.request.status };
    if (result.kind === 'conflict') return { skipped: result.reason };
    throw new Error(`supplier-request-draft: devolução ${input.queueId} não vira rascunho (${result.kind})`);
  },
});
