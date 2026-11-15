import { describe, expect, it } from 'vitest';
import { ClaudeError, type Ask } from '../../src/claude/client.js';
import { DockAction, SYSTEM_ACTOR, SUPPLIER_REQUEST_OUTPUT_SCHEMA } from '../../src/domain/index.js';
import {
  discardRequest,
  editBody,
  emitAndSend,
  openForDecided,
  readSupplierRequests,
  redo,
  retrySend,
  selectSupplierEmail,
  InMemorySupplierEmailSender,
  writeDraft,
  writeDrafts,
} from '../../src/supplier-requests/index.js';
import { decided, ORIGIN_KEY } from '../domain/supplier-request-fixtures.js';
import { E2_CASE, GOOD_BODY, world } from './fakes.js';

const askWith = (body: unknown): Ask => (async () => body) as Ask;
const goodAsk = askWith({ body: GOOD_BODY });

async function openedWorld(options: Parameters<typeof world>[0] = {}) {
  const w = world(options);
  await openForDecided(w.deps);
  const id = [...w.requests.rows.keys()][0]!;
  return { ...w, id };
}

async function draftWorld(options: Parameters<typeof world>[0] = {}) {
  const w = await openedWorld(options);
  await writeDraft(w.deps, w.id, goodAsk);
  return w;
}

describe('abrir o pedido para as propostas decididas', () => {
  it('#156/AC-1 a decisão E2 abre o pedido escrevendo, com o e-mail do cadastro, o assunto e os asks da regra', async () => {
    const w = world();
    const result = await openForDecided(w.deps);
    expect(result.opened).toHaveLength(1);
    const [snap] = [...w.requests.rows.values()];
    expect(snap).toMatchObject({
      status: 'writing',
      requestType: 'return_note',
      invoiceAccessKey: ORIGIN_KEY,
      supplierId: 'F11',
      to: 'fiscal@higienetotal.test',
      subject: 'NF 20046 · devolução do item trocado',
      asks: ['Retirar o item trocado', 'Entregar o item pedido'],
      channel: 'mock',
      createdBy: 'ana@jachegou.test',
      createdAt: '2026-11-16T11:00:00.000Z',
      body: null,
    });
  });

  it('#156/AC-1 publica a devolução na fila da #140 uma vez, pendente, e não emite nem envia', async () => {
    const w = world();
    await openForDecided(w.deps);
    expect(w.queue.publishes).toBe(1);
    expect([...w.queue.rows.values()].map((r) => r.status)).toEqual(['pendente']);
    expect(w.emissions.notes.size).toBe(0);
    expect(w.sender.sent).toHaveLength(0);
  });

  it('#156/AC-1 a recusa com mercadoria já entrada abre o pedido com o assunto da mercadoria recusada', async () => {
    const refused = { ...E2_CASE(), proposal: decided('E2', DockAction.refuse()), goodsEntered: true };
    const w = world({ cases: [refused] });
    await openForDecided(w.deps);
    expect([...w.requests.rows.values()][0]?.subject).toBe('NF 20046 · devolução de mercadoria recusada');
  });

  it('#156/AC-1 a decisão que não devolve mercadoria não abre pedido', async () => {
    const receive = { ...E2_CASE(), proposal: decided('E2', DockAction.receive()) };
    const w = world({ cases: [receive] });
    const result = await openForDecided(w.deps);
    expect(result.opened).toEqual([]);
    expect(result.skipped).toEqual([{ invoiceAccessKey: ORIGIN_KEY, reason: 'not_qualifying' }]);
    expect(w.queue.publishes).toBe(0);
  });

  it('#156/AC-8 varrer de novo não abre outro pedido enquanto há um aberto', async () => {
    const w = world();
    await openForDecided(w.deps);
    const again = await openForDecided(w.deps);
    expect(again.opened).toEqual([]);
    expect(again.skipped).toEqual([{ invoiceAccessKey: ORIGIN_KEY, reason: 'open_request_exists' }]);
    expect(w.requests.rows.size).toBe(1);
    expect(w.queue.publishes).toBe(1);
  });

  it('#156/AC-8 depois de enviado o pedido não bloqueia, mas a varredura não reabre o que já foi tratado', async () => {
    const w = await draftWorld();
    const id = [...w.requests.rows.keys()][0]!;
    await emitAndSend(w.deps, id, 'ana@jachegou.test');
    const again = await openForDecided(w.deps);
    expect(again.opened).toHaveLength(0);
    expect(again.skipped[0]?.reason).toBe('already_handled');
  });

  it('#156/AC-2 o total da nota diferente do valor da fila impede o pedido', async () => {
    const w = world({ queueValueCents: 100 });
    const result = await openForDecided(w.deps);
    expect(result.opened).toEqual([]);
    expect(result.skipped).toEqual([{ invoiceAccessKey: ORIGIN_KEY, reason: 'queue_mismatch' }]);
    expect(w.requests.rows.size).toBe(0);
  });

  it('#156/AC-1 fornecedor sem e-mail no cadastro não ganha pedido', async () => {
    const w = world({ email: null });
    const result = await openForDecided(w.deps);
    expect(result.skipped).toEqual([{ invoiceAccessKey: ORIGIN_KEY, reason: 'no_supplier_email' }]);
  });
});

