import { describe, expect, it, vi } from 'vitest';
import { NEXT_STEPS, REPLY_OUTCOMES, type RequestFilter } from '../../src/domain/index.js';
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

  it('com um teto, marca só os primeiros atrasados e a chamada seguinte marca o próximo', async () => {
    const { deps, store } = parts([replyRequest(7), replyRequest(8), replyRequest(9)]);
    const useCases = createReplyUseCases(deps);
    expect(await useCases.sweepOverdue(2)).toEqual({ marked: [7, 8] });
    expect(await useCases.sweepOverdue(2)).toEqual({ marked: [9] });
    expect(store.calls.map((c) => c.op)).toEqual(['recordReading', 'recordReading', 'recordReading']);
  });

  it('com teto 0 não marca nada', async () => {
    const { deps, store } = parts([replyRequest(7)]);
    expect(await createReplyUseCases(deps).sweepOverdue(0)).toEqual({ marked: [] });
    expect(store.calls).toEqual([]);
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

  it('devolve o pedido como ficou depois do envio: carimbo gravado e sem falha (#34/AC-4)', async () => {
    const failed = replyRequest(7, { ...drafted(), followUp: { ...drafted().followUp, failure: 'mailbox_full' } });
    const { deps } = parts([failed]);
    const out = await createReplyUseCases(deps).sendFollowUp(7, 'ana');
    expect(out.kind === 'ok' && out.request.followUp).toMatchObject({
      sent: { by: 'ana', at: NOW, channel: 'mock', providerMessageId: 'mock-1' },
      failure: null,
    });
  });

  it('reivindica o envio antes de mandar o e-mail (#34/AC-4)', async () => {
    const { deps, store, mailer } = parts([drafted()]);
    await createReplyUseCases(deps).sendFollowUp(7, 'ana');
    expect(store.calls.map((c) => c.op)).toEqual(['claimFollowUpSend', 'recordFollowUpSent']);
    expect(mailer.sent).toHaveLength(1);
  });

  it('a reivindicação e a falha levam quem enviou, para o histórico do pedido (#35)', async () => {
    const { deps, store } = parts([drafted()], [], fakeMailer({ ok: false, reason: 'mailbox_full' }));
    await createReplyUseCases(deps).sendFollowUp(7, 'ana');
    expect(store.calls).toEqual([
      { op: 'claimFollowUpSend', args: [7, 'ana'] },
      { op: 'recordFollowUpFailure', args: [7, 'claim-1', 'mailbox_full', 'ana'] },
    ]);
  });

  it('duas chamadas ao mesmo tempo mandam um e-mail só; a outra volta como conflito (#34/AC-4)', async () => {
    const { deps, mailer } = parts([drafted()]);
    const useCases = createReplyUseCases(deps);
    const results = await Promise.all([useCases.sendFollowUp(7, 'ana'), useCases.sendFollowUp(7, 'bia')]);
    expect(results.map((r) => r.kind).sort()).toEqual(['conflict', 'ok']);
    expect(results).toContainEqual({ kind: 'conflict', reason: 'send_in_progress' });
    expect(mailer.sent).toHaveLength(1);
  });

  it('se a gravação do carimbo falha depois do e-mail, a nova chamada não manda de novo (#34/AC-4)', async () => {
    const { deps, store, mailer } = parts([drafted()]);
    store.failStamp.on = true;
    const useCases = createReplyUseCases(deps);
    await expect(useCases.sendFollowUp(7, 'ana')).rejects.toThrow();
    store.failStamp.on = false;
    expect(await useCases.sendFollowUp(7, 'ana')).toEqual({ kind: 'conflict', reason: 'send_in_progress' });
    expect(mailer.sent).toHaveLength(1);
  });

  it('a falha do envio solta a reivindicação: a pessoa tenta de novo e o e-mail sai (#34/AC-4)', async () => {
    const failing = parts([drafted()], [], fakeMailer({ ok: false, reason: 'mailbox_full' }));
    await createReplyUseCases(failing.deps).sendFollowUp(7, 'ana');
    expect(failing.store.claims.has(7)).toBe(false);
    const retry = createReplyUseCases({ ...failing.deps, mailer: fakeMailer() });
    expect(await retry.sendFollowUp(7, 'ana')).toMatchObject({ kind: 'ok' });
  });

  it('o carimbo leva a ficha da reivindicação que o caso de uso ganhou (#35 REL-3)', async () => {
    const { deps, store } = parts([drafted()]);
    await createReplyUseCases(deps).sendFollowUp(7, 'ana');
    expect(store.calls.at(-1)).toMatchObject({ op: 'recordFollowUpSent', args: [7, 'claim-1', expect.objectContaining({ by: 'ana' })] });
  });

  it('quem perdeu a reivindicação durante o envio e falhou não solta a de outro: volta conflito e nada é gravado (#35 REL-3)', async () => {
    const { deps, store } = parts([drafted()], [], fakeMailer({ ok: false, reason: 'mailbox_full' }));
    const retaken = { send: (m: Parameters<typeof deps.mailer.send>[0]) => { store.claims.set(7, 'claim-de-beto'); return deps.mailer.send(m); } };
    const out = await createReplyUseCases({ ...deps, mailer: retaken }).sendFollowUp(7, 'ana');
    expect(out).toEqual({ kind: 'conflict', reason: 'send_in_progress' });
    expect(store.claims.get(7)).toBe('claim-de-beto');
    expect(store.rows.get(7)?.followUp.failure).toBeNull();
  });

  it('quem perdeu a reivindicação durante o envio e enviou não grava o carimbo: volta conflito e o log leva só campos nomeados (#35 REL-3)', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { deps, store } = parts([drafted()]);
      const retaken = { send: (m: Parameters<typeof deps.mailer.send>[0]) => { store.claims.set(7, 'claim-de-beto'); return deps.mailer.send(m); } };
      const out = await createReplyUseCases({ ...deps, mailer: retaken }).sendFollowUp(7, 'ana');
      expect(out).toEqual({ kind: 'conflict', reason: 'send_in_progress' });
      expect(store.rows.get(7)?.followUp.sent).toBeNull();
      expect(store.claims.get(7)).toBe('claim-de-beto');
      expect(log).toHaveBeenCalledWith('#35 a reivindicação da cobrança foi perdida antes de gravar o resultado', {
        operation: 'follow-up-stamp',
        requestId: 7,
      });
      expect(JSON.stringify(log.mock.calls)).not.toContain('claim-');
    } finally {
      log.mockRestore();
    }
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

  it('porta que lança deixa no log do servidor só a classe do erro, a operação e o pedido, nunca o texto', async () => {
    class SmtpDown extends Error {}
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { deps } = parts([drafted()], [], fakeMailer(new SmtpDown(PROVIDER_TEXT)));
      await createReplyUseCases(deps).sendFollowUp(7, 'ana');
      const lines = JSON.stringify(log.mock.calls);
      expect(log).toHaveBeenCalledTimes(1);
      expect(lines).toContain('SmtpDown');
      expect(lines).toContain('follow-up-send');
      expect(lines).not.toContain('smtp 550');
      expect(lines).not.toContain('sk-segredo');
      expect(lines).not.toContain('compras@');
    } finally {
      log.mockRestore();
    }
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
  replyRequest(1), // #34/AC-5: aguardando: dentro do prazo
  replyRequest(2, { reading: reading({ summary: 'Atendeu.' }) }), // #34/AC-5: atendido
  replyRequest(3, { reading: reading({ replyOutcome: 'needs_information', nextStep: 'answer_supplier' }) }),
  replyRequest(4, { reading: noReply() }),
  replyRequest(5, { dueOn: '2026-11-10' }), // #34/AC-5: enviado sem leitura depois do prazo: atrasado
  replyRequest(6, { status: 'draft' }), // #34/AC-5: não enviado: em nenhum filtro
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

describe('#50/AC-3: a lista põe cada pedido enviado em um filtro só', () => {
  const FILTERS: readonly RequestFilter[] = ['awaiting', 'answered', 'needs_you', 'overdue'];

  it('as contagens somam os pedidos enviados e cada pedido aparece nas linhas de um filtro só', async () => {
    let id = 0;
    const sent = [replyRequest((id += 1)), replyRequest((id += 1), { dueOn: '2026-11-10' })];
    for (const replyOutcome of REPLY_OUTCOMES) {
      for (const nextStep of NEXT_STEPS) {
        for (const supplierDocument of [null, '881']) sent.push(replyRequest((id += 1), { reading: reading({ replyOutcome, nextStep, supplierDocument }) }));
      }
    }
    const notSent = [replyRequest((id += 1), { status: 'draft' }), replyRequest((id += 1), { status: 'send_failed' })];
    const { deps } = parts([...sent, ...notSent]);
    const useCases = createReplyUseCases(deps);
    const lists = await Promise.all(FILTERS.map((f) => useCases.listRequests(f, WITHIN)));
    const counts = lists[0]?.counts;
    expect(counts).toBeDefined();
    expect(Object.keys(counts ?? {}).sort()).toEqual([...FILTERS].sort());
    expect(Object.values(counts ?? {}).reduce((a, b) => a + b, 0)).toBe(sent.length);
    const seen = lists.flatMap((l) => l.rows.map((r) => r.id)).sort((a, b) => a - b);
    expect(seen).toEqual(sent.map((r) => r.id));
    for (const l of lists) expect(l.rows).toHaveLength(l.counts[l.filter]);
  });
});
