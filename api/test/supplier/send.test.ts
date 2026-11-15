import { describe, expect, it } from 'vitest';
import { createSupplierUseCases } from '../../src/supplier/use-cases.js';
import { supplierRequestDraftTask } from '../../src/supplier/draft-task.js';
import { NOW, SUPPLIER_EMAIL, fakeAsk, fakeMailer, statusOf, world, type FakeMailer, type World } from './doubles.js';

const BY = 'ana@jachegou.example';

const drafted = async (mailer: FakeMailer = fakeMailer()): Promise<World> => {
  const w = world(mailer);
  await supplierRequestDraftTask(w.deps).run({ queueId: 7 }, fakeAsk());
  return w;
};

describe('#11/AC-4 emitir e enviar', () => {
  it('emite a nota pelo mock, move a fila para emitida com o número e envia com a nota anexa', async () => {
    const w = await drafted();
    const result = await createSupplierUseCases(w.deps).send(41, BY);
    expect(result.kind).toBe('ok');
    expect(w.notes.issuedCount).toBe(1);
    expect(w.queue.emitCalls).toEqual([[7, '101', BY, NOW]]);
    expect(w.queue.views[0]).toMatchObject({ status: 'emitida', emitted: { number: '101', by: BY } });
    expect(statusOf(w, 41)).toBe('sent');
    expect(w.requests.rows[0]?.request.issuedNote?.number).toBe(101);
  });

  it('o e-mail vai para o fornecedor, com os números do catálogo no lugar dos marcadores', async () => {
    const w = await drafted();
    await createSupplierUseCases(w.deps).send(41, BY);
    const [mail] = w.mailer.sent;
    expect(mail?.to).toBe(SUPPLIER_EMAIL);
    expect(mail?.requestType).toBe('return_note');
    expect(mail?.invoiceAccessKey).toBe(w.requests.rows[0]?.request.invoiceAccessKey);
    expect(mail?.subject).toContain('43894');
    expect(mail?.body).not.toContain('{{');
    expect(mail?.body).toContain('7 UN');
    expect(mail?.asks.join(' ')).not.toContain('{{');
    expect(mail?.dueOn).toBe('2026-11-17');
  });

  it('a nota anexa é o JSON no formato do kit, com a nota de origem e as linhas devolvidas', async () => {
    const w = await drafted();
    await createSupplierUseCases(w.deps).send(41, BY);
    const [attachment] = w.mailer.sent[0]?.attachments ?? [];
    expect(attachment).toMatchObject({ filename: 'ND-101.json', contentType: 'application/json' });
    const note: unknown = JSON.parse(attachment?.content ?? '{}');
    expect(note).toMatchObject({
      nota_id: 'ND-101',
      numero: 101,
      serie: 9,
      fornecedor_id: 'F02',
      destino: 'LJ-012',
      data_emissao: '2026-11-12',
      natureza: 'devolucao',
      valor_total: 559.43,
    });
    expect(note).toHaveProperty('chave', expect.stringMatching(/^\d{44}$/));
    expect(note).toHaveProperty('nota_referenciada', w.requests.rows[0]?.request.invoiceAccessKey);
    expect(note).toHaveProperty('itens', [
      { codigo_fornecedor: 'F02-002', sku: 'SKU-1006', descricao: 'Refrigerante cola 2 L', quantidade: 7, unidade: 'UN', preco_unitario: 8.49, valor: 59.43 },
      { codigo_fornecedor: 'F02-005', sku: null, descricao: 'Arroz 5 kg', quantidade: 5, unidade: 'CX', preco_unitario: 100, valor: 500 },
    ]);
  });

  it('grava quem enviou, quando, o canal e o identificador do provedor', async () => {
    const w = await drafted(fakeMailer({ ok: true, channel: 'resend', providerMessageId: 'msg-9' }));
    await createSupplierUseCases(w.deps).send(41, BY);
    expect(w.requests.rows[0]?.stamps).toContainEqual({ sent: { by: BY, at: NOW, channel: 'resend', providerMessageId: 'msg-9' } });
  });

  it('pedido que não existe é not_found, sem emitir nada', async () => {
    const w = await drafted();
    expect(await createSupplierUseCases(w.deps).send(99, BY)).toEqual({ kind: 'not_found' });
    expect(w.notes.issuedCount).toBe(0);
  });

  it('pedido já enviado ou descartado é conflito, sem outro e-mail', async () => {
    const w = await drafted();
    const useCases = createSupplierUseCases(w.deps);
    await useCases.send(41, BY);
    expect(await useCases.send(41, BY)).toEqual({ kind: 'conflict', reason: 'not_sendable' });
    expect(w.mailer.sent).toHaveLength(1);
  });

  it('devolução que já não está pendente na fila é conflito: o e-mail não sai e a nota emitida fica registrada', async () => {
    const w = await drafted();
    w.queue.views[0]!.status = 'emitida';
    w.queue.views[0]!.emitted = { number: '999', by: 'outra@jachegou.example', at: NOW.toISOString() };
    expect(await createSupplierUseCases(w.deps).send(41, BY)).toEqual({ kind: 'conflict', reason: 'queue_not_pending' });
    expect(w.mailer.sent).toEqual([]);
    expect(statusOf(w, 41)).toBe('draft');
    expect(w.requests.rows[0]?.request.issuedNote?.number).toBe(101);
  });

  it('devolução que sumiu da fila é conflito', async () => {
    const w = await drafted();
    w.queue.views.length = 0;
    expect(await createSupplierUseCases(w.deps).send(41, BY)).toEqual({ kind: 'conflict', reason: 'queue_entry_missing' });
  });

  it('nota de origem que o cadastro não devolve é invalid, antes de emitir', async () => {
    const w = await drafted();
    const useCases = createSupplierUseCases({ ...w.deps, source: { find: async () => null } });
    expect(await useCases.send(41, BY)).toEqual({ kind: 'invalid', reason: 'source_missing' });
    expect(w.notes.issuedCount).toBe(0);
  });
});

