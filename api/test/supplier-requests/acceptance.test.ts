import { describe, expect, it } from 'vitest';
import { brl, buildWorld, decide, rewrittenBody, fakeAsk, goodBody, E2_NUMBER, E3_NUMBER, ANALYST, type World } from './http-world.js';

// #156 Aceite do pedido ao fornecedor: cada critério é um cenário Given/When/Then contra o Worker montado,
// com o PostgREST falso e o Claude falso (nunca a rede). O token #156/AC-n liga o teste ao critério.

type Item = { supplierCode: string; sku: string | null; description: string; quantity: { amount: number; unit: string }; unitPriceCents: number; valueCents: number };
type View = {
  id: string;
  status: string;
  to: string;
  subject: string;
  asks: string[];
  body: string | null;
  template: string | null;
  dueOn: string | null;
  channel: string;
  providerMessageId: string | null;
  sendFailure: string | null;
  discardReason: string | null;
  discardedBy: string | null;
  sentBy: string | null;
  editedBy: string | null;
  attachments: { kind: string; returnNoteId: string; filename: string }[];
  returnNote: { state: 'draft'; items: Item[]; totalCents: number } | { state: 'emitted'; note: Record<string, unknown> & { numero: number; valor_total: number; itens: unknown[] } } | null;
};

const LINES = 40;
const listOf = async (w: World, key: string): Promise<View[]> =>
  ((await (await w.call(`/api/pedidos-fornecedor?nota=${key}`)).json()) as { requests: View[] }).requests;
const post = (w: World, id: string, action: string, body?: unknown) => w.call(`/api/pedidos-fornecedor/${id}/${action}`, 'POST', body);

/** #156 Dado uma proposta E2 decidida com receber parcial devolvendo 40 UN do primeiro item da nota de origem. */
async function e2World(options: Parameters<typeof buildWorld>[0] = {}) {
  const w = await buildWorld(options);
  const decided = decide(w.fake, 'E2', E2_NUMBER, LINES);
  const code = String(decided.item.supplierCode);
  const unitCents = Number(decided.item.unitPriceCents);
  return { w, ...decided, code, unitCents, totalCents: unitCents * LINES, ask: fakeAsk(goodBody(code)) };
}

/** #156 E o rascunho já escrito pelo Cron. */
async function drafted() {
  const world = await e2World();
  await world.w.cron(world.ask);
  const [request] = await listOf(world.w, world.key);
  return { ...world, request: request! };
}

