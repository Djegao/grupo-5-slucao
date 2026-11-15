import type { IssuedReturnNote } from '../domain/index.js';
import type { MailAttachment } from './ports.js';

// #11: a borda que leva a nota emitida do domínio (campos em inglês, #10) ao JSON do kit
// #11: (data/kit/notas.json, #2/AC-2), em português. O mapeamento é só nome de campo: os valores saem como a regra os deu.

export type KitReturnNoteItem = {
  readonly codigo_fornecedor: string;
  readonly sku: string | null;
  readonly descricao: string;
  readonly quantidade: number;
  readonly unidade: string;
  readonly preco_unitario: number;
  readonly valor: number;
};

export type KitReturnNote = {
  readonly nota_id: string;
  readonly chave: string;
  readonly numero: number;
  readonly serie: number;
  readonly emitente: { readonly nome: string; readonly destino: string };
  readonly fornecedor_id: string;
  readonly destino: string;
  readonly data_emissao: string;
  readonly nota_referenciada: string;
  readonly natureza: string;
  readonly itens: readonly KitReturnNoteItem[];
  readonly valor_total: number;
};

/** #11/AC-2 (#2): a nota emitida com os nomes de campo das notas do kit. */
export function toKitNote(note: IssuedReturnNote): KitReturnNote {
  return {
    nota_id: note.noteId,
    chave: note.accessKey,
    numero: note.number,
    serie: note.series,
    emitente: { nome: note.issuer.name, destino: note.issuer.destination },
    fornecedor_id: note.supplierId,
    destino: note.destination,
    data_emissao: note.issuedOn,
    nota_referenciada: note.referencedAccessKey,
    natureza: note.nature,
    itens: note.items.map((item) => ({
      codigo_fornecedor: item.supplierCode,
      sku: item.sku,
      descricao: item.description,
      quantidade: item.quantity,
      unidade: item.unit,
      preco_unitario: item.unitPrice,
      valor: item.value,
    })),
    valor_total: note.total,
  };
}

/** #11/AC-4 (#2): o anexo do e-mail, a nota em JSON. */
export const kitNoteAttachment = (note: IssuedReturnNote): MailAttachment => ({
  filename: `${note.noteId}.json`,
  contentType: 'application/json',
  content: JSON.stringify(toKitNote(note), null, 2),
});
