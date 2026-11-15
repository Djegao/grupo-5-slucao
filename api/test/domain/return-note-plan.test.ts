import { describe, expect, it } from 'vitest';
import { DockAction, planReturnNote } from '../../src/domain/index.js';
import { decided, originInvoice, partialReturn } from './supplier-request-fixtures.js';

const plan = (
  proposal: ReturnType<typeof decided>,
  goodsEntered = false,
) => planReturnNote({ proposal, invoice: originInvoice(), goodsEntered });

describe('decisão que pede uma nota de devolução ao fornecedor', () => {
  it('#156/AC-1 E2 receber parcial devolve a linha decidida com o preço da nota de origem', () => {
    const p = plan(decided('E2', partialReturn()));
    expect(p?.kind).toBe('E2');
    expect(p?.lines).toHaveLength(1);
    expect(p?.lines[0]).toMatchObject({ supplierCode: 'F11-001', sku: 'SKU-2001', description: 'Shampoo 350 ml' });
    expect(p?.lines[0]?.quantity.amount).toBe(40);
    expect(p?.lines[0]?.unitPrice.cents).toBe(5408);
    expect(p?.lines[0]?.value.cents).toBe(216320);
    expect(p?.total.cents).toBe(216320);
  });

  it('#156/AC-1 E2 pede retirar o item trocado e entregar o item pedido', () => {
    expect(plan(decided('E2', partialReturn()))?.asks).toEqual([
      'Retirar o item trocado',
      'Entregar o item pedido',
    ]);
  });

  it('#156/AC-1 E1 pede entregar o que faltou ou aceitar a devolução', () => {
    const p = plan(decided('E1', partialReturn('SKU-2002', 10)));
    expect(p?.kind).toBe('E1');
    expect(p?.asks).toEqual(['Entregar o que faltou ou aceitar a devolução']);
    expect(p?.total.cents).toBe(2500);
  });

  it('#156/AC-1 E3 pede ciência da devolução e o abatimento no título', () => {
    const p = plan(decided('E3', partialReturn('SKU-2002', 5), 'alterada'));
    expect(p?.kind).toBe('E3');
    expect(p?.asks).toEqual(['Ciência da devolução', 'Abatimento no título']);
  });

  it('#156/AC-1 recusar com mercadoria já entrada devolve todas as linhas da nota de origem', () => {
    const p = plan(decided('E2', DockAction.refuse()), true);
    expect(p?.kind).toBe('recusa_apos_entrada');
    expect(p?.lines.map((l) => l.supplierCode)).toEqual(['F11-001', 'F11-002']);
    expect(p?.total.cents).toBe(241320);
    expect(p?.asks).toEqual(['Retirar a mercadoria']);
  });

  it.each([
    ['E4 aprovada', decided('E4', DockAction.receive()), false],
    ['E5 recusada sem entrada', decided('E5', DockAction.refuse()), false],
    ['E6 recusada, mesmo com entrada', decided('E6', DockAction.refuse()), true],
    ['E7 recusada', decided('E7', DockAction.refuse()), false],
    ['E8 aprovada', decided('E8', DockAction.receive()), false],
    ['E1 receber', decided('E1', DockAction.receive()), false],
    ['recusar sem recebimento', decided('E2', DockAction.refuse()), false],
    ['E4 receber parcial', decided('E4', partialReturn()), false],
  ])('#156/AC-1 %s não gera nota de devolução', (_name, proposal, entered) => {
    expect(plan(proposal, entered)).toBeNull();
  });

  it('#156/AC-1 proposta ainda não decidida não gera nota de devolução', () => {
    expect(plan(decided('E2', partialReturn(), 'registrada'))).toBeNull();
    expect(plan(decided('E2', partialReturn(), 'aguardando_aprovacao'))).toBeNull();
  });

  it('#156/AC-2 linha parcial que a nota de origem não tem é erro do domínio', () => {
    expect(() => plan(decided('E2', partialReturn('SKU-9999')))).toThrow('SKU-9999');
  });
});
