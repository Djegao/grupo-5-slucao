import { describe, expect, it } from 'vitest';
import { ANALYST, brl, rewrittenBody, E2_NUMBER, ENV, buildWorld, decide, fakeAsk, goodBody, type World } from './http-world.js';

// #156 Contrato da API do pedido ao fornecedor: o formato do JSON e o código de cada rota. O contrato é
// escrito aqui, à mão (api/src/http/supplier-requests.ts, cabeçalho); o código é validado contra ele.

const VIEW_FIELDS = {
  id: 'string',
  invoiceAccessKey: 'string',
  supplierId: 'string',
  requestType: 'string',
  status: 'string',
  to: 'string',
  subject: 'string',
  asks: 'array',
  body: 'string|null',
  template: 'string|null',
  dueOn: 'string|null',
  channel: 'string',
  model: 'string|null',
  draftedAt: 'string|null',
  createdAt: 'string',
  createdBy: 'string',
  updatedAt: 'string',
  updatedBy: 'string',
  editedAt: 'string|null',
  editedBy: 'string|null',
  sentAt: 'string|null',
  sentBy: 'string|null',
  providerMessageId: 'string|null',
  sendFailure: 'string|null',
  discardedAt: 'string|null',
  discardedBy: 'string|null',
  discardReason: 'string|null',
  attachments: 'array',
  returnNote: 'object|null',
} as const;

const typeOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

function expectView(view: Record<string, unknown>): void {
  expect(Object.keys(view).sort()).toEqual(Object.keys(VIEW_FIELDS).sort());
  for (const [field, types] of Object.entries(VIEW_FIELDS)) {
    expect(types.split('|'), `${field}: ${typeOf(view[field])}`).toContain(typeOf(view[field]));
  }
}

const post = (w: World, id: string, action: string, body?: unknown) => w.call(`/api/pedidos-fornecedor/${id}/${action}`, 'POST', body);
const NOTA = '1'.repeat(44);

async function setup() {
  const w = await buildWorld();
  const decided = decide(w.fake, 'E2', E2_NUMBER, 40);
  const code = String(decided.item.supplierCode);
  const unitCents = Number(decided.item.unitPriceCents);
  return { w, ...decided, code, unitCents, totalCents: unitCents * 40 };
}
const first = async (w: World, key: string) =>
  ((await (await w.call(`/api/pedidos-fornecedor?nota=${key}`)).json()) as { requests: Record<string, unknown>[] }).requests[0]!;

describe('#156 contrato: SupplierRequestView', () => {
  it('escrevendo, rascunho, enviado e descartado têm sempre os mesmos campos e tipos', async () => {
    const { w, key, code, unitCents, totalCents } = await setup();
    await w.cron();
    const writing = await first(w, key);
    expectView(writing);
    expect(writing).toMatchObject({ status: 'writing', body: null, template: null, returnNote: { state: 'draft' } });
    await w.cron(fakeAsk(goodBody(code)));
    const draft = await first(w, key);
    expectView(draft);
    expect(draft.returnNote).toMatchObject({
      state: 'draft',
      totalCents,
      items: [{ supplierCode: code, sku: expect.any(String), description: expect.any(String), quantity: { amount: 40, unit: 'UN' }, unitPriceCents: unitCents, valueCents: totalCents }],
    });
    expect(Object.keys(draft.returnNote as object).sort()).toEqual(['items', 'state', 'totalCents']);
    expect(draft.template).toContain('{{nota.numero}}');
    expect(draft.body).not.toContain('{{');
    const sent = (await (await post(w, String(draft.id), 'emitir-e-enviar')).json()) as { status: string; request: Record<string, unknown>; note: Record<string, unknown> };
    expect(Object.keys(sent).sort()).toEqual(['note', 'request', 'status']);
    expectView(sent.request);
    expect(sent.request).toMatchObject({ status: 'sent', returnNote: { state: 'emitted', note: sent.note } });
    expect(Object.keys(sent.note).sort()).toEqual(
      ['chave', 'data_emissao', 'destino', 'emitente', 'fornecedor_id', 'itens', 'natureza', 'nota_id', 'nota_referenciada', 'numero', 'serie', 'valor_total'],
    );
    expect(sent.request.attachments).toMatchObject([{ kind: 'return_note', returnNoteId: sent.note.nota_id, filename: expect.stringMatching(/\.json$/) }]);
  });

  it('o descartado também tem o mesmo formato', async () => {
    const { w, key } = await setup();
    await w.cron();
    const request = await first(w, key);
    const discarded = (await (await post(w, String(request.id), 'descartar', { reason: 'não vale' })).json()) as { request: Record<string, unknown> };
    expectView(discarded.request);
    expect(discarded.request).toMatchObject({ status: 'discarded', discardedBy: ANALYST, discardReason: 'não vale' });
  });
});

