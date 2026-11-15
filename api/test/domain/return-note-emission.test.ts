import { describe, expect, it } from 'vitest';
import {
  DomainError,
  Money,
  assertDraftMatchesQueue,
  buildReturnNoteDraft,
  emitReturnNote,
  planReturnNote,
  accessKeyCheckDigit,
} from '../../src/domain/index.js';
import { ORIGIN_KEY, decided, originInvoice, partialReturn } from './supplier-request-fixtures.js';

const draft = () => {
  const invoice = originInvoice();
  const plan = planReturnNote({ proposal: decided('E2', partialReturn()), invoice, goodsEntered: false });
  return buildReturnNoteDraft(invoice, plan!);
};
const CTX = { queueRowId: 7, sequence: 12, issuedOn: '2026-11-15', issuerCnpj: '12.345.678/0001-90', existing: null };

describe('rascunho da nota de devolução', () => {
  it('#156/AC-2 tem só a linha devolvida, no formato dos itens do kit', () => {
    const d = draft();
    expect(d.invoiceAccessKey).toBe(ORIGIN_KEY);
    expect(d.lines.map((l) => l.supplierCode)).toEqual(['F11-001']);
    expect(d.total.cents).toBe(216320);
    expect(d).not.toHaveProperty('itens');
    expect(d).not.toHaveProperty('valor_total');
    expect(emitReturnNote(d, CTX).itens).toEqual([
      {
        codigo_fornecedor: 'F11-001',
        sku: 'SKU-2001',
        descricao: 'Shampoo 350 ml',
        quantidade: 40,
        unidade: 'UN',
        preco_unitario: 54.08,
        valor: 2163.2,
      },
    ]);
    expect(emitReturnNote(d, CTX).valor_total).toBe(2163.2);
  });

  it('#156/AC-2 o valor_total bate com o valor da fila da #140, em centavos', () => {
    expect(() => assertDraftMatchesQueue(draft(), Money.ofCents(216320))).not.toThrow();
  });

  it('#156/AC-2 valor da fila diferente é erro do domínio', () => {
    expect(() => assertDraftMatchesQueue(draft(), Money.ofCents(216321))).toThrow(DomainError);
  });
});

describe('emissão emulada da nota de devolução', () => {
  it('#156/AC-4 gera nota_id, número, série própria, natureza e referência à nota de origem', () => {
    const note = emitReturnNote(draft(), CTX);
    expect(note.nota_id).toBe('ND-0012');
    expect(note.numero).toBe(12);
    expect(note.serie).toBe(900);
    expect(note.natureza).toBe('devolucao');
    expect(note.nota_referenciada).toBe(ORIGIN_KEY);
    expect(note.fornecedor_id).toBe('F11');
    expect(note.destino).toBe('CD-01');
    expect(note.data_emissao).toBe('2026-11-15');
    expect(note.emitente).toBe('12.345.678/0001-90');
    expect(note.valor_total).toBe(2163.2);
  });

  it('#156/AC-4 a chave tem 44 dígitos, com o DV módulo 11 certo e o CNPJ do emitente', () => {
    const { chave } = emitReturnNote(draft(), CTX);
    expect(chave).toMatch(/^\d{44}$/);
    expect(chave.slice(6, 20)).toBe('12345678000190');
    expect(chave.slice(20, 22)).toBe('55');
    expect(chave.slice(22, 25)).toBe('900');
    expect(chave.slice(25, 34)).toBe('000000012');
    expect(chave.slice(43)).toBe(String(accessKeyCheckDigit(chave.slice(0, 43))));
  });

  it.each([
    ['1234', 3, 'resto 8, DV 11 - 8'],
    ['51', 5, 'resto 6, DV 11 - 6'],
    ['14', 0, 'resto 0, DV 0'],
    ['23', 0, 'resto 1, DV 0'],
  ])('#156/AC-4 calcula o DV pelo módulo 11 da NF-e de %s (%#)', (digits, expected) => {
    expect(accessKeyCheckDigit(digits)).toBe(expected);
  });

  it('#156/AC-4 a mesma devolução, de novo, devolve a nota já emitida e não outra', () => {
    const first = emitReturnNote(draft(), CTX);
    const again = emitReturnNote(draft(), { ...CTX, sequence: 13, existing: first });
    expect(again).toBe(first);
  });

  it('#156/AC-4 linhas diferentes da fila geram chaves diferentes', () => {
    const a = emitReturnNote(draft(), CTX);
    const b = emitReturnNote(draft(), { ...CTX, queueRowId: 8, sequence: 13 });
    expect(a.chave).not.toBe(b.chave);
    expect(b.nota_id).toBe('ND-0013');
  });

  it('#156/AC-4 a mesma emissão é determinística', () => {
    expect(emitReturnNote(draft(), CTX)).toEqual(emitReturnNote(draft(), CTX));
  });

  it('#156/AC-4 CNPJ do emitente inválido é erro do domínio', () => {
    expect(() => emitReturnNote(draft(), { ...CTX, issuerCnpj: '123' })).toThrow(DomainError);
  });

  it('#156/AC-4 a nota emitida é imutável', () => {
    expect(Object.isFrozen(emitReturnNote(draft(), CTX))).toBe(true);
  });
});
