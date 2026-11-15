import type { Fact, FactCatalog } from './dossier.js';
import { DomainError } from './errors.js';
import type { ReturnNoteDraft } from './return-note-emission.js';

/* #156: os fatos da devolução, acrescentados ao catálogo do dossiê (domain/dossier.ts). O número da
   nota de origem já está lá, em `nota.numero`. No texto do e-mail um fato aparece só como {{chave}}.

     devolucao.item[<código>].quantidade | .preco_unitario | .valor | .descricao
     devolucao.valor_total
     pedido.prazo */

export const returnFactKey = {
  item: (supplierCode: string, field: 'quantidade' | 'preco_unitario' | 'valor' | 'descricao'): string =>
    `devolucao.item[${supplierCode}].${field}`,
  total: (): string => 'devolucao.valor_total',
  dueOn: (): string => 'pedido.prazo',
} as const;

/** #156: 'AAAA-MM-DD' → 'DD/MM/AAAA', como o prazo aparece no e-mail. */
export function formatDueOn(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) throw new DomainError(`SupplierRequest: prazo inválido ${isoDate}`);
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/** #156/AC-6: o catálogo do dossiê mais os fatos da nota de devolução e do prazo. Não muda o de entrada. */
export function buildReturnRequestFacts(base: FactCatalog, draft: ReturnNoteDraft, dueOn: string): FactCatalog {
  const facts: Record<string, Fact> = { ...base.facts };
  const put = (key: string, label: string, value: string) => {
    facts[key] = Object.freeze({ label, value, source: 'invoice' as const });
  };
  for (const line of draft.lines) {
    const q = `${line.quantity.amount} ${line.quantity.unit}`;
    put(returnFactKey.item(line.supplierCode, 'descricao'), 'Descrição do item devolvido', line.description);
    put(returnFactKey.item(line.supplierCode, 'quantidade'), `Quantidade devolvida de ${line.description}`, q);
    put(returnFactKey.item(line.supplierCode, 'preco_unitario'), `Preço unitário de ${line.description} na nota de origem`, line.unitPrice.toString());
    put(returnFactKey.item(line.supplierCode, 'valor'), `Valor devolvido de ${line.description}`, line.value.toString());
  }
  put(returnFactKey.total(), 'Valor total da devolução', draft.total.toString());
  put(returnFactKey.dueOn(), 'Prazo de resposta do fornecedor', formatDueOn(dueOn));
  return Object.freeze({ facts: Object.freeze(facts), identifiers: base.identifiers });
}