describe('#156 contrato: códigos de cada rota', () => {
  it('GET /api/pedidos-fornecedor: 200, 400 invalid_nota, 405 com Allow, 401 sem token, 503 sem Supabase', async () => {
    const { w } = await setup();
    const ok = await w.call(`/api/pedidos-fornecedor?nota=${NOTA}`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ requests: [] });
    for (const nota of ['', '123', `${NOTA}0`, 'a'.repeat(44)]) {
      const bad = await w.call(`/api/pedidos-fornecedor?nota=${nota}`);
      expect(bad.status).toBe(400);
      expect(await bad.json()).toEqual({ error: 'invalid_nota' });
    }
    expect((await w.call('/api/pedidos-fornecedor')).status).toBe(400);
    const wrong = await w.call(`/api/pedidos-fornecedor?nota=${NOTA}`, 'POST', {});
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('Allow')).toBe('GET');
    expect((await w.call(`/api/pedidos-fornecedor?nota=${NOTA}`, 'GET', undefined, ENV, false)).status).toBe(401);
    const { BARTE_ACADEMY_SUPABASE_URL: _url, ...noSupabase } = ENV;
    const off = await w.call(`/api/pedidos-fornecedor?nota=${NOTA}`, 'GET', undefined, noSupabase);
    expect(off.status).toBe(503);
    expect(await off.json()).toEqual({ error: 'supabase_not_configured' });
  });

  it('as rotas de ação: 405 com Allow POST no método errado e 401 sem token', async () => {
    const { w } = await setup();
    for (const action of ['editar', 'emitir-e-enviar', 'reenviar', 'descartar', 'refazer']) {
      const wrong = await w.call(`/api/pedidos-fornecedor/req-1/${action}`, 'GET');
      expect(wrong.status, action).toBe(405);
      expect(wrong.headers.get('Allow')).toBe('POST');
      expect((await w.call(`/api/pedidos-fornecedor/req-1/${action}`, 'POST', {}, ENV, false)).status, action).toBe(401);
    }
  });

  it('as rotas de ação: 404 not_found para um pedido que não existe ou um id fora do formato', async () => {
    const { w } = await setup();
    for (const action of ['editar', 'emitir-e-enviar', 'reenviar', 'descartar', 'refazer']) {
      for (const id of ['nao-existe', 'a%2Fb', 'x'.repeat(80)]) {
        const response = await post(w, id, action, { text: 'olá' });
        expect(response.status, `${action} ${id}`).toBe(404);
        expect(await response.json()).toEqual({ error: 'not_found' });
      }
    }
  });

  it('409 conflict com reason: o estado do pedido não permite a ação', async () => {
    const { w, key, code } = await setup();
    await w.cron();
    const writing = String((await first(w, key)).id);
    for (const [action, body] of [['editar', { text: 'olá' }], ['emitir-e-enviar'], ['reenviar'], ['refazer']] as const) {
      const response = await post(w, writing, action, body);
      expect(response.status, action).toBe(409);
      expect(await response.json()).toEqual({ error: 'conflict', reason: 'wrong_state' });
    }
    await w.cron(fakeAsk(goodBody(code)));
    expect((await post(w, writing, 'reenviar')).status).toBe(409);
    expect((await post(w, writing, 'refazer')).status).toBe(409);
  });

  it('422 invalid com reason na edição: texto vazio, número solto ou marcador trocado', async () => {
    const { w, key, code } = await setup();
    await w.cron(fakeAsk(goodBody(code)));
    const id = String((await first(w, key)).id);
    for (const text of ['   ', 'Devolvemos 77 unidades.', 'Olá {{devolucao.valor_total}} e {{marcador.que.nao.existe}}']) {
      const response = await post(w, id, 'editar', { text });
      expect(response.status, text).toBe(422);
      expect(await response.json()).toEqual({ error: 'invalid', reason: expect.any(String) });
    }
    expect((await post(w, id, 'editar', {})).status).toBe(422);
  });

  it('200 editar devolve { request } com o texto novo e o corpo preenchido', async () => {
    const { w, key, code, totalCents } = await setup();
    await w.cron(fakeAsk(goodBody(code)));
    const id = String((await first(w, key)).id);
    const text = rewrittenBody(code);
    const response = await post(w, id, 'editar', { text });
    expect(response.status).toBe(200);
    const { request } = (await response.json()) as { request: Record<string, unknown> };
    expectView(request);
    expect(request).toMatchObject({ template: text });
    expect(request.body).toContain(`total ${brl(totalCents)}.`);
    expect(request.body).not.toContain('{{');
  });

  it('refazer devolve 200 { request } do pedido novo, escrevendo', async () => {
    const { w, key } = await setup();
    await w.cron();
    const id = String((await first(w, key)).id);
    await post(w, id, 'descartar');
    const response = await post(w, id, 'refazer');
    expect(response.status).toBe(200);
    const { request } = (await response.json()) as { request: Record<string, unknown> };
    expectView(request);
    expect(request).toMatchObject({ status: 'writing', createdBy: ANALYST });
    expect(request.id).not.toBe(id);
  });

  it('502 sem detalhe quando o Supabase falha: erro genérico e identificador de correlação, nunca o texto do provedor', async () => {
    const { w, key } = await setup();
    await w.cron();
    const id = String((await first(w, key)).id);
    w.broken.add('supplier_requests');
    const responses = [await w.call(`/api/pedidos-fornecedor?nota=${key}`), await post(w, id, 'descartar'), await post(w, id, 'emitir-e-enviar')];
    for (const response of responses) {
      expect(response.status).toBe(502);
      const text = await response.text();
      expect(text).not.toContain('SEGREDO-DO-PROVEDOR');
      expect(text).not.toContain('supplier_requests');
      expect(JSON.parse(text)).toEqual({ error: 'supabase_unavailable', correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    }
  });
});
