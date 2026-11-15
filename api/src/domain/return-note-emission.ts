import { DomainError } from './errors.js';
import type { InvoiceView } from './invoice.js';
import { Money } from './money.js';
import type { ReturnNotePlan, ReturnedLine } from './return-note-plan.js';

/* #156: a nota de devolução, do rascunho à emissão emulada. O formato é o das notas do kit
   (data/kit/notas.json): chaves em português como a fonte, valores em reais com duas casas. */

/** #156: a linha no formato dos itens do kit. */
export type KitItem = {
  readonly codigo_fornecedor: string; // ADR-001
  readonly sku: string | null;
  readonly descricao: string; // ADR-001
  readonly quantidade: number; // ADR-001
  readonly unidade: string; // ADR-001
  readonly preco_unitario: number; // ADR-001
  readonly valor: number; // ADR-001
};

const reais = (m: Money): number => m.cents / 100;

const kitItem = (l: ReturnedLine): KitItem =>
  Object.freeze({
    codigo_fornecedor: l.supplierCode, // ADR-001
    sku: l.sku,
    descricao: l.description, // ADR-001
    quantidade: l.quantity.amount, // ADR-001
    unidade: l.quantity.unit, // ADR-001
    preco_unitario: reais(l.unitPrice), // ADR-001
    valor: reais(l.value), // ADR-001
  });

/** #156/AC-2: o rascunho: só as linhas devolvidas, com o preço da nota de origem. */
export type ReturnNoteDraft = {
  readonly invoiceAccessKey: string;
  readonly invoiceNumber: string;
  readonly supplierId: string;
  /** #156: o CD ou a loja que devolve, o destino da nota de origem. */
  readonly destination: string;
  readonly lines: readonly ReturnedLine[];
  readonly total: Money;
};

export function buildReturnNoteDraft(invoice: InvoiceView, plan: ReturnNotePlan): ReturnNoteDraft {
  return Object.freeze({
    invoiceAccessKey: invoice.accessKey,
    invoiceNumber: invoice.number,
    supplierId: invoice.supplierId,
    destination: invoice.store,
    lines: plan.lines,
    total: plan.total,
  });
}

/** #156/AC-2: o valor_total do rascunho bate com o valor da devolução na fila da #140. */
export function assertDraftMatchesQueue(draft: ReturnNoteDraft, queueValue: Money): void {
  if (!draft.total.equals(queueValue)) {
    throw new DomainError(
      `ReturnNote: o total da nota (${draft.total.toString()}) difere do valor da fila de devoluções (${queueValue.toString()})`,
    );
  }
}

/** #156/AC-4: a nota de devolução emitida pelo mock, no formato das notas do kit. */
export type ReturnNote = {
  readonly nota_id: string; // ADR-001
  readonly chave: string; // ADR-001
  readonly numero: number; // ADR-001
  readonly serie: number; // ADR-001
  readonly emitente: string; // ADR-001
  readonly fornecedor_id: string; // ADR-001
  readonly destino: string; // ADR-001
  readonly data_emissao: string; // ADR-001
  readonly nota_referenciada: string; // ADR-001
  readonly natureza: 'devolucao'; // ADR-001
  readonly itens: readonly KitItem[]; // ADR-001
  readonly valor_total: number; // ADR-001
};

/** #156: a série própria da devolução, fora da faixa das notas do kit. */
export const RETURN_NOTE_SERIES = 900;

const UF_SAO_PAULO = '35';
const MODEL_NFE = '55';
const NORMAL_EMISSION = '1';

/** #156: dígito verificador módulo 11 da chave da NF-e: pesos 2 a 9 da direita para a esquerda. */
export function accessKeyCheckDigit(digits: string): number {
  if (!/^\d+$/.test(digits)) throw new DomainError('ReturnNote: a chave só tem algarismos');
  let sum = 0;
  let weight = 2;
  for (let i = digits.length - 1; i >= 0; i--) {
    sum += Number(digits[i]) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const rest = sum % 11;
  return rest < 2 ? 0 : 11 - rest;
}

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

function buildAccessKey(args: { issuedOn: string; cnpj: string; sequence: number; queueRowId: number }): string {
  const [year, month] = args.issuedOn.split('-');
  const body =
    UF_SAO_PAULO +
    (year ?? '').slice(2) +
    (month ?? '') +
    args.cnpj +
    MODEL_NFE +
    pad(RETURN_NOTE_SERIES, 3) +
    pad(args.sequence, 9) +
    NORMAL_EMISSION +
    pad(args.queueRowId % 100_000_000, 8);
  return body + String(accessKeyCheckDigit(body));
}

export type EmissionContext = {
  /** #156: o id da linha da fila da #140 (outbox_return_notes): a chave da idempotência. */
  readonly queueRowId: number;
  /** #156: o próximo número do mock; vira `numero` e o sufixo de `nota_id`. */
  readonly sequence: number;
  readonly issuedOn: string;
  /** #156: o CNPJ da Já Chegou, o destino que devolve. */
  readonly issuerCnpj: string;
  /** #156/AC-4: a nota já emitida para esta linha da fila, se houver: emitir de novo a devolve. */
  readonly existing: ReturnNote | null;
};

/**
 * #156/AC-4: emite a nota de devolução pelo mock, sem chamar serviço fiscal. A mesma linha da fila
 * dá sempre a mesma nota: se já há emissão, ela volta, sem outra. A chave tem 44 dígitos e é
 * determinística pela linha, pelo número e pela data.
 */
export function emitReturnNote(draft: ReturnNoteDraft, ctx: EmissionContext): ReturnNote {
  if (ctx.existing) return ctx.existing;
  if (!Number.isSafeInteger(ctx.sequence) || ctx.sequence < 1 || ctx.sequence > 999_999_999) {
    throw new DomainError(`ReturnNote: sequencial inválido ${ctx.sequence}`);
  }
  if (!Number.isSafeInteger(ctx.queueRowId) || ctx.queueRowId < 0) {
    throw new DomainError(`ReturnNote: linha da fila inválida ${ctx.queueRowId}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ctx.issuedOn)) {
    throw new DomainError(`ReturnNote: data de emissão inválida ${ctx.issuedOn}`);
  }
  const cnpj = ctx.issuerCnpj.replace(/\D/g, '');
  if (cnpj.length !== 14) {
    throw new DomainError('ReturnNote: o CNPJ do emitente deve ter 14 dígitos');
  }
  return Object.freeze({
    nota_id: `ND-${pad(ctx.sequence, 4)}`, // ADR-001
    chave: buildAccessKey({ issuedOn: ctx.issuedOn, cnpj, sequence: ctx.sequence, queueRowId: ctx.queueRowId }), // ADR-001
    numero: ctx.sequence, // ADR-001
    serie: RETURN_NOTE_SERIES, // ADR-001
    emitente: ctx.issuerCnpj, // ADR-001
    fornecedor_id: draft.supplierId, // ADR-001
    destino: draft.destination, // ADR-001
    data_emissao: ctx.issuedOn, // ADR-001
    nota_referenciada: draft.invoiceAccessKey, // ADR-001
    natureza: 'devolucao', // ADR-001
    itens: Object.freeze(draft.lines.map(kitItem)), // ADR-001
    valor_total: reais(draft.total), // ADR-001
  });
}
