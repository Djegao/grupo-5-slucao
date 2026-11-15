import { describe, expect, it } from 'vitest';
import { DomainError, buildReturnNote, issueReturnNote } from '../../src/domain/index.js';
import { SOURCE_KEY, queueEntry, returnNote, sourceInvoice } from './supplier-request-fixtures.js';

describe('a nota de devolução montada pela regra', () => {
  it('#10/AC-1 cita a chave da nota de origem e sai com natureza devolucao', () => {
    const note = returnNote();
    expect(note.nota_referenciada).toBe(SOURCE_KEY);
    expect(note.natureza).toBe('devolucao');
  });

  it('#10/AC-1 leva o fornecedor e o destino da nota de origem', () => {
    const note = returnNote();
    expect(note.fornecedor_id).toBe('F02');
    expect(note.destino).toBe('LJ-012');
  });

  it('#10/AC-1 tem só as linhas devolvidas, com os dados da nota de origem', () => {
    expect(returnNote().itens).toEqual([
      {
        codigo_fornecedor: 'F02-002',
        sku: 'SKU-1006',
        descricao: 'Refrigerante cola 2 L',
        quantidade: 7,
        unidade: 'UN',
        preco_unitario: 8.49,
        valor: 59.43,
      },
      {
        codigo_fornecedor: 'F02-005',
        sku: null,
        descricao: 'Arroz 5 kg',
        quantidade: 5,
        unidade: 'CX',
        preco_unitario: 100,
        valor: 500,
      },
    ]);
  });

  it('#10/AC-1 o valor_total é a soma exata dos itens, igual ao valor da devolução da fila', () => {
    const note = returnNote();
    expect(note.valor_total).toBe(559.43);
    // a fila valora por quantidade x preço unitário, arredondado em centavos (api/src/returns/return-notes.ts)
    const queueCents = Math.round(849 * 7) + Math.round(10000 * 5);
    expect(Math.round(note.valor_total * 100)).toBe(queueCents);
  });

  it('#10/AC-1 uma quantidade fracionada fecha com o valor que a fila calcula', () => {
    const note = buildReturnNote(queueEntry({ lines: [{ supplierCode: 'F02-005', amount: 7 / 6, unit: 'CX' }] }), sourceInvoice());
    expect(Math.round(note.valor_total * 100)).toBe(Math.round(10000 * (7 / 6)));
  });

  it('#10/AC-1 recusa linha que a nota de origem não tem', () => {
    const entry = queueEntry({ lines: [{ supplierCode: 'F99-001', amount: 1, unit: 'UN' }] });
    expect(() => buildReturnNote(entry, sourceInvoice())).toThrow(DomainError);
  });

  it('#10/AC-1 recusa devolução sem linhas, de outra nota ou em unidade diferente da nota', () => {
    expect(() => buildReturnNote(queueEntry({ lines: [] }), sourceInvoice())).toThrow(DomainError);
    expect(() => buildReturnNote(queueEntry({ invoiceAccessKey: '1'.repeat(44) }), sourceInvoice())).toThrow(DomainError);
    const wrongUnit = queueEntry({ lines: [{ supplierCode: 'F02-005', amount: 1, unit: 'UN' }] });
    expect(() => buildReturnNote(wrongUnit, sourceInvoice())).toThrow(DomainError);
  });
});

describe('a emissão mock da nota de devolução', () => {
  const issue = (sequence: number, issuedOn = '2026-11-12') => issueReturnNote(returnNote(), { sequence, issuedOn });

  it('#10/AC-2 dá o nota_id ND-n, o número e a série próprios, a natureza e a data', () => {
    const issued = issue(7);
    expect(issued.nota_id).toBe('ND-7');
    expect(issued.numero).toBe(7);
    expect(issued.serie).toBe(9);
    expect(issued.natureza).toBe('devolucao');
    expect(issued.data_emissao).toBe('2026-11-12');
  });

  it('#10/AC-2 a chave tem 44 algarismos e só algarismos', () => {
    expect(issue(7).chave).toMatch(/^\d{44}$/);
  });

  it('#10/AC-2 sequências diferentes dão chaves diferentes e a mesma sequência dá a mesma chave', () => {
    const keys = new Set([1, 2, 3, 10, 999].map((n) => issue(n).chave));
    expect(keys.size).toBe(5);
    expect(issue(3).chave).toBe(issue(3).chave);
  });

  it('#10/AC-2 mantém a nota montada: itens, total e a chave de origem', () => {
    const issued = issue(1);
    expect(issued.itens).toEqual(returnNote().itens);
    expect(issued.valor_total).toBe(559.43);
    expect(issued.nota_referenciada).toBe(SOURCE_KEY);
  });

  it('#10/AC-2 o emitente é a Já Chegou e o destino que devolve, sem CNPJ inventado', () => {
    const { emitente } = issue(1);
    expect(emitente).toEqual({ nome: 'Já Chegou', destino: 'LJ-012' });
  });

  it('#10/AC-2 recusa sequência que não é inteiro positivo ou não cabe na chave', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, 1_000_000_000]) {
      expect(() => issue(bad)).toThrow(DomainError);
    }
  });

  it('#10/AC-2 recusa data de emissão que não é AAAA-MM-DD', () => {
    expect(() => issue(1, '12/11/2026')).toThrow(DomainError);
  });
});