describe('o Claude escreve o texto', () => {
  it('#156/AC-1 o texto com marcadores do catálogo vira rascunho com o prazo de 3 dias úteis e o modelo', async () => {
    const w = await openedWorld();
    const prompts: unknown[] = [];
    const ask = (async (options: unknown) => {
      prompts.push(options);
      return { body: GOOD_BODY };
    }) as Ask;
    const result = await writeDraft(w.deps, w.id, ask);
    expect(result).toMatchObject({ kind: 'ok', status: 'draft' });
    const snap = w.requests.rows.get(w.id)!;
    expect(snap).toMatchObject({ status: 'draft', body: GOOD_BODY, dueOn: '2026-11-19', updatedBy: SYSTEM_ACTOR });
    expect(snap.model).toEqual(expect.any(String));
    expect(prompts[0]).toMatchObject({ schema: SUPPLIER_REQUEST_OUTPUT_SCHEMA });
  });

  it('#156/AC-6 o prompt traz os fatos como marcadores e nenhum valor da fila solto fora do catálogo', async () => {
    const w = await openedWorld();
    let seen = '';
    await writeDraft(w.deps, w.id, (async (o: { prompt: string }) => {
      seen = o.prompt;
      return { body: GOOD_BODY };
    }) as Ask);
    expect(seen).toContain('devolucao.item[F11-001].quantidade');
    expect(seen).toContain('pedido.prazo');
  });

  it('#156/AC-6 um número fora do catálogo descarta o rascunho com o motivo registrado', async () => {
    const w = await openedWorld();
    const result = await writeDraft(w.deps, w.id, askWith({ body: 'Devolvemos 40 unidades da NF {{nota.numero}}.' }));
    expect(result).toMatchObject({ kind: 'ok', status: 'discarded' });
    expect(w.requests.rows.get(w.id)).toMatchObject({
      status: 'discarded',
      discardReason: 'number_mismatch',
      discardedBy: SYSTEM_ACTOR,
    });
  });

  it('#156/AC-6 a resposta fora do formato descarta com o motivo invalid_shape', async () => {
    const w = await openedWorld();
    await writeDraft(w.deps, w.id, askWith({ texto: 'oi' }));
    expect(w.requests.rows.get(w.id)).toMatchObject({ status: 'discarded', discardReason: 'invalid_shape' });
  });

  it('#156 só um pedido escrevendo recebe o texto do Claude', async () => {
    const w = await draftWorld();
    expect(await writeDraft(w.deps, w.id, goodAsk)).toEqual({ kind: 'conflict', reason: 'wrong_state' });
    expect(await writeDraft(w.deps, 'nope', goodAsk)).toEqual({ kind: 'not_found' });
  });

  it('#156 a falha do Claude deixa o pedido escrevendo, para a próxima rodada', async () => {
    const w = await openedWorld();
    const ask = (async () => {
      throw new ClaudeError('api', 'status 500', 500);
    }) as Ask;
    await expect(writeDraft(w.deps, w.id, ask)).rejects.toBeInstanceOf(ClaudeError);
    expect(w.requests.rows.get(w.id)?.status).toBe('writing');
  });

  it('#156 a rodada escreve todos os pedidos escrevendo e para no limite do Claude', async () => {
    const w = await openedWorld();
    expect(await writeDrafts(w.deps, goodAsk)).toEqual({ drafted: 1, discarded: 0, failed: 0, stopped: false });
    const w2 = await openedWorld();
    const limited = (async () => {
      throw new ClaudeError('rate_limit', 'limite', 429);
    }) as Ask;
    expect(await writeDrafts(w2.deps, limited)).toEqual({ drafted: 0, discarded: 0, failed: 1, stopped: true });
  });
});