describe('#11/AC-5 reenviar nunca emite outra nota', () => {
  it('a falha do envio deixa send_failed com o motivo; o reenvio usa a nota emitida e envia', async () => {
    const w = await drafted(fakeMailer({ ok: false, reason: 'caixa_de_saida_indisponivel' }));
    const useCases = createSupplierUseCases(w.deps);
    expect(await useCases.send(41, BY)).toMatchObject({ kind: 'send_failed', reason: 'caixa_de_saida_indisponivel' });
    expect(statusOf(w, 41)).toBe('send_failed');
    expect(w.requests.rows[0]?.request.sendFailureReason).toBe('caixa_de_saida_indisponivel');
    expect(w.queue.views[0]?.status).toBe('emitida');

    expect((await useCases.send(41, BY)).kind).toBe('ok');
    expect(w.notes.issuedCount).toBe(1);
    expect(statusOf(w, 41)).toBe('sent');
    expect(w.queue.views[0]?.emitted?.number).toBe('101');
    expect(w.mailer.sent).toHaveLength(2);
    expect(w.mailer.sent[1]?.attachments[0]?.filename).toBe('ND-101.json');
  });

  it('o reenvio que falha de novo troca o motivo e continua send_failed', async () => {
    const w = await drafted(fakeMailer({ ok: false, reason: 'primeira' }, { ok: false, reason: 'segunda' }));
    const useCases = createSupplierUseCases(w.deps);
    await useCases.send(41, BY);
    await useCases.send(41, BY);
    expect(w.requests.rows[0]?.request.sendFailureReason).toBe('segunda');
    expect(w.notes.issuedCount).toBe(1);
  });

  it('o envio é refeito do rascunho que já tem nota: sem emitir outra', async () => {
    const w = await drafted();
    const request = w.requests.rows[0]!.request;
    request.recordIssuance(await w.deps.notes.issue(7, request.note, '2026-11-12'));
    expect((await createSupplierUseCases(w.deps).send(41, BY)).kind).toBe('ok');
    expect(w.notes.issuedCount).toBe(1);
  });
});

describe('#11/AC-5 pedido que falhou sem nota registrada', () => {
  it('não emite pelo reenvio: o domínio só registra a nota a partir do rascunho', async () => {
    const w = await drafted();
    w.requests.rows[0]!.request.markSendFailed('estado antigo');
    expect(await createSupplierUseCases(w.deps).send(41, BY)).toEqual({ kind: 'conflict', reason: 'issuance_missing' });
    expect(w.notes.issuedCount).toBe(0);
    expect(w.mailer.sent).toEqual([]);
  });
});

describe('#11/AC-5 o que o motivo da falha carrega', () => {
  it('um erro lançado pelo envio vira motivo genérico, sem o texto do erro', async () => {
    const w = await drafted(fakeMailer(new Error('SMTP recusou a senha hunter2 em smtp.interno')));
    const result = await createSupplierUseCases(w.deps).send(41, BY);
    expect(result).toEqual({ kind: 'send_failed', reason: 'mailer_error', record: w.requests.rows[0] });
    expect(w.requests.rows[0]?.request.sendFailureReason).toBe('mailer_error');
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });

  it('motivo em branco do envio vira um motivo genérico, para a falha ficar registrada', async () => {
    const w = await drafted(fakeMailer({ ok: false, reason: '  ' }));
    await createSupplierUseCases(w.deps).send(41, BY);
    expect(w.requests.rows[0]?.request.sendFailureReason).toBe('send_failed');
  });
});