describe('#156 pedido ao fornecedor: aceite', () => {
  it('#156/AC-1 E2 e E3 decididas ganham um pedido: escrevendo depois da decisão e rascunho depois do Claude', async () => {
    const w = await buildWorld();
    const e2 = decide(w.fake, 'E2', E2_NUMBER, LINES);
    const e3 = decide(w.fake, 'E3', E3_NUMBER, 2);
    // #156 When o Cron abre os pedidos, sem o Claude (um por rodada: o teto de subrequests do Worker)
    expect(await w.cron()).toMatchObject({ opened: 1, drafted: 0, wrote: false });
    expect(await w.cron()).toMatchObject({ opened: 1, drafted: 0, wrote: false });
    // #156 Then cada nota tem um pedido escrevendo, sem texto
    for (const key of [e2.key, e3.key]) {
      const [request] = await listOf(w, key);
      expect(request).toMatchObject({ status: 'writing', body: null, template: null });
    }
    // #156 When o Claude escreve na rodada seguinte
    const ask = fakeAsk((prompt) => (prompt.includes(String(e2.item.supplierCode)) ? goodBody(String(e2.item.supplierCode)) : goodBody(String(e3.item.supplierCode))));
    expect(await w.cron(ask)).toMatchObject({ opened: 0, drafted: 1, wrote: true });
    expect(await w.cron(ask)).toMatchObject({ opened: 0, drafted: 1, wrote: true });
    // #156 Then os dois viram rascunho
    for (const key of [e2.key, e3.key]) expect((await listOf(w, key))[0]?.status).toBe('draft');
  });

  it('#156/AC-2 a nota tem só a linha devolvida, o preço da nota de origem e o valor_total da fila da #140', async () => {
    const { w, key, code, request, unitCents, totalCents } = await drafted();
    expect(request.returnNote).toMatchObject({ state: 'draft', totalCents });
    const draft = request.returnNote as { items: Item[] };
    expect(draft.items).toHaveLength(1);
    expect(draft.items[0]).toMatchObject({ supplierCode: code, quantity: { amount: LINES }, unitPriceCents: unitCents, valueCents: totalCents });
    const queue = (await (await w.call('/api/return-notes')).json()) as { notes: { invoiceAccessKey: string; valueCents: number }[] };
    expect(queue.notes.filter((n) => n.invoiceAccessKey === key)).toMatchObject([{ valueCents: totalCents }]);
    // #156 E depois de emitida a nota segue o formato do kit, cita a nota de origem e fecha com a fila
    const sent = (await (await post(w, request.id, 'emitir-e-enviar')).json()) as { note: { nota_referenciada: string; natureza: string; valor_total: number; itens: { quantidade: number; valor: number }[] } };
    expect(sent.note).toMatchObject({ nota_referenciada: key, natureza: 'devolucao', valor_total: totalCents / 100 });
    expect(sent.note.itens).toMatchObject([{ quantidade: LINES, valor: totalCents / 100 }]);
  });

  it('#156/AC-3 nada é emitido nem enviado até alguém chamar emitir-e-enviar', async () => {
    const { w, key, request } = await drafted();
    await w.cron(fakeAsk('x'));
    expect(w.fake.rows('return_note_emissions')).toHaveLength(0);
    expect(w.fake.rows('outbox_supplier_emails')).toHaveLength(0);
    expect(w.fake.rows('outbox_return_notes')[0]).toMatchObject({ status: 'pendente' });
    expect((await listOf(w, key))[0]?.status).toBe('draft');
    // #156 When a pessoa clica
    const response = await post(w, request.id, 'emitir-e-enviar');
    // #156 Then sai
    expect(response.status).toBe(200);
    expect(w.fake.rows('outbox_supplier_emails')).toHaveLength(1);
  });

  it('#156/AC-4 emitir marca a linha da fila #140 como emitida com o número da ND', async () => {
    const { w, request } = await drafted();
    const first = await post(w, request.id, 'emitir-e-enviar');
    const body = (await first.json()) as { status: string; note: { numero: number; chave: string; nota_id: string } };
    expect(first.status).toBe(200);
    expect(body.status).toBe('sent');
    expect(body.note.chave).toMatch(/^\d{44}$/);
    const emitted = (await (await w.call('/api/return-notes?status=emitida')).json()) as { notes: { emitted: { number: string; by: string } }[] };
    expect(emitted.notes).toMatchObject([{ emitted: { number: String(body.note.numero), by: ANALYST } }]);
    expect(w.fake.rows('return_note_emissions')).toHaveLength(1);
  });

  it('#156/AC-4 emitir de novo a mesma devolução (refazer depois do envio falho) devolve a mesma nota, sem outra', async () => {
    const world = await e2World({ failOutbox: { remaining: 1 } });
    const { w } = world;
    await w.cron(world.ask);
    const [first] = await listOf(w, world.key);
    const failed = (await (await post(w, first!.id, 'emitir-e-enviar')).json()) as { status: string; note: { nota_id: string; chave: string } };
    expect(failed.status).toBe('send_failed');
    await post(w, first!.id, 'descartar');
    const fresh = (await (await post(w, first!.id, 'refazer')).json()) as { request: View };
    await w.cron(world.ask);
    // #156 When emite de novo a mesma devolução
    const again = (await (await post(w, fresh.request.id, 'emitir-e-enviar')).json()) as { status: string; note: { nota_id: string; chave: string } };
    // #156 Then é a mesma nota e a fila só tem uma emissão
    expect(again.status).toBe('sent');
    expect(again.note).toMatchObject({ nota_id: failed.note.nota_id, chave: failed.note.chave });
    expect(w.fake.rows('return_note_emissions')).toHaveLength(1);
  });

  it('#156/AC-5 sem a chave do Resend o e-mail sai pela caixa mock e guarda o id do envio', async () => {
    const { w, request } = await drafted();
    const body = (await (await post(w, request.id, 'emitir-e-enviar')).json()) as { request: View };
    expect(body.request).toMatchObject({ status: 'sent', channel: 'mock', sentBy: ANALYST });
    const [mail] = w.fake.rows('outbox_supplier_emails');
    expect(mail).toMatchObject({ request_id: request.id, to_address: request.to });
    expect(body.request.providerMessageId).toBe(mail?.provider_message_id);
    expect(String(mail?.body)).not.toContain('{{');
    expect((mail?.attachments as { filename: string }[])[0]?.filename).toMatch(/^nota-devolucao-ND-.*\.json$/);
  });

  it('#156/AC-6 um número fora do catálogo descarta o rascunho e registra o motivo', async () => {
    const { w, key } = await e2World();
    await w.cron(fakeAsk('Olá. Devolvemos 12345 unidades na NF {{nota.numero}}.'));
    const [request] = await listOf(w, key);
    expect(request).toMatchObject({ status: 'discarded', discardReason: 'number_mismatch', discardedBy: 'system', body: null });
  });

  it('#156/AC-7 editar muda só o texto; um número trocado dá 422 e nada muda', async () => {
    const { w, key, request, code } = await drafted();
    const text = rewrittenBody(code);
    const edited = await post(w, request.id, 'editar', { text });
    expect(edited.status).toBe(200);
    const [after] = await listOf(w, key);
    expect(after).toMatchObject({ template: text, editedBy: ANALYST, asks: request.asks, returnNote: request.returnNote, to: request.to, subject: request.subject });
    const loose = await post(w, request.id, 'editar', { text: 'Devolvemos 999 unidades da NF {{nota.numero}}.' });
    expect(loose.status).toBe(422);
    expect(await loose.json()).toMatchObject({ error: 'invalid' });
    expect((await listOf(w, key))[0]?.template).toBe(text);
  });

  it('#156/AC-8 não nasce um segundo pedido aberto, e refazer com um aberto dá 409', async () => {
    const { w, key, request } = await drafted();
    const again = await w.cron(fakeAsk('x'));
    expect(again.opened).toBe(0);
    expect(await listOf(w, key)).toHaveLength(1);
    const redo = await post(w, request.id, 'refazer');
    expect(redo.status).toBe(409);
    expect(await redo.json()).toEqual({ error: 'conflict', reason: 'wrong_state' });
    // #156 E com o pedido descartado, outro aberto bloqueia o refazer do primeiro
    await post(w, request.id, 'descartar');
    const fresh = (await (await post(w, request.id, 'refazer')).json()) as { request: View };
    expect(fresh.request.status).toBe('writing');
    const second = await post(w, request.id, 'refazer');
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'conflict', reason: 'open_request_exists' });
  });
});