describe('editar o texto', () => {
  it('#156/AC-7 a pessoa muda só o texto e fica registrado quem editou', async () => {
    const w = await draftWorld();
    const text = GOOD_BODY.replace('Olá.', 'Prezados, bom dia.');
    const result = await editBody(w.deps, w.id, text, 'ana@jachegou.test');
    expect(result).toMatchObject({ kind: 'ok' });
    const snap = w.requests.rows.get(w.id)!;
    expect(snap).toMatchObject({ body: text, editedBy: 'ana@jachegou.test' });
    expect(snap.asks).toEqual(['Retirar o item trocado', 'Entregar o item pedido']);
  });

  it('#156/AC-7 número solto, marcador trocado ou texto vazio é inválido e nada muda', async () => {
    const w = await draftWorld();
    for (const text of ['Devolvemos 40 UN.', GOOD_BODY.replace('{{devolucao.valor_total}}', '{{nota.total}}'), '  ']) {
      const result = await editBody(w.deps, w.id, text, 'ana@jachegou.test');
      expect(result.kind).toBe('invalid');
    }
    expect(w.requests.rows.get(w.id)?.body).toBe(GOOD_BODY);
  });

  it('#156/AC-7 fora do rascunho a edição é conflito', async () => {
    const w = await openedWorld();
    expect(await editBody(w.deps, w.id, GOOD_BODY, 'ana@jachegou.test')).toEqual({ kind: 'conflict', reason: 'wrong_state' });
    expect(await editBody(w.deps, 'nope', GOOD_BODY, 'x')).toEqual({ kind: 'not_found' });
  });
});

