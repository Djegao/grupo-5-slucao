import type { Classification } from './classification.js';
import type { DockAction } from './dock-action.js';
import { DomainError } from './errors.js';
import type { InvoiceItem, InvoiceView } from './invoice.js';
import { Money } from './money.js';
import type { ProposalState } from './proposal.js';
import type { Quantity } from './quantity.js';

// #156: a decisão que pede uma nota de devolução ao fornecedor. Quem monta as linhas, os valores e o
// que se pede é a regra, a partir da decisão aprovada; o Claude só escreve o e-mail.

/** #156: o que a proposta decidida entrega a esta regra. A `Proposal` já tem esta forma. */
export type DecidedProposal = {
  readonly classification: Classification;
  readonly state: ProposalState;
  readonly dockAction: DockAction;
};

export type ReturnNoteKind = 'E1' | 'E2' | 'E3' | 'recusa_apos_entrada'; // ADR-002

/** #156: uma linha devolvida, com o preço da nota de origem. */
export type ReturnedLine = {
  readonly supplierCode: string;
  readonly sku: string | null;
  readonly description: string;
  readonly quantity: Quantity;
  readonly unitPrice: Money;
  /** #156: quantidade vezes o preço unitário da nota de origem, em centavos. */
  readonly value: Money;
};

export type ReturnNotePlan = {
  readonly kind: ReturnNoteKind;
  readonly lines: readonly ReturnedLine[];
  /** #156: o que o fornecedor precisa fazer, fixo por decisão. Não vem do Claude. */
  readonly asks: readonly string[];
  readonly total: Money;
};

const ASKS: Readonly<Record<ReturnNoteKind, readonly string[]>> = Object.freeze({
  E3: Object.freeze(['Ciência da devolução', 'Abatimento no título']),
  E1: Object.freeze(['Entregar o que faltou ou aceitar a devolução']),
  E2: Object.freeze(['Retirar o item trocado', 'Entregar o item pedido']),
  recusa_apos_entrada: Object.freeze(['Retirar a mercadoria']), // ADR-002
});

const PARTIAL_KINDS: ReadonlySet<Classification> = new Set(['E1', 'E2', 'E3']);

function returnedLine(item: InvoiceItem, quantity: Quantity): ReturnedLine {
  if (quantity.unit !== item.quantity.unit) {
    throw new DomainError(
      `ReturnNote: a linha ${item.supplierCode} é devolvida em ${quantity.unit}, mas a nota de origem a traz em ${item.quantity.unit}`,
    );
  }
  return Object.freeze({
    supplierCode: item.supplierCode,
    sku: item.sku,
    description: item.description,
    quantity,
    unitPrice: item.unitPrice,
    value: item.unitPrice.times(quantity.amount),
  });
}

function build(kind: ReturnNoteKind, lines: readonly ReturnedLine[]): ReturnNotePlan {
  const codes = new Set(lines.map((l) => l.supplierCode));
  if (codes.size !== lines.length) {
    throw new DomainError('ReturnNote: a mesma linha da nota de origem aparece duas vezes na devolução');
  }
  const total = lines.reduce((acc, l) => acc.add(l.value), Money.zero());
  return Object.freeze({ kind, lines: Object.freeze([...lines]), asks: ASKS[kind], total });
}

/**
 * #156/AC-1: diz se a decisão qualifica para a nota de devolução e devolve as linhas e os asks.
 * Qualificam: receber parcial de E1, E2 ou E3, e recusar com mercadoria já entrada (menos E6, a
 * duplicidade). O resto, `null`: quem não devolve mercadoria não ganha nota de devolução.
 */
export function planReturnNote(input: {
  readonly proposal: DecidedProposal;
  readonly invoice: InvoiceView;
  /** #156: o WMS tem recebimento para a nota, isto é, a mercadoria já entrou. */
  readonly goodsEntered: boolean;
}): ReturnNotePlan | null {
  const { proposal, invoice, goodsEntered } = input;
  if (proposal.state !== 'aprovada' && proposal.state !== 'alterada') return null;
  const action = proposal.dockAction;

  if (action.kind === 'receber_parcial') {
    if (!PARTIAL_KINDS.has(proposal.classification)) return null;
    const lines = action.lines.map((partial) => {
      const item = invoice.items.find((i) => i.sku !== null && i.sku === partial.sku);
      if (!item) throw new DomainError(`ReturnNote: o SKU ${partial.sku} não está na nota de origem ${invoice.number}`);
      return returnedLine(item, partial.quantity);
    });
    return build(proposal.classification as 'E1' | 'E2' | 'E3', lines);
  }

  if (action.kind === 'recusar' && goodsEntered && proposal.classification !== 'E6') {
    return build(
      'recusa_apos_entrada', // ADR-002
      invoice.items.map((item) => returnedLine(item, item.quantity)),
    );
  }
  return null;
}
