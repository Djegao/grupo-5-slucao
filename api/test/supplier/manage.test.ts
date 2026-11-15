import { describe, expect, it } from 'vitest';
import { ClaudeError } from '../../src/claude/client.js';
import { supplierRequestDraftTask } from '../../src/supplier/draft-task.js';
import { createSupplierUseCases } from '../../src/supplier/use-cases.js';
import { GOOD_TEXT, NOW, fakeAsk, statusOf, world, type World } from './doubles.js';

const BY = 'ana@jachegou.example';

const drafted = async (): Promise<World> => {
  const w = world();
  await supplierRequestDraftTask(w.deps).run({ queueId: 7 }, fakeAsk());
  return w;
};

describe('#11/AC-6 editar aceita só o corpo, revalidado', () => {
  it('troca o corpo e deixa assunto, lista e nota como estavam; devolve o corpo já com os números', async () => {
    const w = await drafted();
    const before = w.requests.rows[0]!.request;
    const note = before.note;
    const result = await createSupplierUseCases(w.deps).editBody(41, 'Pedimos o retorno até {{prazo}}.');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.rendered.body).toBe('Pedimos o retorno até 17/11/2026.');
    expect(before.body).toBe('Pedimos o retorno até {{prazo}}.');
    expect(before.subject).toBe(GOOD_TEXT.subject);
    expect(before.asks).toEqual(GOOD_TEXT.asks);
    expect(before.note).toBe(note);
    expect(w.requests.saves).toBe(1);
  });

  it('número digitado fora do catálogo é recusado e o corpo anterior fica', async () => {
    const w = await drafted();
    const result = await createSupplierUseCases(w.deps).editBody(41, 'Devolvemos 999 caixas.');
    expect(result).toEqual({ kind: 'invalid', reason: 'number_mismatch', field: 'body' });
    expect(w.requests.rows[0]?.request.body).toBe(GOOD_TEXT.body);
    expect(w.requests.saves).toBe(0);
  });

  it('só o rascunho se edita; o inexistente é not_found', async () => {
    const w = await drafted();
    const useCases = createSupplierUseCases(w.deps);
    expect(await useCases.editBody(99, 'texto')).toEqual({ kind: 'not_found' });
    await useCases.send(41, BY);
    expect(await useCases.editBody(41, 'texto')).toEqual({ kind: 'conflict', reason: 'not_draft' });
  });

  it('sem a nota de origem para refazer o catálogo, não edita', async () => {
    const w = await drafted();
    const useCases = createSupplierUseCases({ ...w.deps, source: { find: async () => null } });
    expect(await useCases.editBody(41, 'texto')).toEqual({ kind: 'invalid', reason: 'source_missing' });
  });
});

describe('#11/AC-6 descartar respeita o ciclo do pedido', () => {
  it('descarta o rascunho com o motivo e quem descartou', async () => {
    const w = await drafted();
    const result = await createSupplierUseCases(w.deps).discard(41, BY, 'fornecedor já avisado por telefone');
    expect(result.kind).toBe('ok');
    expect(statusOf(w, 41)).toBe('discarded');
    expect(w.requests.rows[0]?.request.discardReason).toBe('fornecedor já avisado por telefone');
    expect(w.requests.rows[0]?.stamps).toContainEqual({ discarded: { by: BY, at: NOW } });
  });

  it('motivo em branco é invalid; pedido enviado é conflito; inexistente é not_found', async () => {
    const w = await drafted();
    const useCases = createSupplierUseCases(w.deps);
    expect(await useCases.discard(41, BY, '  ')).toEqual({ kind: 'invalid', reason: 'reason_required' });
    expect(await useCases.discard(99, BY, 'x')).toEqual({ kind: 'not_found' });
    await useCases.send(41, BY);
    expect(await useCases.discard(41, BY, 'x')).toEqual({ kind: 'conflict', reason: 'not_draft' });
  });
});

describe('#11/AC-6 refazer respeita um pedido aberto por nota de origem e tipo', () => {
  it('depois de descartar, cria um rascunho novo pelo mesmo caminho da tarefa', async () => {
    const w = await drafted();
    const useCases = createSupplierUseCases(w.deps);
    await useCases.discard(41, BY, 'texto ruim');
    const result = await useCases.redraft(41, fakeAsk());
    expect(result.kind).toBe('ok');
    expect(statusOf(w, 42)).toBe('draft');
    expect(w.requests.rows[1]?.queueId).toBe(7);
    expect(w.notes.issuedCount).toBe(0);
  });

  it('com um pedido aberto para a nota, é conflito e o Claude nem é chamado', async () => {
    const w = await drafted();
    const ask = fakeAsk();
    expect(await createSupplierUseCases(w.deps).redraft(41, ask)).toEqual({ kind: 'conflict', reason: 'open_request_exists' });
    expect(ask.calls).toEqual([]);
  });

  it('com a devolução já fora da pendente, é conflito', async () => {
    const w = await drafted();
    const useCases = createSupplierUseCases(w.deps);
    await useCases.discard(41, BY, 'x');
    w.queue.views[0]!.status = 'cancelada';
    expect(await useCases.redraft(41, fakeAsk())).toEqual({ kind: 'conflict', reason: 'queue_not_pending' });
  });

  it('pedido inexistente é not_found; falha do Claude sobe como está', async () => {
    const w = await drafted();
    const useCases = createSupplierUseCases(w.deps);
    expect(await useCases.redraft(99, fakeAsk())).toEqual({ kind: 'not_found' });
    await useCases.discard(41, BY, 'x');
    const failure = new ClaudeError('rate_limit', 'limite', 429);
    await expect(useCases.redraft(41, fakeAsk(failure))).rejects.toBe(failure);
  });

  it('o texto recusado vira um pedido descartado com o motivo, e o resultado diz isso', async () => {
    const w = await drafted();
    const useCases = createSupplierUseCases(w.deps);
    await useCases.discard(41, BY, 'x');
    const result = await useCases.redraft(41, fakeAsk({ subject: 'oi' }));
    expect(result.kind === 'ok' && result.record.request.status).toBe('discarded');
  });
});
