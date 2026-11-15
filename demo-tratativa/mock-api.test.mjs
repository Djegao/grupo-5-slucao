// #156 Testes da API falsa da demonstração: ela tem de seguir o contrato de api/src/http/supplier-requests.ts.
// Rodar: node --test demo-tratativa/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockApi, DEMO_KEY } from './mock-api.js';

const list = async (api) => (await api.call('GET', `/api/pedidos-fornecedor?nota=${DEMO_KEY}`)).body.requests;

test('#156/AC-3 o rascunho não emite nem envia sem o clique em emitir-e-enviar', async () => {
  const api = createMockApi();
  const [r] = await list(api);
  assert.equal(r.status, 'draft');
  assert.equal(r.returnNote.state, 'draft');
  assert.equal(r.sentAt, null);
});

test('chave fora de 44 dígitos dá 400 invalid_nota', async () => {
  const api = createMockApi();
  const res = await api.call('GET', '/api/pedidos-fornecedor?nota=123');
  assert.deepEqual(res, { status: 400, body: { error: 'invalid_nota' } });
});

test('#156/AC-4 emitir-e-enviar emite a nota, envia e não deixa emitir de novo', async () => {
  const api = createMockApi();
  const [r] = await list(api);
  const res = await api.call('POST', `/api/pedidos-fornecedor/${r.id}/emitir-e-enviar`);
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'sent');
  assert.equal(res.body.request.returnNote.state, 'emitted');
  assert.equal(res.body.note.nota_id, 'ND-0012');
  const again = await api.call('POST', `/api/pedidos-fornecedor/${r.id}/emitir-e-enviar`);
  assert.deepEqual(again, { status: 409, body: { error: 'conflict', reason: 'wrong_state' } });
});

test('falha no envio, depois reenviar manda sem reemitir', async () => {
  const api = createMockApi({ scenario: 'send-fails' });
  const [r] = await list(api);
  const first = await api.call('POST', `/api/pedidos-fornecedor/${r.id}/emitir-e-enviar`);
  assert.equal(first.body.status, 'send_failed');
  const retry = await api.call('POST', `/api/pedidos-fornecedor/${r.id}/reenviar`);
  assert.equal(retry.body.status, 'sent');
  assert.equal(retry.body.note.nota_id, first.body.note.nota_id);
});

test('#156/AC-7 editar muda o texto; mexer num {{número}} dá 422', async () => {
  const api = createMockApi();
  const [r] = await list(api);
  const ok = await api.call('POST', `/api/pedidos-fornecedor/${r.id}/editar`, { text: `${r.template}\n\nAté breve.` });
  assert.equal(ok.status, 200);
  assert.match(ok.body.request.body, /Até breve\./);
  const bad = await api.call('POST', `/api/pedidos-fornecedor/${r.id}/editar`, { text: r.template.replace('{{nota.numero}}', '99999') });
  assert.equal(bad.status, 422);
});

test('#156/AC-8 refazer só depois de descartar, e abre um pedido escrevendo', async () => {
  const api = createMockApi();
  const [r] = await list(api);
  const early = await api.call('POST', `/api/pedidos-fornecedor/${r.id}/refazer`);
  assert.equal(early.status, 409);
  await api.call('POST', `/api/pedidos-fornecedor/${r.id}/descartar`, { reason: '  texto errado  ' });
  const [discarded] = await list(api);
  assert.equal(discarded.discardReason, 'texto errado');
  const redo = await api.call('POST', `/api/pedidos-fornecedor/${r.id}/refazer`);
  assert.equal(redo.status, 200);
  assert.equal(redo.body.request.status, 'writing');
  assert.equal((await list(api)).length, 2);
});

test('id desconhecido dá 404 e método errado dá 405', async () => {
  const api = createMockApi();
  assert.equal((await api.call('POST', '/api/pedidos-fornecedor/nao-existe/descartar')).status, 404);
  assert.equal((await api.call('POST', `/api/pedidos-fornecedor?nota=${DEMO_KEY}`)).status, 405);
});