describe('#156 pedido ao fornecedor: o que mais a API faz', () => {
  it('o envio que falha deixa a nota emitida e send_failed; reenviar envia sem reemitir', async () => {
    const world = await e2World({ failOutbox: { remaining: 1 } });
    await world.w.cron(world.ask);
    const [request] = await listOf(world.w, world.key);
    const failed = await post(world.w, request!.id, 'emitir-e-enviar');
    const failedBody = (await failed.json()) as { status: string; request: View; note: { numero: number } };
    expect(failed.status).toBe(200);
    expect(failedBody).toMatchObject({ status: 'send_failed', request: { status: 'send_failed', sendFailure: 'send_error' } });
    expect(JSON.stringify(failedBody)).not.toContain('SEGREDO-DO-PROVEDOR');
    const retried = (await (await post(world.w, request!.id, 'reenviar')).json()) as { status: string; note: { numero: number } };
    expect(retried.status).toBe('sent');
    expect(retried.note.numero).toBe(failedBody.note.numero);
    expect(world.w.fake.rows('return_note_emissions')).toHaveLength(1);
    expect(world.w.fake.rows('outbox_supplier_emails')).toHaveLength(1);
  });

  it('descartar guarda quem, quando e o motivo cortado; descartar de novo dá 409', async () => {
    const { w, request } = await drafted();
    const response = await post(w, request.id, 'descartar', { reason: `  ${'x'.repeat(600)}  ` });
    const body = (await response.json()) as { request: View };
    expect(response.status).toBe(200);
    expect(body.request).toMatchObject({ status: 'discarded', discardedBy: ANALYST });
    expect(body.request.discardReason).toBe('x'.repeat(500));
    expect((await post(w, request.id, 'descartar')).status).toBe(409);
  });

  it('um corpo JSON malformado vale corpo vazio: descartar usa o motivo padrão', async () => {
    const { w, request } = await drafted();
    const response = await post(w, request.id, 'descartar', '{não é json');
    expect(((await response.json()) as { request: View }).request.discardReason).toBe('discarded_by_user');
  });

  it('o autor da ação é o e-mail do Access, nunca o corpo', async () => {
    const { w, request } = await drafted();
    const response = await post(w, request.id, 'descartar', { reason: 'r', by: 'intruso@x.test', discardedBy: 'intruso@x.test' });
    expect(((await response.json()) as { request: View }).request.discardedBy).toBe(ANALYST);
  });

  it('sem e-mail na identidade as ações respondem 403 e nada muda', async () => {
    const world = await buildWorld({ email: null });
    const decided = decide(world.fake, 'E2', E2_NUMBER, LINES);
    await world.cron(fakeAsk(goodBody(String(decided.item.supplierCode))));
    const [request] = await listOf(world, decided.key);
    const response = await post(world, request!.id, 'descartar');
    expect(response.status).toBe(403);
    expect((await listOf(world, decided.key))[0]?.status).toBe('draft');
  });

  it('sem credencial do Claude o Cron abre os pedidos e não escreve; o Claude que falha deixa o pedido escrevendo', async () => {
    const world = await e2World();
    expect(await world.w.cron(undefined)).toMatchObject({ opened: 1, wrote: false });
    const failing = (async () => {
      throw new Error('SEGREDO-DO-CLAUDE');
    }) as never;
    const round = await world.w.cron(failing);
    expect(round).toMatchObject({ drafted: 0, failed: 1 });
    expect((await listOf(world.w, world.key))[0]?.status).toBe('writing');
  });

  it('a pessoa descarta o pedido escrevendo e a rodada seguinte não o escreve', async () => {
    const world = await e2World();
    await world.w.cron();
    const [request] = await listOf(world.w, world.key);
    expect((await post(world.w, request!.id, 'descartar')).status).toBe(200);
    expect(await world.w.cron(world.ask)).toMatchObject({ drafted: 0 });
    expect(world.ask.calls).toHaveLength(0);
  });
});

describe('#156 recusa com mercadoria já entrada (decisão do grupo)', () => {
  it('#156/AC-1 a recusa depois da entrada ganha o pedido de retirada, e emitir e enviar funciona', async () => {
    const w = await buildWorld();
    const d = decide(w.fake, 'E2', E2_NUMBER, LINES);
    const proposal = w.fake.rows('proposals').find((p) => p.invoice_access_key === d.key && p.classification === 'E2')!;
    proposal.dock_action = { kind: 'recusar' };
    const round = await w.cron(fakeAsk(goodBody(String(d.item.supplierCode))));
    const [request] = await listOf(w, d.key);
    expect(round.opened).toBe(1);
    expect(request).toMatchObject({ status: 'draft', asks: ['Retirar a mercadoria'] });
    const sent = await post(w, request.id, 'emitir-e-enviar');
    expect(sent.status).toBe(200);
    expect(((await sent.json()) as { status: string }).status).toBe('sent');
  });
});
