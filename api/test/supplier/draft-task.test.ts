import { describe, expect, it } from 'vitest';
import { ClaudeError } from '../../src/claude/client.js';
import type { Db } from '../../src/claude/db.js';
import { supplierRequestDraftTask } from '../../src/supplier/draft-task.js';
import { GOOD_TEXT, SUPPLIER_EMAIL, fakeAsk, fakeMailer, queueView, statusOf, world } from './doubles.js';

const db: Db = { select: async () => [], upsert: async () => [] };

describe('#11/AC-1 a tarefa lista as devoluções pendentes sem pedido aberto', () => {
  it('uma chave estável por devolução da fila', async () => {
    const w = world(fakeMailer(), [queueView(7), queueView(8, { status: 'emitida' })]);
    const { requests, dropped } = await supplierRequestDraftTask(w.deps).pending(db);
    expect(requests.map((r) => r.key)).toEqual(['return_note:7']);
    expect(requests[0]?.input).toEqual({ queueId: 7 });
    expect(dropped).toBe(0);
  });

  it('pula a devolução cuja nota de origem já tem pedido aberto', async () => {
    const w = world();
    const task = supplierRequestDraftTask(w.deps);
    await task.run({ queueId: 7 }, fakeAsk());
    expect((await task.pending(db)).requests).toEqual([]);
  });

  it('grava um rascunho com a nota montada pela regra e o e-mail do Claude, para o e-mail do fornecedor', async () => {
    const w = world();
    const ask = fakeAsk();
    await supplierRequestDraftTask(w.deps).run({ queueId: 7 }, ask);
    const [row] = w.requests.rows;
    expect(row?.request.status).toBe('draft');
    expect(row?.request.note.total).toBe(559.43);
    expect(row?.request.note.items.map((i) => i.supplierCode)).toEqual(['F02-002', 'F02-005']);
    expect(row?.request.subject).toBe(GOOD_TEXT.subject);
    expect(row?.request.dueOn).toBe('2026-11-17');
    expect(row?.queueId).toBe(7);
    expect(row?.to).toBe(SUPPLIER_EMAIL);
    expect(ask.calls).toHaveLength(1);
  });

  it('devolução que a regra não monta falha para o laço registrar o erro, sem rascunho', async () => {
    const lines = [{ supplierCode: 'X-1', description: 'x', quantity: { amount: 1, unit: 'UN' as const }, valueCents: null }];
    const w = world(fakeMailer(), [queueView(7, { lines })]);
    await expect(supplierRequestDraftTask(w.deps).run({ queueId: 7 }, fakeAsk())).rejects.toThrow();
    expect(w.requests.rows).toEqual([]);
  });
});

describe('#11/AC-2 texto do Claude recusado pelo catálogo', () => {
  it('número fora do catálogo: o pedido nasce descartado, com o motivo, e a tarefa volta normalmente', async () => {
    const w = world();
    const bad = { ...GOOD_TEXT, body: 'Devolvemos 999 caixas.' };
    await expect(supplierRequestDraftTask(w.deps).run({ queueId: 7 }, fakeAsk(bad))).resolves.toMatchObject({ status: 'discarded' });
    expect(statusOf(w, 41)).toBe('discarded');
    expect(w.requests.rows[0]?.request.discardReason).toBe('number_mismatch: body');
  });

  it('resposta sem a forma pedida também nasce descartada', async () => {
    const w = world();
    await supplierRequestDraftTask(w.deps).run({ queueId: 7 }, fakeAsk({ subject: 'oi' }));
    expect(w.requests.rows[0]?.request.discardReason).toBe('invalid_shape: body');
  });

  it('o descartado não conta como aberto: a devolução volta à lista da tarefa', async () => {
    const w = world();
    const task = supplierRequestDraftTask(w.deps);
    await task.run({ queueId: 7 }, fakeAsk({ subject: 'oi' }));
    expect((await task.pending(db)).requests).toHaveLength(1);
  });
});

describe('#11/AC-3 preparar o rascunho não emite nem envia', () => {
  it('nenhuma nota emitida, nenhuma fila movida, nenhum e-mail', async () => {
    const w = world();
    await supplierRequestDraftTask(w.deps).run({ queueId: 7 }, fakeAsk());
    expect(w.notes.issuedCount).toBe(0);
    expect(w.queue.emitCalls).toEqual([]);
    expect(w.mailer.sent).toEqual([]);
    expect(w.queue.views[0]?.status).toBe('pendente');
  });
});

describe('#11/AC-1 sem credencial, 401 ou 429 não deixa rascunho', () => {
  it.each([
    ['auth', 401],
    ['rate_limit', 429],
  ] as const)('o erro %s do Claude sobe como está e nada é criado', async (kind, status) => {
    const w = world();
    const failure = new ClaudeError(kind, 'recusado', status);
    await expect(supplierRequestDraftTask(w.deps).run({ queueId: 7 }, fakeAsk(failure))).rejects.toBe(failure);
    expect(w.requests.rows).toEqual([]);
  });
});
