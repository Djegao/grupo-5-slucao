import { describe, expect, it } from 'vitest';
import { createReplyUseCases } from '../../src/supplier/reply-use-cases.js';
import {
  GOOD_FOLLOW_UP,
  NOW,
  PROVIDER_TEXT,
  TODAY,
  fakeMailer,
  noReply,
  parts,
  reading,
  replyRequest,
} from './reply-doubles.js';

// #34: os casos de uso da leitura da resposta (#4): varredura do prazo, envio da cobrança e lista. Nomes de `it` no ADR-004.

describe('#34/AC-3 (#4/AC-2): a varredura do prazo vira no_reply o pedido enviado sem leitura', () => {
  it('marca no_reply com follow_up o pedido sent sem leitura depois do prazo', async () => {
    const { deps, store } = parts([replyRequest(7)]);
    const out = await createReplyUseCases(deps).sweepOverdue();
    expect(out).toEqual({ marked: [7] });
    expect(store.rows.get(7)?.reading).toMatchObject({ replyOutcome: 'no_reply', nextStep: 'follow_up' });
  });

  it('no dia do prazo ainda está no prazo, e pedido que não foi enviado fica como está', async () => {
    const { deps, store } = parts([replyRequest(7, { dueOn: TODAY }), replyRequest(8, { status: 'draft' })]);
    expect(await createReplyUseCases(deps).sweepOverdue()).toEqual({ marked: [] });
    expect(store.calls).toEqual([]);
  });

  it('é idempotente: rodar de novo não grava outra vez, e o pedido já lido fica intacto', async () => {
    const read = reading({ replyOutcome: 'refused', nextStep: 'answer_supplier' });
    const { deps, store } = parts([replyRequest(7), replyRequest(8, { reading: read })]);
    const useCases = createReplyUseCases(deps);
    await useCases.sweepOverdue();
    expect(await useCases.sweepOverdue()).toEqual({ marked: [] });
    expect(store.calls.map((c) => c.op)).toEqual(['recordReading']);
    expect(store.rows.get(8)?.reading).toEqual(read);
  });

  it('não depende do Claude nem envia nada', async () => {
    const { deps, mailer } = parts([replyRequest(7)]);
    await createReplyUseCases(deps).sweepOverdue();
    expect(mailer.sent).toEqual([]);
  });
});

const drafted = () =>
  replyRequest(7, { reading: noReply(), followUp: { draft: GOOD_FOLLOW_UP, rejection: null, sent: null, failure: null } });

describe('#34/AC-4 (#4/AC-3): a cobrança sai só pelo caso de uso de envio, chamado por uma pessoa', () => {
  it('envia o rascunho renderizado pela porta e grava quem enviou e quando (ADR-005)', async () => {
    const { deps, store, mailer } = parts([drafted()]);
    const out = await createReplyUseCases(deps).sendFollowUp(7, 'ana@jachegou.example');
    expect(out).toMatchObject({ kind: 'ok' });
    expect(mailer.sent).toHaveLength(1);
    const [mail] = mailer.sent;
    expect(mail).toMatchObject({ to: 'compras@bebidas-rio-claro.example', requestType: 'return_note', supplierId: 'F02', attachments: [] });
    expect(mail?.subject).toContain('43894');
    expect(mail?.body).not.toContain('{{');
    expect(store.rows.get(7)?.followUp.sent).toEqual({ by: 'ana@jachegou.example', at: NOW, channel: 'mock', providerMessageId: 'mock-1' });
  });

  it('não envia a cobrança que já saiu', async () => {
    const stamp = { by: 'ana', at: NOW, channel: 'mock', providerMessageId: 'm' } as const;
    const { deps, mailer } = parts([replyRequest(7, { ...drafted(), followUp: { ...drafted().followUp, sent: stamp } })]);
    expect(await createReplyUseCases(deps).sendFollowUp(7, 'bia')).toEqual({ kind: 'conflict', reason: 'already_sent' });
    expect(mailer.sent).toEqual([]);
  });

  it('devolve resultado tipado para pedido inexistente, fora de no_reply e sem rascunho', async () => {
    const { deps, mailer } = parts([
      replyRequest(8),
      replyRequest(9, { reading: noReply() }),
      replyRequest(10, { reading: reading({ replyOutcome: 'refused', nextStep: 'answer_supplier' }) }),
    ]);
    const useCases = createReplyUseCases(deps);
    expect(await useCases.sendFollowUp(1, 'ana')).toEqual({ kind: 'not_found' });
    expect(await useCases.sendFollowUp(8, 'ana')).toEqual({ kind: 'conflict', reason: 'not_no_reply' });
    expect(await useCases.sendFollowUp(10, 'ana')).toEqual({ kind: 'conflict', reason: 'not_no_reply' });
    expect(await useCases.sendFollowUp(9, 'ana')).toEqual({ kind: 'conflict', reason: 'no_draft' });
    expect(mailer.sent).toEqual([]);
  });

  it('revalida o rascunho contra o catálogo: texto com número fora dele não sai', async () => {
    const bad = { ...GOOD_FOLLOW_UP, body: 'Faltam 9999 caixas, total {{devolucao.total}}.' };
    const { deps, mailer } = parts([replyRequest(7, { ...drafted(), followUp: { draft: bad, rejection: null, sent: null, failure: null } })]);
    expect(await createReplyUseCases(deps).sendFollowUp(7, 'ana')).toEqual({ kind: 'invalid', reason: 'text_invalid' });
    expect(mailer.sent).toEqual([]);
  });

  it('falha do envio grava um motivo curto da própria porta, nunca o texto do provedor', async () => {
    const { deps, store } = parts([drafted()], [], fakeMailer({ ok: false, reason: PROVIDER_TEXT }));
    const out = await createReplyUseCases(deps).sendFollowUp(7, 'ana');
    expect(out).toEqual({ kind: 'send_failed', reason: 'send_failed' });
    expect(store.rows.get(7)?.followUp).toMatchObject({ sent: null, failure: 'send_failed' });
    expect(JSON.stringify([out, store.calls])).not.toContain('smtp');
  });

  it('porta que lança vira falha com motivo próprio, sem o texto do erro', async () => {
    const { deps, store } = parts([drafted()], [], fakeMailer(new Error(PROVIDER_TEXT)));
    const out = await createReplyUseCases(deps).sendFollowUp(7, 'ana');
    expect(out).toEqual({ kind: 'send_failed', reason: 'mailer_error' });
    expect(JSON.stringify([out, store.calls])).not.toContain('sk-segredo');
  });

  it('o motivo curto da porta passa como está; a falha não impede o reenvio', async () => {
    const failing = parts([drafted()], [], fakeMailer({ ok: false, reason: 'mailbox_full' }));
    expect(await createReplyUseCases(failing.deps).sendFollowUp(7, 'ana')).toEqual({ kind: 'send_failed', reason: 'mailbox_full' });
    const retry = createReplyUseCases({ ...failing.deps, mailer: fakeMailer() });
    expect(await retry.sendFollowUp(7, 'ana')).toMatchObject({ kind: 'ok' });
    expect(failing.store.rows.get(7)?.followUp).toMatchObject({ failure: null });
  });
});

