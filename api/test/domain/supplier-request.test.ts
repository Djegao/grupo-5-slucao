import { describe, expect, it } from 'vitest';
import {
  DomainError,
  InvalidTransitionError,
  SupplierRequest,
  buildFactCatalog,
  buildReturnNoteDraft,
  buildReturnRequestFacts,
  defaultDueOn,
  emitReturnNote,
  hasOpenRequest,
  isOpenStatus,
  planReturnNote,
  type FactCatalog,
  type SupplierRequestStatus,
} from '../../src/domain/index.js';
import { emptyContext } from './fixtures.js';
import { decided, originInvoice, partialReturn } from './supplier-request-fixtures.js';

const DRAFTED_AT_MONDAY = '2026-11-16T12:00:00.000Z';
const DRAFTED_AT = DRAFTED_AT_MONDAY;
const DUE_ON = '2026-11-19';
const META = { draftedAt: DRAFTED_AT, model: 'claude-opus-5-5', dueOn: DUE_ON };

const planFor = () =>
  planReturnNote({ proposal: decided('E2', partialReturn()), invoice: originInvoice(), goodsEntered: false })!;

const catalog = (): FactCatalog =>
  buildReturnRequestFacts(buildFactCatalog(originInvoice(), emptyContext()), buildReturnNoteDraft(originInvoice(), planFor()), DUE_ON);

const GOOD_BODY =
  'Olá. Na NF {{nota.numero}} veio {{devolucao.item[F11-001].descricao}} ({{devolucao.item[F11-001].quantidade}}, {{devolucao.valor_total}}) no lugar do item pedido. Pedimos a retirada até {{pedido.prazo}}.';

const writing = (): SupplierRequest =>
  SupplierRequest.open({
    invoiceAccessKey: originInvoice().accessKey,
    supplierId: 'F11',
    requestType: 'return_note',
    to: 'fiscal@higienetotal.test',
    subject: 'NF 20046 · devolução de mercadoria',
    asks: planFor().asks,
    channel: 'mock',
    id: 'sr-1',
    createdAt: DRAFTED_AT,
    createdBy: 'ana',
  });

const drafted = (): SupplierRequest => {
  const r = writing();
  r.acceptDraft({ body: GOOD_BODY }, catalog(), META);
  return r;
};

const note = () =>
  emitReturnNote(buildReturnNoteDraft(originInvoice(), planFor()), {
    queueRowId: 7,
    sequence: 12,
    issuedOn: '2026-11-16',
    issuerCnpj: '12.345.678/0001-90',
    existing: null,
  });