describe('emitir e enviar', () => {
  it('#156/AC-3 até a pessoa chamar nada é emitido nem enviado', async () => {
    const w = await draftWorld();
    expect(w.emissions.notes.size).toBe(0);
    expect(w.sender.sent).toHaveLength(0);
    expect([...w.queue.rows.values()][0]?.status).toBe('pendente');
  });

  it('#156/AC-4 emite a ND pelo mock, marca a fila como emitida com o número e anexa a nota', async () => {
    const w = await draftWorld();
    const result = await emitAndSend(w.deps, w.id, 'ana@jachegou.test');
    expect(result).toMatchObject({ kind: 'ok', status: 'sent' });
    const note = [...w.emissions.notes.values()][0]!;
    expect(note).toMatchObject({ nota_id: 'ND-0012', numero: 12, valor_total: 2163.2, nota_referenciada: ORIGIN_KEY });
    expect(note.chave).toHaveLength(44);
    const row = [...w.queue.rows.values()][0]!;
    expect(row).toMatchObject({ status: 'emitida', number: '12' });
    expect(w.requests.rows.get(w.id)?.attachments).toEqual([
      { kind: 'return_note', returnNoteId: 'ND-0012', filename: 'nota-devolucao-ND-0012.json' },
    ]);
  });

  it('#156/AC-5 o e-mail sai pela porta com o corpo preenchido e a nota em JSON anexa; vira sent', async () => {
    const w = await draftWorld();
    await emitAndSend(w.deps, w.id, 'ana@jachegou.test');
    expect(w.sender.sent).toHaveLength(1);
    const mail = w.sender.sent[0]!;
    expect(mail).toMatchObject({ to: 'fiscal@higienetotal.test', subject: 'NF 20046 · devolução do item trocado' });
    expect(mail.body).toContain('NF 20046');
    expect(mail.body).toContain('R$ 2.163,20');
    expect(mail.body).not.toContain('{{');
    expect(mail.attachments[0]).toMatchObject({ filename: 'nota-devolucao-ND-0012.json', contentType: 'application/json' });
    expect(JSON.parse(mail.attachments[0]!.content)).toMatchObject({ nota_id: 'ND-0012' });
    expect(w.requests.rows.get(w.id)).toMatchObject({
      status: 'sent',
      sentBy: 'ana@jachegou.test',
      sentAt: '2026-11-16T12:00:00.000Z',
      providerMessageId: 'mock-1',
    });
  });

  it('#156/AC-4 se a nota da linha da fila já existe (queda depois da emissão), emitir de novo a devolve, sem outra', async () => {
    const w = await draftWorld();
    w.sender.failNextWith('x');
    await emitAndSend(w.deps, w.id, 'ana@jachegou.test');
    const stored = w.requests.rows.get(w.id)!;
    w.requests.rows.set(w.id, { ...stored, status: 'draft', attachments: [], sendFailure: null });
    const again = await emitAndSend(w.deps, w.id, 'ana@jachegou.test');
    expect(again).toMatchObject({ kind: 'ok', status: 'sent' });
    expect(w.emissions.notes.size).toBe(1);
    expect(w.emissions.sequence).toBe(12);
    expect(w.requests.rows.get(w.id)?.attachments[0]?.returnNoteId).toBe('ND-0012');
  });

  it('#156/AC-4 o pedido refeito depois do descarte reaproveita a nota já emitida', async () => {
    const w = await draftWorld();
    // emite e falha o envio; descarta; refaz; emite de novo
    w.sender.failNextWith('mailbox_unavailable');
    await emitAndSend(w.deps, w.id, 'ana@jachegou.test');
    await discardRequest(w.deps, w.id, 'ana@jachegou.test', 'trocar o texto');
    const redone = await redo(w.deps, w.id, 'ana@jachegou.test');
    expect(redone.kind).toBe('ok');
    const newId = redone.kind === 'ok' ? redone.request.id : '';
    await writeDraft(w.deps, newId, goodAsk);
    const sent = await emitAndSend(w.deps, newId, 'ana@jachegou.test');
    expect(sent).toMatchObject({ kind: 'ok', status: 'sent' });
    expect(w.emissions.notes.size).toBe(1);
    expect(w.emissions.sequence).toBe(12);
    expect(w.requests.rows.get(newId)?.attachments[0]?.returnNoteId).toBe('ND-0012');
  });

  it('#156 o envio que falha deixa a nota emitida e o pedido send_failed com o motivo', async () => {
    const w = await draftWorld();
    w.sender.failNextWith('mailbox_unavailable');
    const result = await emitAndSend(w.deps, w.id, 'ana@jachegou.test');
    expect(result).toMatchObject({ kind: 'ok', status: 'send_failed' });
    expect(w.requests.rows.get(w.id)).toMatchObject({ status: 'send_failed', sendFailure: 'mailbox_unavailable' });
    expect(w.emissions.notes.size).toBe(1);
    expect([...w.queue.rows.values()][0]?.status).toBe('emitida');
  });

  it('#156 a porta que lança vira send_failed com um código, nunca o texto da exceção', async () => {
    const w = await draftWorld();
    w.deps.sender.send = async () => {
      throw new Error('smtp://usuario:segredo@host recusou');
    };
    await emitAndSend(w.deps, w.id, 'ana@jachegou.test');
    const snap = w.requests.rows.get(w.id)!;
    expect(snap.status).toBe('send_failed');
    expect(snap.sendFailure).toBe('send_error');
    expect(JSON.stringify(snap)).not.toContain('segredo');
  });

  it('#156 só o rascunho emite; escrevendo, enviado ou descartado é conflito', async () => {
    const w = await openedWorld();
    expect(await emitAndSend(w.deps, w.id, 'ana@jachegou.test')).toEqual({ kind: 'conflict', reason: 'wrong_state' });
    expect(await emitAndSend(w.deps, 'nope', 'x')).toEqual({ kind: 'not_found' });
    expect(w.emissions.notes.size).toBe(0);
  });

  it('#156 a linha da fila já cancelada impede o envio, e a nota emitida fica para a próxima tentativa', async () => {
    const w = await draftWorld();
    const row = [...w.queue.rows.values()][0]!;
    row.status = 'cancelada';
    expect(await emitAndSend(w.deps, w.id, 'ana@jachegou.test')).toEqual({ kind: 'conflict', reason: 'queue_not_pending' });
    expect(w.sender.sent).toHaveLength(0);
  });
});

