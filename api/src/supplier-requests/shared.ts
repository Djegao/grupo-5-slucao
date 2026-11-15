// #156: o que os casos de uso dividem: a regra da devolução, o catálogo e a gravação com concorrência.
import {
  DomainError,
  buildFactCatalog,
  buildReturnNoteDraft,
  buildReturnRequestFacts,
  planReturnNote,
  type FactCatalog,
  type ReturnNoteDraft,
  type ReturnNoteKind,
  type ReturnNotePlan,
  type SupplierRequest,
} from '../domain/index.js';
import type { DecidedCase, SupplierRequestDeps, ReturnNoteWorkQueue } from './ports.js';

export type PlannedCase = { readonly decided: DecidedCase; readonly plan: ReturnNotePlan; readonly draft: ReturnNoteDraft };

/** #156/AC-1: a regra aplicada ao caso (abrir, reescrever, refazer e emitir passam por aqui); `null` quando a decisão não devolve ou a nota de origem não fecha com ela. */
export function planCase(decided: DecidedCase): PlannedCase | null {
  try {
    const plan = planReturnNote({ proposal: decided.proposal, invoice: decided.invoice, goodsEntered: decided.goodsEntered });
    // #156: a recusa com mercadoria já entrada está fora desta entrega; só receber parcial de E1, E2 e E3 abre pedido.
    if (!plan || plan.kind === 'recusa_apos_entrada') return null;
    return { decided, plan, draft: buildReturnNoteDraft(decided.invoice, plan) };
  } catch (error) {
    if (error instanceof DomainError) return null;
    throw error;
  }
}

/** #156: o caso decidido da nota, já com a regra aplicada. */
export async function loadPlanned(deps: Pick<SupplierRequestDeps, 'source'>, invoiceAccessKey: string): Promise<PlannedCase | null> {
  const decided = await deps.source.find(invoiceAccessKey);
  return decided ? planCase(decided) : null;
}

/** #156/AC-6: o catálogo do dossiê mais os fatos da devolução e o prazo. */
export const catalogOf = (planned: PlannedCase, dueOn: string): FactCatalog =>
  buildReturnRequestFacts(buildFactCatalog(planned.decided.invoice, planned.decided.context), planned.draft, dueOn);

const SUBJECT_TAIL: Readonly<Record<ReturnNoteKind, string>> = {
  E1: 'devolução da diferença',
  E2: 'devolução do item trocado',
  E3: 'devolução da diferença',
  recusa_apos_entrada: 'devolução de mercadoria recusada', // ADR-002
};

/** #156: o assunto é da regra: o número da nota de origem e o que se devolve. */
export const subjectOf = (planned: PlannedCase): string =>
  `NF ${planned.decided.invoice.number} · ${SUBJECT_TAIL[planned.plan.kind]}`;

/** #156: grava o pedido que mudou; `false` quando outra pessoa mudou antes (o `updatedAt` lido não vale mais). */
export async function persist(
  deps: Pick<SupplierRequestDeps, 'requests'>,
  request: SupplierRequest,
  expectedUpdatedAt: string,
): Promise<boolean> {
  return (await deps.requests.save(request, expectedUpdatedAt)) === 'saved';
}

/** #156/AC-2: o que se pede à fila da #140 para a devolução do caso: as linhas e o motivo. */
export const queueRequestOf = (planned: PlannedCase): Parameters<ReturnNoteWorkQueue['ensureRow']>[0] => ({
  invoiceAccessKey: planned.decided.invoice.accessKey,
  lines: planned.plan.lines.map((l) => ({ supplierCode: l.supplierCode, quantity: l.quantity })),
  reason: `${planned.plan.kind} nota ${planned.decided.invoice.number}: devolução`,
});
