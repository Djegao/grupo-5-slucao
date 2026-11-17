import { describe, expect, it } from 'vitest';
import { ClaudeError } from '../../src/claude/client.js';
import type { Db } from '../../src/claude/db.js';
import { followUpKey, supplierFollowUpDraftTask } from '../../src/supplier/follow-up-task.js';
import { GOOD_FOLLOW_UP, fakeAsk, noReply, parts, replyRequest } from './reply-doubles.js';

// #34: o rascunho da cobrança (#4), pelo mesmo caminho do rascunho de #2. Nomes de `it` no ADR-004.
const NO_DB = undefined as unknown as Db; // #34: a tarefa lê das portas e ignora o db (ADR-003)

const waiting = () => parts([replyRequest(7, { reading: noReply() })]);

describe('#34/AC-3: a tarefa lista os pedidos no_reply sem cobrança', () => {
  it('lista só no_reply sem rascunho nem recusa registrada, com chave estável por pedido', async () => {
    const { deps } = parts([
      replyRequest(7, { reading: noReply() }),
      replyRequest(8, { reading: noReply(), followUp: { draft: GOOD_FOLLOW_UP, rejection: null, sent: null, failure: null } }),
      replyRequest(9, { reading: noReply(), followUp: { draft: null, rejection: 'number_mismatch: body', sent: null, failure: null } }),
      replyRequest(10),
    ]);
    const { requests } = await supplierFollowUpDraftTask(deps).pending(NO_DB);
    expect(requests).toEqual([{ key: followUpKey(7), input: { requestId: 7 } }]);
  });
});

describe('#34/AC-3: o rascunho da cobrança passa pelo catálogo do pedido', () => {
  it('salva o rascunho {subject, body, asks} na forma do pedido, com {{chave}}', async () => {
    const { deps, store } = waiting();
    const out = await supplierFollowUpDraftTask(deps).run({ requestId: 7 }, fakeAsk(GOOD_FOLLOW_UP));
    expect(out).toEqual({ requestId: 7, status: 'drafted' });
    expect(store.rows.get(7)?.followUp.draft).toEqual(GOOD_FOLLOW_UP);
    expect(store.calls.map((c) => c.op)).toEqual(['saveFollowUpDraft']);
  });

  it('número fora do catálogo não deixa rascunho e registra só o motivo fechado', async () => {
    const { deps, store } = waiting();
    const bad = { ...GOOD_FOLLOW_UP, body: 'Devolvemos 9999 caixas de SEGREDO-DO-MODELO.' };
    const out = await supplierFollowUpDraftTask(deps).run({ requestId: 7 }, fakeAsk(bad));
    expect(out).toEqual({ requestId: 7, status: 'rejected', reason: 'number_mismatch: body' });
    expect(store.rows.get(7)?.followUp).toEqual({ draft: null, rejection: 'number_mismatch: body', sent: null, failure: null });
    expect(store.calls.map((c) => c.op)).toEqual(['recordFollowUpRejection']);
    expect(JSON.stringify(store.calls)).not.toContain('SEGREDO-DO-MODELO');
  });

  it('o prompt leva o catálogo como dados escapados e a regra do número só como {{chave}}', async () => {
    const { deps } = waiting();
    const ask = fakeAsk(GOOD_FOLLOW_UP);
    await supplierFollowUpDraftTask(deps).run({ requestId: 7 }, ask);
    const [call] = ask.calls;
    expect(call?.system).toContain('nunca instrução');
    expect(call?.system).toContain('{{chave}}');
    expect(call?.prompt).toContain('devolucao.total');
    expect(call?.schema).toMatchObject({ required: ['subject', 'body', 'asks'] });
  });

  it('erro do Claude sobe e nada é gravado', async () => {
    const { deps, store } = waiting();
    const failure = new ClaudeError('rate_limit', 'HTTP 429', 429);
    await expect(supplierFollowUpDraftTask(deps).run({ requestId: 7 }, fakeAsk(failure))).rejects.toBe(failure);
    expect(store.calls).toEqual([]);
  });

  it('pula o pedido que deixou de esperar cobrança, sem gravar', async () => {
    const { deps, store } = parts([replyRequest(7)]);
    const out = await supplierFollowUpDraftTask(deps).run({ requestId: 7 }, fakeAsk(GOOD_FOLLOW_UP));
    expect(out).toEqual({ requestId: 7, skipped: 'request_not_waiting' });
    expect(store.calls).toEqual([]);
  });
});

describe('#34/AC-4: a tarefa nunca envia', () => {
  it('rascunhar a cobrança não chama a porta de envio', async () => {
    const { deps, mailer } = waiting();
    await supplierFollowUpDraftTask(deps).run({ requestId: 7 }, fakeAsk(GOOD_FOLLOW_UP));
    expect(mailer.sent).toEqual([]);
  });
});