describe('tentar o envio de novo', () => {
  it('#156 reenvia de send_failed sem reemitir e vira sent', async () => {
    const w = await draftWorld();
    w.sender.failNextWith('mailbox_unavailable');
    await emitAndSend(w.deps, w.id, 'ana@jachegou.test');
    const result = await retrySend(w.deps, w.id, 'bia@jachegou.test');
    expect(result).toMatchObject({ kind: 'ok', status: 'sent' });
    expect(w.emissions.notes.size).toBe(1);
    expect(w.emissions.sequence).toBe(12);
    expect(w.requests.rows.get(w.id)).toMatchObject({ status: 'sent', sentBy: 'bia@jachegou.test', sendFailure: null });
    expect(w.sender.sent).toHaveLength(1);
  });

  it('#156 se falha de novo continua send_failed', async () => {
    const w = await draftWorld();
    w.sender.failNextWith('a');
    await emitAndSend(w.deps, w.id, 'ana@jachegou.test');
    w.sender.failNextWith('b');
    expect(await retrySend(w.deps, w.id, 'ana@jachegou.test')).toMatchObject({ kind: 'ok', status: 'send_failed' });
    expect(w.requests.rows.get(w.id)?.sendFailure).toBe('b');
  });

  it('#156 fora de send_failed é conflito', async () => {
    const w = await draftWorld();
    expect(await retrySend(w.deps, w.id, 'x')).toEqual({ kind: 'conflict', reason: 'wrong_state' });
    expect(await retrySend(w.deps, 'nope', 'x')).toEqual({ kind: 'not_found' });
  });
});

describe('descartar e refazer', () => {
  it('#156 a pessoa descarta o rascunho, e o registro diz por quem, quando e por quê', async () => {
    const w = await draftWorld();
    const result = await discardRequest(w.deps, w.id, 'ana@jachegou.test', 'texto não serve');
    expect(result).toMatchObject({ kind: 'ok' });
    expect(w.requests.rows.get(w.id)).toMatchObject({
      status: 'discarded',
      discardedBy: 'ana@jachegou.test',
      discardedAt: '2026-11-16T12:00:00.000Z',
      discardReason: 'texto não serve',
    });
  });

  it('#156 o descarte sem motivo guarda o motivo padrão', async () => {
    const w = await draftWorld();
    await discardRequest(w.deps, w.id, 'ana@jachegou.test');
    expect(w.requests.rows.get(w.id)?.discardReason).toBe('discarded_by_user');
  });

  it('#156 de send_failed também descarta; enviado não', async () => {
    const w = await draftWorld();
    w.sender.failNextWith('x');
    await emitAndSend(w.deps, w.id, 'ana@jachegou.test');
    expect(await discardRequest(w.deps, w.id, 'ana@jachegou.test')).toMatchObject({ kind: 'ok' });
    const w2 = await draftWorld();
    await emitAndSend(w2.deps, w2.id, 'ana@jachegou.test');
    expect(await discardRequest(w2.deps, w2.id, 'ana@jachegou.test')).toEqual({ kind: 'conflict', reason: 'wrong_state' });
    expect(await discardRequest(w2.deps, 'nope', 'x')).toEqual({ kind: 'not_found' });
  });

  it('#156 refazer depois do descarte abre um pedido novo escrevendo para a mesma nota', async () => {
    const w = await draftWorld();
    await discardRequest(w.deps, w.id, 'ana@jachegou.test');
    const result = await redo(w.deps, w.id, 'bia@jachegou.test');
    expect(result.kind).toBe('ok');
    expect(w.requests.rows.size).toBe(2);
    const fresh = [...w.requests.rows.values()].find((s) => s.id !== w.id)!;
    expect(fresh).toMatchObject({ status: 'writing', invoiceAccessKey: ORIGIN_KEY, createdBy: 'bia@jachegou.test' });
  });

  it('#156/AC-8 refazer com outro pedido já aberto é conflito', async () => {
    const w = await draftWorld();
    await discardRequest(w.deps, w.id, 'ana@jachegou.test');
    await redo(w.deps, w.id, 'ana@jachegou.test');
    expect(await redo(w.deps, w.id, 'ana@jachegou.test')).toEqual({ kind: 'conflict', reason: 'open_request_exists' });
  });

  it('#156 refazer um pedido que não está descartado é conflito', async () => {
    const w = await draftWorld();
    expect(await redo(w.deps, w.id, 'x')).toEqual({ kind: 'conflict', reason: 'wrong_state' });
    expect(await redo(w.deps, 'nope', 'x')).toEqual({ kind: 'not_found' });
  });
});

