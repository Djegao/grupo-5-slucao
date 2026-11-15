// #11: testes da tarefa do Cron (api/src/supplier/draft-task.ts); o caminho do rascunho tem os seus em draft.test.ts.
import { describe, expect, it } from 'vitest';
import { ClaudeError } from '../../src/claude/client.js';
import type { Db } from '../../src/claude/db.js';
import { supplierRequestDraftTask } from '../../src/supplier/draft-task.js';
import { GOOD_TEXT, fakeAsk, fakeMailer, queueView, world } from './doubles.js';

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

  it('devolução que a regra não monta falha para o laço registrar o erro, sem rascunho', async () => {
    const lines = [{ supplierCode: 'X-1', description: 'x', quantity: { amount: 1, unit: 'UN' as const }, valueCents: null }];
    const w = world(fakeMailer(), [queueView(7, { lines })]);
    await expect(supplierRequestDraftTask(w.deps).run({ queueId: 7 }, fakeAsk())).rejects.toThrow();
    expect(w.requests.rows).toEqual([]);
  });
});

describe('#11/AC-2 texto do Claude recusado pelo catálogo', () => {
  it('a tarefa volta normalmente com o pedido descartado (os motivos estão em draft.test.ts)', async () => {
    const w = world();
    const bad = { ...GOOD_TEXT, body: 'Devolvemos 999 caixas.' };
    await expect(supplierRequestDraftTask(w.deps).run({ queueId: 7 }, fakeAsk(bad))).resolves.toMatchObject({ status: 'discarded' });
  });

  it('o descartado não conta como aberto: a devolução volta à lista da tarefa', async () => {
    const w = world();
    const task = supplierRequestDraftTask(w.deps);
    await task.run({ queueId: 7 }, fakeAsk({ subject: 'oi' }));
    expect((await task.pending(db)).requests).toHaveLength(1);
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