describe('pedido ao fornecedor: nascimento e rascunho', () => {
  it('#156/AC-1 nasce com identidade, quando e por quem foi aberto', () => {
    const snap = writing().snapshot();
    expect(snap.id).toBe('sr-1');
    expect(snap.createdAt).toBe(DRAFTED_AT);
    expect(snap.createdBy).toBe('ana');
  });

  it('#156/AC-1 nasce escrevendo, com o e-mail do cadastro, o assunto e os asks da regra', () => {
    const r = writing();
    expect(r.status).toBe('writing');
    expect(r.to).toBe('fiscal@higienetotal.test');
    expect(r.subject).toContain('NF 20046');
    expect(r.asks).toEqual(['Retirar o item trocado', 'Entregar o item pedido']);
    expect(r.body).toBeNull();
    expect(r.channel).toBe('mock');
    expect(r.isOpen).toBe(true);
  });

  it('#156/AC-1 o texto do Claude validado vira rascunho com modelo, data e prazo', () => {
    const r = writing();
    expect(r.acceptDraft({ body: GOOD_BODY }, catalog(), META)).toBe('draft');
    expect(r.status).toBe('draft');
    expect(r.body).toBe(GOOD_BODY);
    expect(r.model).toBe('claude-opus-5-5');
    expect(r.draftedAt).toBe(DRAFTED_AT);
    expect(r.dueOn).toBe(DUE_ON);
  });

  it('#156/AC-3 o rascunho não está enviado nem tem quem enviou', () => {
    const r = drafted();
    expect(r.sentBy).toBeNull();
    expect(r.sentAt).toBeNull();
    expect(r.providerMessageId).toBeNull();
  });

  it('#156/AC-6 número solto fora do catálogo descarta o rascunho e registra o motivo', () => {
    const r = writing();
    const result = r.acceptDraft({ body: 'Devolvemos 41 unidades da NF {{nota.numero}}.' }, catalog(), META);
    expect(result).toBe('discarded');
    expect(r.status).toBe('discarded');
    expect(r.discardReason).toBe('number_mismatch');
    expect(r.discardedBy).toBe('system');
    expect(r.isOpen).toBe(false);
  });

  it('#156/AC-6 marcador fora do catálogo descarta o rascunho', () => {
    const r = writing();
    expect(r.acceptDraft({ body: 'Valor {{devolucao.inventado}}.' }, catalog(), META)).toBe('discarded');
    expect(r.discardReason).toBe('number_mismatch');
  });

  it('#156/AC-6 resposta fora do formato descarta o rascunho', () => {
    const r = writing();
    expect(r.acceptDraft({ corpo: 1 }, catalog(), META)).toBe('discarded');
    expect(r.discardReason).toBe('invalid_shape');
    const e = writing();
    expect(e.acceptDraft({ body: '   ' }, catalog(), META)).toBe('discarded');
    expect(e.discardReason).toBe('invalid_shape');
  });

  it('#156/AC-6 só escrevendo aceita o texto do Claude', () => {
    expect(() => drafted().acceptDraft({ body: GOOD_BODY }, catalog(), META)).toThrow(InvalidTransitionError);
  });

  it('#156/AC-1 o corpo renderizado traz os valores do banco no lugar dos marcadores', () => {
    const text = drafted().renderedBody(catalog());
    expect(text).toContain('NF 20046');
    expect(text).toContain('Shampoo 350 ml');
    expect(text).toContain('40 UN');
    expect(text).toContain('R$ 2.163,20');
    expect(text).toContain('19/11/2026');
    expect(text).not.toContain('{{');
  });
});

describe('pedido ao fornecedor: edição do corpo', () => {
  it('#156/AC-7 muda só o texto; asks e itens seguem travados', () => {
    const r = drafted();
    r.editBody('Prezados, na NF {{nota.numero}} veio {{devolucao.item[F11-001].descricao}} trocado. Total {{devolucao.valor_total}}, quantidade {{devolucao.item[F11-001].quantidade}}, até {{pedido.prazo}}. Obrigado!', catalog(), 'ana', DRAFTED_AT);
    expect(r.body).toContain('Prezados');
    expect(r.asks).toEqual(['Retirar o item trocado', 'Entregar o item pedido']);
    expect(r.editedBy).toBe('ana');
  });

  it('#156/AC-7 número novo na edição é rejeitado e o corpo não muda', () => {
    const r = drafted();
    expect(() => r.editBody(GOOD_BODY + ' São 99 unidades.', catalog(), 'ana', DRAFTED_AT)).toThrow(DomainError);
    expect(r.body).toBe(GOOD_BODY);
  });

  it('#156/AC-7 marcador novo, mesmo do catálogo, é rejeitado', () => {
    const r = drafted();
    expect(() => r.editBody(GOOD_BODY + ' {{nota.total}}', catalog(), 'ana', DRAFTED_AT)).toThrow(DomainError);
  });

  it('#156/AC-7 tirar um marcador também é rejeitado: os números ficam travados', () => {
    const r = drafted();
    expect(() => r.editBody('Olá, na NF {{nota.numero}} devolvemos.', catalog(), 'ana', DRAFTED_AT)).toThrow(DomainError);
  });

  it('#156/AC-7 só em rascunho', () => {
    expect(() => writing().editBody('x', catalog(), 'ana', DRAFTED_AT)).toThrow(InvalidTransitionError);
  });
});