const rows = () => [
  replyRequest(1), // aguardando: dentro do prazo
  replyRequest(2, { reading: reading({ summary: 'Atendeu.' }) }), // atendido
  replyRequest(3, { reading: reading({ replyOutcome: 'needs_information', nextStep: 'answer_supplier' }) }),
  replyRequest(4, { reading: noReply() }),
  replyRequest(5, { dueOn: '2026-11-10' }), // enviado sem leitura depois do prazo: atrasado
  replyRequest(6, { status: 'draft' }), // não enviado: em nenhum filtro
  replyRequest(7, { reading: reading({ replyOutcome: 'fulfilled', supplierDocument: '881', nextStep: 'confirm_document' }) }),
];
const WITHIN = '2026-11-10';

describe('#34/AC-5: a lista devolve os pedidos de um filtro com a leitura e as contagens de todos', () => {
  it('devolve as contagens de cada filtro e as linhas só do filtro pedido', async () => {
    const { deps } = parts(rows());
    const useCases = createReplyUseCases(deps);
    const answered = await useCases.listRequests('answered', WITHIN);
    expect(answered.counts).toEqual({ awaiting: 2, answered: 1, needs_you: 2, overdue: 1 });
    expect(answered.rows.map((r) => r.id)).toEqual([2]);
    const needs = await useCases.listRequests('needs_you', WITHIN);
    expect(needs.rows.map((r) => r.id)).toEqual([3, 7]);
    expect(needs.counts).toEqual(answered.counts);
  });

  it('o prazo entra pela data de hoje que a chamada traz', async () => {
    const { deps } = parts([replyRequest(5, { dueOn: '2026-11-10' })]);
    const useCases = createReplyUseCases(deps);
    expect((await useCases.listRequests('awaiting', '2026-11-10')).rows.map((r) => r.id)).toEqual([5]);
    expect((await useCases.listRequests('overdue', '2026-11-11')).rows.map((r) => r.id)).toEqual([5]);
  });

  it('cada linha traz o que a lista precisa: pedido, fornecedor, valor, prazo, leitura e a cobrança', async () => {
    const withReading = reading({ replyOutcome: 'refused', nextStep: 'answer_supplier', injectionFlag: null });
    const { deps } = parts([replyRequest(3, { reading: withReading }), drafted()]);
    const [refused] = (await createReplyUseCases(deps).listRequests('needs_you', WITHIN)).rows;
    expect(refused).toEqual({
      id: 3,
      invoiceAccessKey: replyRequest(3).invoiceAccessKey,
      invoiceNumber: '43894',
      supplierId: 'F02',
      supplierName: 'Bebidas Rio Claro',
      requestType: 'return_note',
      totalValue: replyRequest(3).note.total,
      dueOn: '2026-11-17',
      status: 'sent',
      reading: withReading,
      followUpDrafted: false,
      followUpSent: false,
    });
    const [overdue] = (await createReplyUseCases(deps).listRequests('overdue', WITHIN)).rows;
    expect(overdue).toMatchObject({ id: 7, followUpDrafted: true, followUpSent: false });
  });

  it('não grava nada ao listar', async () => {
    const { deps, store } = parts(rows());
    await createReplyUseCases(deps).listRequests('overdue', TODAY);
    expect(store.calls).toEqual([]);
  });
});