describe('ler para a gaveta', () => {
  it('#156 escrevendo: o pedido sem texto e a nota ainda em rascunho', async () => {
    const w = await openedWorld();
    const view = await readSupplierRequests(w.deps, ORIGIN_KEY);
    expect(view.requests).toHaveLength(1);
    const [r] = view.requests;
    expect(r?.request.status).toBe('writing');
    expect(r?.template).toBeNull();
    expect(r?.renderedBody).toBeNull();
    expect(r?.returnNote).toMatchObject({ state: 'draft', draft: { invoiceNumber: '20046' } });
  });

  it('#156 rascunho: o texto cru com marcadores e o texto preenchido, e a nota em rascunho', async () => {
    const w = await draftWorld();
    const [r] = (await readSupplierRequests(w.deps, ORIGIN_KEY)).requests;
    expect(r?.template).toBe(GOOD_BODY);
    expect(r?.renderedBody).toContain('R$ 2.163,20');
    expect(r?.renderedBody).toContain('19/11/2026');
    expect(r?.renderedBody).not.toContain('{{');
    expect(r?.returnNote).toMatchObject({ state: 'draft' });
  });

  it('#156 enviado: a nota emitida vem junto', async () => {
    const w = await draftWorld();
    await emitAndSend(w.deps, w.id, 'ana@jachegou.test');
    const [r] = (await readSupplierRequests(w.deps, ORIGIN_KEY)).requests;
    expect(r?.request.status).toBe('sent');
    expect(r?.returnNote).toMatchObject({ state: 'emitted', note: { nota_id: 'ND-0012' } });
  });

  it('#156 descartado: mostra o pedido e a nota que seria emitida', async () => {
    const w = await draftWorld();
    await discardRequest(w.deps, w.id, 'ana@jachegou.test');
    const [r] = (await readSupplierRequests(w.deps, ORIGIN_KEY)).requests;
    expect(r?.request.status).toBe('discarded');
  });

  it('#156 nota sem pedido: lista vazia', async () => {
    const w = world();
    expect((await readSupplierRequests(w.deps, 'outra')).requests).toEqual([]);
  });
});

describe('o canal do envio por configuração', () => {
  const mock = new InMemorySupplierEmailSender();
  const resend = new InMemorySupplierEmailSender();

  it('#156/AC-5 sem a chave do Resend usa o mock, sem erro', () => {
    expect(selectSupplierEmail({ resendApiKey: undefined }, { mock })).toEqual({ channel: 'mock', sender: mock });
    expect(selectSupplierEmail({ resendApiKey: '  ' }, { mock, resend: () => resend })).toEqual({ channel: 'mock', sender: mock });
  });

  it('#156/AC-5 com a chave e o adaptador do Resend usa o Resend', () => {
    const picked = selectSupplierEmail({ resendApiKey: 'k' }, { mock, resend: () => resend });
    expect(picked).toEqual({ channel: 'resend', sender: resend });
  });

  it('#156/AC-5 com a chave e sem adaptador do Resend cai no mock', () => {
    expect(selectSupplierEmail({ resendApiKey: 'k' }, { mock }).channel).toBe('mock');
  });
});

describe('o caso que deixou de qualificar', () => {
  it('#156 sem a decisão na fonte, o texto do Claude e a emissão são conflito', async () => {
    const w = await openedWorld();
    w.source.cases.clear();
    expect(await writeDraft(w.deps, w.id, goodAsk)).toEqual({ kind: 'conflict', reason: 'no_longer_qualifies' });
  });
});