describe('pedido ao fornecedor: descarte, emissão e envio', () => {
  it('#156 a pessoa descarta o rascunho: por quem, quando e por quê', () => {
    const r = drafted();
    r.discard('ana', '2026-11-16T12:05:00.000Z', 'fornecedor errado');
    expect(r.status).toBe('discarded');
    expect(r.discardedBy).toBe('ana');
    expect(r.discardedAt).toBe('2026-11-16T12:05:00.000Z');
    expect(r.discardReason).toBe('fornecedor errado');
  });

  it('#156 descarta também o envio falhado: a nota segue emitida e anexa', () => {
    const r = drafted();
    r.attachReturnNote(note(), 'ana', DRAFTED_AT);
    r.markSendFailed('provedor fora do ar', 'ana', DRAFTED_AT);
    r.discard('ana', '2026-11-16T15:00:00.000Z', 'fornecedor trocado');
    expect(r.status).toBe('discarded');
    expect(r.discardedBy).toBe('ana');
    expect(r.discardedAt).toBe('2026-11-16T15:00:00.000Z');
    expect(r.discardReason).toBe('fornecedor trocado');
    expect(r.attachments).toHaveLength(1);
    expect(r.isOpen).toBe(false);
  });

  it('#156 descarta também enquanto escreve, mas não depois de enviado', () => {
    const w = writing();
    w.discard('ana', DRAFTED_AT, 'não vale');
    expect(w.status).toBe('discarded');
    const s = drafted();
    s.attachReturnNote(note(), 'ana', DRAFTED_AT);
    s.markSent('ana', DRAFTED_AT, 'msg-1');
    expect(() => s.discard('ana', DRAFTED_AT, 'x')).toThrow(InvalidTransitionError);
  });

  it('#156/AC-4 emitida a nota, anexa ao pedido; uma só vez', () => {
    const r = drafted();
    r.attachReturnNote(note(), 'ana', DRAFTED_AT);
    expect(r.attachments).toEqual([{ kind: 'return_note', returnNoteId: 'ND-0012', filename: 'nota-devolucao-ND-0012.json' }]);
    expect(() => r.attachReturnNote(note(), 'ana', DRAFTED_AT)).toThrow(DomainError);
  });

  it('#156/AC-5 o envio registra quem, quando e o id do provedor', () => {
    const r = drafted();
    r.attachReturnNote(note(), 'ana', DRAFTED_AT);
    r.markSent('ana', '2026-11-16T13:40:00.000Z', 'mock-123');
    expect(r.status).toBe('sent');
    expect(r.sentBy).toBe('ana');
    expect(r.sentAt).toBe('2026-11-16T13:40:00.000Z');
    expect(r.providerMessageId).toBe('mock-123');
    expect(r.isOpen).toBe(false);
  });

  it('#156/AC-3 pedido de devolução não é enviado sem a nota emitida', () => {
    expect(() => drafted().markSent('ana', DRAFTED_AT, 'm')).toThrow(DomainError);
  });

  it('#156 envio que falha guarda o motivo e a nota segue emitida; tentar de novo envia', () => {
    const r = drafted();
    r.attachReturnNote(note(), 'ana', DRAFTED_AT);
    r.markSendFailed('provedor fora do ar', 'ana', DRAFTED_AT);
    expect(r.status).toBe('send_failed');
    expect(r.sendFailure).toBe('provedor fora do ar');
    expect(r.attachments).toHaveLength(1);
    expect(r.isOpen).toBe(true);
    r.markSent('ana', '2026-11-16T14:00:00.000Z', 'mock-124');
    expect(r.status).toBe('sent');
  });

  it('#156 não envia nem falha o que está escrevendo ou descartado', () => {
    expect(() => writing().markSendFailed('x', 'ana', DRAFTED_AT)).toThrow(InvalidTransitionError);
    const d = drafted();
    d.discard('ana', DRAFTED_AT, 'x');
    expect(() => d.markSent('ana', DRAFTED_AT, 'm')).toThrow(InvalidTransitionError);
  });

  it('#156 o pedido vira dado e volta dele sem perder nada', () => {
    const r = drafted();
    r.attachReturnNote(note(), 'ana', DRAFTED_AT);
    const copy = SupplierRequest.restore(r.snapshot());
    expect(copy.snapshot()).toEqual(r.snapshot());
    expect(copy.status).toBe('draft');
  });
});

