import { describe, expect, it } from 'vitest';
import { buildSupplierRequestFacts, followUpDraftFor, validateRequestText, withFollowUpDueDate } from '../../src/domain/index.js';
import { returnNote, sourceInvoice } from './supplier-request-fixtures.js';

// #58: a cobrança montada pela regra, sem o Claude. Os nomes de `it` seguem o ADR-004.
const DUE = '2026-11-17';
const ASKS = ['Confirmar o recebimento da nota de devolução', 'Creditar {{devolucao.total}} até {{prazo}}', 'Enviar o comprovante da nota {{nota.numero}}'];
const catalog = () => buildSupplierRequestFacts(returnNote(), sourceInvoice(), DUE);

describe('#58/AC-2 a cobrança pede só o que o fornecedor ainda não atendeu', () => {
  it('sem nada atendido, pede todos os itens do pedido', () => {
    const { text } = followUpDraftFor({ asks: ASKS, fulfilledAsks: [] }, '2026-11-20');
    expect(text.asks).toEqual(ASKS);
  });

  it('tira dos itens os que o fornecedor já atendeu', () => {
    const { text } = followUpDraftFor({ asks: ASKS, fulfilledAsks: [ASKS[0] as string] }, '2026-11-20');
    expect(text.asks).toEqual([ASKS[1], ASKS[2]]);
    expect(text.body).not.toContain(ASKS[0]);
  });

  it('com tudo atendido, não fica sem itens: volta a pedir os itens do pedido', () => {
    const { text } = followUpDraftFor({ asks: ASKS, fulfilledAsks: [...ASKS] }, '2026-11-20');
    expect(text.asks).toEqual(ASKS);
  });

  it('cita a nota de origem, no assunto e no corpo, pelo marcador da nota', () => {
    const { text } = followUpDraftFor({ asks: ASKS, fulfilledAsks: [] }, '2026-11-20');
    expect(text.subject).toContain('{{nota.numero}}');
    expect(text.body).toContain('{{nota.numero}}');
  });
});

describe('#58/AC-2 o novo prazo são 3 dias úteis depois de hoje', () => {
  it('numa sexta, o prazo cai na quarta seguinte, pulando o fim de semana', () => {
    expect(followUpDraftFor({ asks: ASKS, fulfilledAsks: [] }, '2026-11-20').dueOn).toBe('2026-11-25');
  });

  it('numa segunda, o prazo cai na quinta', () => {
    expect(followUpDraftFor({ asks: ASKS, fulfilledAsks: [] }, '2026-11-23').dueOn).toBe('2026-11-26');
  });

  it('o novo prazo entra no catálogo como o fato cobranca.prazo, com a data no formato do e-mail', () => {
    const extended = withFollowUpDueDate(catalog(), '2026-11-25');
    expect(extended.facts['cobranca.prazo']?.value).toBe('25/11/2026');
    expect(extended.facts['prazo']?.value).toBe('17/11/2026');
  });
});

describe('#58/AC-3 todo número do texto vem do catálogo de fatos, como marcador', () => {
  it('o texto montado pela regra passa na mesma conferência do pedido (validateRequestText), com o catálogo do novo prazo', () => {
    const { text, dueOn } = followUpDraftFor({ asks: ASKS, fulfilledAsks: [] }, '2026-11-20');
    const checked = validateRequestText(text, withFollowUpDueDate(catalog(), dueOn));
    expect(checked.ok).toBe(true);
  });

  it('o novo prazo e a nota aparecem só como marcador: o texto cru não leva data nem número', () => {
    const { text } = followUpDraftFor({ asks: ASKS, fulfilledAsks: [] }, '2026-11-20');
    expect(text.body).toContain('{{cobranca.prazo}}');
    expect(text.body.replace(/\{\{[^}]*\}\}/g, '')).not.toMatch(/\d/);
    expect(text.subject.replace(/\{\{[^}]*\}\}/g, '')).not.toMatch(/\d/);
  });

  it('renderizado, o corpo traz a data do novo prazo e o número da nota de origem', () => {
    const { text, dueOn } = followUpDraftFor({ asks: ASKS, fulfilledAsks: [] }, '2026-11-20');
    const checked = validateRequestText(text, withFollowUpDueDate(catalog(), dueOn));
    if (!checked.ok) throw new Error('o texto da regra devia conferir');
    expect(checked.rendered.body).toContain('25/11/2026');
    expect(checked.rendered.body).toContain('43894');
  });

  it('sem o fato do novo prazo no catálogo, o marcador do novo prazo é recusado (number_mismatch)', () => {
    const { text } = followUpDraftFor({ asks: ASKS, fulfilledAsks: [] }, '2026-11-20');
    expect(validateRequestText(text, catalog())).toMatchObject({ ok: false, reason: 'number_mismatch' });
  });
});