describe('carimbo de atualização', () => {
  const T1 = '2026-11-16T12:30:00.000Z';
  const T2 = '2026-11-16T13:00:00.000Z';
  const stamp = (r: SupplierRequest) => [r.snapshot().updatedBy, r.snapshot().updatedAt];

  it('#156 ao abrir, atualizado é quando e por quem foi aberto', () => {
    expect(stamp(writing())).toEqual(['ana', DRAFTED_AT]);
  });

  it('#156 aceitar o texto carimba o sistema no instante do rascunho', () => {
    expect(stamp(drafted())).toEqual(['system', DRAFTED_AT]);
  });

  it('#156 o descarte pela validação do texto carimba o sistema', () => {
    const r = writing();
    r.acceptDraft({ body: 'tem 40 soltos' }, catalog(), META);
    expect(stamp(r)).toEqual(['system', DRAFTED_AT]);
  });

  it('#156 editar, anexar, falhar, enviar e descartar carimbam quem e quando', () => {
    const r = drafted();
    r.editBody(GOOD_BODY, catalog(), 'bia', T1);
    expect(stamp(r)).toEqual(['bia', T1]);
    r.attachReturnNote(note(), 'caio', T2);
    expect(stamp(r)).toEqual(['caio', T2]);
    r.markSendFailed('fora do ar', 'dani', T1);
    expect(stamp(r)).toEqual(['dani', T1]);
    r.markSent('eva', T2, 'm-1');
    expect(stamp(r)).toEqual(['eva', T2]);
    const d = drafted();
    d.discard('fabi', T1, 'x');
    expect(stamp(d)).toEqual(['fabi', T1]);
  });
});

describe('pedido aberto por nota de origem', () => {
  it('#156/AC-8 aberto é escrevendo, rascunho ou envio falhado', () => {
    const open: readonly SupplierRequestStatus[] = ['writing', 'draft', 'send_failed'];
    const notOpen: readonly SupplierRequestStatus[] = ['sent', 'discarded'];
    expect(open.every((s) => isOpenStatus(s))).toBe(true);
    expect(notOpen.some((s) => isOpenStatus(s))).toBe(false);
  });

  it('#156/AC-8 nota de origem com pedido aberto do mesmo tipo não ganha outro', () => {
    const key = originInvoice().accessKey;
    const existing = [{ invoiceAccessKey: key, requestType: 'return_note' as const, status: 'draft' as const }];
    expect(hasOpenRequest(existing, key, 'return_note')).toBe(true);
    expect(hasOpenRequest(existing, 'OUTRA', 'return_note')).toBe(false);
  });

  it('#156/AC-8 enviado ou descartado não bloqueia: refazer vale depois de descartar', () => {
    const key = originInvoice().accessKey;
    const done = [
      { invoiceAccessKey: key, requestType: 'return_note' as const, status: 'sent' as const },
      { invoiceAccessKey: key, requestType: 'return_note' as const, status: 'discarded' as const },
    ];
    expect(hasOpenRequest(done, key, 'return_note')).toBe(false);
  });
});

describe('prazo de resposta', () => {
  it('#156 padrão: 3 dias úteis depois do rascunho, de segunda a quinta', () => {
    expect(defaultDueOn(DRAFTED_AT_MONDAY)).toBe('2026-11-19');
  });

  it.each([
    ['quarta a segunda, pulando o fim de semana', '2026-11-18T10:00:00.000Z', '2026-11-23'],
    ['sexta a quarta, pulando o fim de semana', '2026-11-20T10:00:00.000Z', '2026-11-25'],
    ['sábado a quarta, pulando o fim de semana', '2026-11-21T10:00:00.000Z', '2026-11-25'],
  ])('#156 pula sábado e domingo: %s', (_caso, draftedAt, expected) => {
    expect(defaultDueOn(draftedAt)).toBe(expected);
  });

  it('#156 data inválida é erro do domínio', () => {
    expect(() => defaultDueOn('ontem')).toThrow(DomainError);
  });
});

describe('catálogo de fatos da devolução', () => {
  it('#156/AC-6 traz as quantidades, os preços, os valores, o total e o prazo como estão no banco', () => {
    const { facts } = catalog();
    expect(facts['devolucao.item[F11-001].quantidade']?.value).toBe('40 UN');
    expect(facts['devolucao.item[F11-001].preco_unitario']?.value).toBe('R$ 54,08');
    expect(facts['devolucao.item[F11-001].valor']?.value).toBe('R$ 2.163,20');
    expect(facts['devolucao.item[F11-001].descricao']?.value).toBe('Shampoo 350 ml');
    expect(facts['devolucao.valor_total']?.value).toBe('R$ 2.163,20');
    expect(facts['pedido.prazo']?.value).toBe('19/11/2026');
    expect(facts['nota.numero']?.value).toBe('20046');
  });
});
