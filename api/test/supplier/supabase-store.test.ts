import { describe, expect, it } from 'vitest';
import type { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { buildSupplierRequestFacts, type SupplierRequest } from '../../src/domain/index.js';
import { supabaseIssuedNoteStore } from '../../src/supplier/supabase-notes.js';
import { LEASE_MS, supabaseSupplierRequestStore } from '../../src/supplier/supabase-store.js';
import type { RequestRecord, SendStamp, SupplierRequestStore } from '../../src/supplier/ports.js';
import { returnNote, sourceInvoice } from '../domain/supplier-request-fixtures.js';
import { NOW } from './doubles.js';
import { harness, newRequest } from './supabase-support.js';

// #12: o adaptador do pedido ao fornecedor sobre o PostgREST falso (sem banco real: cada requisição é uma transação).

const TABLE = 'outbox_supplier_emails';
const BY = 'ana@jachegou.example';
const OTHER = 'outra@jachegou.example';
const at = (minutes: number): Date => new Date(NOW.getTime() + minutes * 60_000);
const catalog = buildSupplierRequestFacts(returnNote(), sourceInvoice(), '2026-11-17');

const created = async (store: SupplierRequestStore, over = {}): Promise<RequestRecord> => {
  const result = await store.create(newRequest(over));
  if (result.kind !== 'ok') throw new Error('o pedido deveria ter sido criado');
  return result.record;
};

const stamp: SendStamp = {
  channel: 'mock',
  providerMessageId: 'mock-1',
  attachments: [{ filename: 'ND-1.json', contentType: 'application/json', issuedReturnNoteId: 1 }],
};

/** #12: o envio inteiro pelas portas: trava, emissão registrada e o carimbo de enviado. */
const sendFlow = async (rest: SupabaseRest, store: SupplierRequestStore, request: SupplierRequest): Promise<void> => {
  const notes = supabaseIssuedNoteStore(rest);
  await store.claimSend(request.id, BY, NOW);
  request.recordIssuance(await notes.issue(7, request.note, '2026-11-12'));
  await store.save(request, { by: BY, at: NOW, action: 'issued' });
  request.markSent();
  await store.save(request, { by: BY, at: NOW, action: 'sent', sent: stamp });
};

describe('#12/AC-3 um pedido aberto por nota de origem e tipo', () => {
  it('cria o rascunho com a versão 1 e a primeira entrada do histórico, e devolve a raiz com o id da tabela', async () => {
    const { fake, rest } = harness();
    const record = await created(supabaseSupplierRequestStore(rest));
    expect(record.request.id).toBe(1);
    expect(record.request.status).toBe('draft');
    expect(record.queueId).toBe(7);
    const [row] = fake.rows(TABLE);
    expect(row).toMatchObject({ version: 1, request_type: 'return_note', status: 'draft', supplier_id: 'F02', queue_id: 7 });
    expect(row?.history).toEqual([
      expect.objectContaining({ version: 1, by: 'agente', action: 'drafted', state: expect.objectContaining({ status: 'draft' }) }),
    ]);
  });

  it('um segundo pedido aberto da mesma nota e tipo é conflito (o índice parcial responde 409 com 23505)', async () => {
    const { fake, rest } = harness();
    const store = supabaseSupplierRequestStore(rest);
    await created(store);
    expect(await store.create(newRequest())).toEqual({ kind: 'conflict' });
    expect(fake.rows(TABLE)).toHaveLength(1);
  });

  it('com o pedido anterior descartado, outro entra', async () => {
    const { fake, rest } = harness();
    const store = supabaseSupplierRequestStore(rest);
    const first = await created(store);
    first.request.discard('texto ruim');
    await store.save(first.request, { by: BY, at: NOW, action: 'discarded' });
    expect((await store.create(newRequest())).kind).toBe('ok');
    expect(fake.rows(TABLE)).toHaveLength(2);
  });

  it('findOpen acha o aberto e ignora o descartado; get lê por id; o que não existe é null', async () => {
    const { rest } = harness();
    const store = supabaseSupplierRequestStore(rest);
    const record = await created(store);
    expect((await store.findOpen(record.request.invoiceAccessKey, 'return_note'))?.request.id).toBe(1);
    expect((await store.get(1))?.to).toBe(record.to);
    expect(await store.get(99)).toBeNull();
    record.request.discard('x');
    await store.save(record.request, { by: BY, at: NOW, action: 'discarded' });
    expect(await store.findOpen(record.request.invoiceAccessKey, 'return_note')).toBeNull();
  });

  it('o filtro do findOpen repete o predicado do índice parcial', async () => {
    const { fake, rest } = harness();
    await supabaseSupplierRequestStore(rest).findOpen('chave', 'return_note');
    expect(decodeURIComponent(fake.requests.at(-1)?.url ?? '')).toContain('status=in.(draft,sent,send_failed)');
  });

  it('outro 409 (uma chave estrangeira, 23503) sobe como erro, sem o texto nem o corpo da resposta do banco', async () => {
    const { fake, rest } = harness();
    fake.failNext(TABLE, 'POST', 409, { code: '23503', message: 'Key (queue_id)=(7) segredo-do-banco is not present', details: 'dado-do-fornecedor' });
    const error: unknown = await supabaseSupplierRequestStore(rest).create(newRequest()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    const text = String((error as Error).message) + JSON.stringify(error);
    expect(text).toContain('23503');
    expect(text).not.toContain('segredo-do-banco');
    expect(text).not.toContain('dado-do-fornecedor');
  });

  it('um erro que não é de conflito também sobe sem o corpo (HTTP 500)', async () => {
    const { fake, rest } = harness();
    fake.failNext(TABLE, 'POST', 500, { message: 'senha-do-banco no log' });
    const error: unknown = await supabaseSupplierRequestStore(rest).create(newRequest()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toContain('senha-do-banco');
  });
});

describe('#12/AC-4 o pedido guarda o que o caso de uso precisa', () => {
  it('guarda destinatário, assunto, corpo com marcadores, o que pedimos, a nota, o prazo, o modelo e o dia do rascunho', async () => {
    const { fake, rest } = harness();
    await created(supabaseSupplierRequestStore(rest));
    expect(fake.rows(TABLE)[0]).toMatchObject({
      recipient: 'compras@bebidas-rio-claro.example',
      subject: 'Devolução da nota {{nota.numero}}',
      attachments: [],
      drafted_on: '2026-11-12',
      due_on: '2026-11-17',
      model: 'claude-teste',
      send_claim: null,
      sent_by: null,
    });
    expect(fake.rows(TABLE)[0]?.asks).toHaveLength(2);
    expect(String(fake.rows(TABLE)[0]?.body)).toContain('{{devolucao.total}}');
  });

  it('o texto recusado nasce descartado com o motivo, sem texto, e o histórico diz rejected', async () => {
    const { fake, rest } = harness();
    const record = await created(supabaseSupplierRequestStore(rest), {
      outcome: { kind: 'rejected', rejection: { ok: false, reason: 'number_mismatch', field: 'body' } },
    });
    expect(record.request.status).toBe('discarded');
    expect(record.request.discardReason).toBe('number_mismatch: body');
    expect(fake.rows(TABLE)[0]).toMatchObject({ subject: '', body: '', asks: [], status: 'discarded', discard_reason: 'number_mismatch: body' });
    expect((fake.rows(TABLE)[0]?.history as { action: string }[])[0]?.action).toBe('rejected');
    expect((await supabaseSupplierRequestStore(rest).get(1))?.request.discardReason).toBe('number_mismatch: body');
  });

  it('editar o corpo é um PATCH filtrado pela versão lida: versão +1 e uma entrada de histórico com quem, quando e o estado', async () => {
    const { fake, rest } = harness();
    const store = supabaseSupplierRequestStore(rest);
    const { request } = await created(store);
    request.editBody('Pedimos o retorno até {{prazo}}.', catalog);
    expect(await store.save(request, { by: BY, at: NOW, action: 'edited' })).toBe('ok');
    const row = fake.rows(TABLE)[0];
    expect(row).toMatchObject({ version: 2, body: 'Pedimos o retorno até {{prazo}}.' });
    expect(row?.history).toEqual([
      expect.objectContaining({ version: 1, action: 'drafted' }),
      { version: 2, at: NOW.toISOString(), by: BY, action: 'edited', state: expect.objectContaining({ status: 'draft', body: 'Pedimos o retorno até {{prazo}}.' }) },
    ]);
    const patch = fake.requests.filter((r) => r.method === 'PATCH');
    expect(patch).toHaveLength(1);
    expect(decodeURIComponent(patch[0]?.url ?? '')).toContain('version=eq.1');
  });

  it('duas edições seguidas geram versões seguidas', async () => {
    const { fake, rest } = harness();
    const store = supabaseSupplierRequestStore(rest);
    const { request } = await created(store);
    request.editBody('Um {{prazo}}.', catalog);
    await store.save(request, { by: BY, at: NOW, action: 'edited' });
    request.editBody('Dois {{prazo}}.', catalog);
    await store.save(request, { by: BY, at: at(1), action: 'edited' });
    expect((fake.rows(TABLE)[0]?.history as { version: number }[]).map((h) => h.version)).toEqual([1, 2, 3]);
    expect(fake.rows(TABLE)[0]?.version).toBe(3);
  });

  it('gravar com a versão velha volta stale e não muda a linha', async () => {
    const { fake, rest } = harness();
    const store = supabaseSupplierRequestStore(rest);
    const record = await created(store);
    const other = supabaseSupplierRequestStore(rest);
    const second = await other.get(record.request.id);
    second?.request.discard('outro');
    expect(await other.save(second!.request, { by: OTHER, at: NOW, action: 'discarded' })).toBe('ok');
    record.request.discard('eu');
    expect(await store.save(record.request, { by: BY, at: NOW, action: 'discarded' })).toBe('stale');
    expect(fake.rows(TABLE)[0]).toMatchObject({ discard_reason: 'outro', discarded_by: OTHER, version: 2 });
  });

  it('descartar grava o motivo, quem e quando, e a raiz lida de volta está descartada com o motivo', async () => {
    const { fake, rest } = harness();
    const store = supabaseSupplierRequestStore(rest);
    const { request } = await created(store);
    request.discard('fornecedor avisado por telefone');
    await store.save(request, { by: BY, at: NOW, action: 'discarded' });
    expect(fake.rows(TABLE)[0]).toMatchObject({
      status: 'discarded',
      discard_reason: 'fornecedor avisado por telefone',
      discarded_by: BY,
      discarded_at: NOW.toISOString(),
      version: 2,
    });
    const back = await store.get(request.id);
    expect(back?.request.status).toBe('discarded');
    expect(back?.request.discardReason).toBe('fornecedor avisado por telefone');
  });

  it('o envio grava quem, quando, o canal, o id do provedor e os anexos, e a raiz lida de volta é a mesma, com a nota emitida', async () => {
    const { fake, rest } = harness();
    const store = supabaseSupplierRequestStore(rest);
    const { request } = await created(store);
    await sendFlow(rest, store, request);
    expect(fake.rows(TABLE)[0]).toMatchObject({
      status: 'sent',
      sent_by: BY,
      sent_at: NOW.toISOString(),
      channel: 'mock',
      provider_message_id: 'mock-1',
      issued_return_note_id: 1,
      attachments: [{ filename: 'ND-1.json', content_type: 'application/json', issued_return_note_id: 1 }],
      send_claim: null,
      send_claimed_at: null,
    });
    const back = (await store.get(request.id))?.request;
    expect(back?.status).toBe('sent');
    expect(back?.issuedNote?.noteId).toBe('ND-1');
    expect(back?.issuedNote?.accessKey).toBe(request.issuedNote?.accessKey);
    expect(back?.note).toEqual(returnNote());
  });

  it('o histórico do envio inteiro: rascunho, trava, emissão, enviado, com versões seguidas', async () => {
    const { fake, rest } = harness();
    const store = supabaseSupplierRequestStore(rest);
    const { request } = await created(store);
    await sendFlow(rest, store, request);
    const history = fake.rows(TABLE)[0]?.history as { version: number; action: string }[];
    expect(history.map((h) => [h.version, h.action])).toEqual([
      [1, 'drafted'],
      [2, 'send_claimed'],
      [3, 'issued'],
      [4, 'sent'],
    ]);
  });

  it('a falha do envio grava o motivo e limpa a trava; lido de volta é send_failed com o motivo; reenviar depois fica enviado', async () => {
    const { fake, rest } = harness();
    const store = supabaseSupplierRequestStore(rest);
    const { request } = await created(store);
    const notes = supabaseIssuedNoteStore(rest);
    await store.claimSend(request.id, BY, NOW);
    request.recordIssuance(await notes.issue(7, request.note, '2026-11-12'));
    await store.save(request, { by: BY, at: NOW, action: 'issued' });
    request.markSendFailed('caixa_de_saida_indisponivel');
    await store.save(request, { by: BY, at: NOW, action: 'send_failed' });
    expect(fake.rows(TABLE)[0]).toMatchObject({ status: 'send_failed', send_failure_reason: 'caixa_de_saida_indisponivel', send_claim: null });
    const again = await store.get(request.id);
    expect(again?.request.status).toBe('send_failed');
    expect(again?.request.sendFailureReason).toBe('caixa_de_saida_indisponivel');

    expect((await store.claimSend(request.id, BY, at(1))).kind).toBe('claimed');
    again!.request.markSent();
    expect(await store.save(again!.request, { by: BY, at: at(1), action: 'sent', sent: stamp })).toBe('ok');
    const sent = await store.get(request.id);
    expect(sent?.request.status).toBe('sent');
    expect(sent?.request.sendFailureReason).toBe('caixa_de_saida_indisponivel');
  });

  it('linha com o prazo diferente do que a regra calcula é dado corrompido: falha em vez de montar o pedido', async () => {
    const { fake, rest } = harness();
    const store = supabaseSupplierRequestStore(rest);
    await created(store);
    fake.rows(TABLE)[0]!.due_on = '2030-01-01';
    await expect(store.get(1)).rejects.toThrow();
  });

  it('nunca apaga: nenhum DELETE, e todo PATCH carrega o filtro da versão', async () => {
    const { fake, rest } = harness();
    const store = supabaseSupplierRequestStore(rest);
    const { request } = await created(store);
    await sendFlow(rest, store, request);
    expect(fake.requests.some((r) => r.method === 'DELETE')).toBe(false);
    const patches = fake.requests.filter((x) => x.method === 'PATCH' && x.url.includes(TABLE));
    expect(patches.length).toBeGreaterThan(0);
    for (const r of patches) expect(decodeURIComponent(r.url)).toMatch(/version=eq\.\d+/);
  });
});

describe('#12/AC-4 a trava do envio concorrente', () => {
  it('dois envios na mesma versão: um ganha a trava, o outro é conflito', async () => {
    const { fake, rest } = harness();
    const a = supabaseSupplierRequestStore(rest);
    const b = supabaseSupplierRequestStore(rest);
    const { request } = await created(a);
    await b.get(request.id);
    const first = await a.claimSend(request.id, BY, NOW);
    const second = await b.claimSend(request.id, OTHER, NOW);
    expect(first.kind).toBe('claimed');
    expect(second).toEqual({ kind: 'conflict' });
    expect(fake.rows(TABLE)[0]).toMatchObject({ send_claim: first.kind === 'claimed' ? first.claim : '', send_claimed_at: NOW.toISOString(), version: 2 });
  });

  it('com a trava ativa, quem lê depois também é recusado, mesmo lendo a versão nova', async () => {
    const { rest } = harness();
    const a = supabaseSupplierRequestStore(rest);
    const b = supabaseSupplierRequestStore(rest);
    const { request } = await created(a);
    await a.claimSend(request.id, BY, NOW);
    await b.get(request.id);
    expect(await b.claimSend(request.id, OTHER, at(1))).toEqual({ kind: 'conflict' });
  });

  it('a trava vencida (passou o prazo) é retomada', async () => {
    const { rest } = harness();
    const a = supabaseSupplierRequestStore(rest);
    const b = supabaseSupplierRequestStore(rest);
    const { request } = await created(a);
    await a.claimSend(request.id, BY, NOW);
    await b.get(request.id);
    const later = new Date(NOW.getTime() + LEASE_MS + 1000);
    expect((await b.claimSend(request.id, OTHER, later)).kind).toBe('claimed');
  });

  it('o prazo da trava é de 5 minutos', () => {
    expect(LEASE_MS).toBe(5 * 60_000);
  });

  it('com a trava ativa, editar e descartar são recusados (stale); quem tem a trava grava', async () => {
    const { fake, rest } = harness();
    const holder = supabaseSupplierRequestStore(rest);
    const person = supabaseSupplierRequestStore(rest);
    const { request } = await created(holder);
    await holder.claimSend(request.id, BY, NOW);
    const seen = await person.get(request.id);
    seen?.request.discard('quero descartar');
    expect(await person.save(seen!.request, { by: OTHER, at: at(1), action: 'discarded' })).toBe('stale');
    expect(fake.rows(TABLE)[0]?.status).toBe('draft');
    request.discard('o dono da trava grava');
    expect(await holder.save(request, { by: BY, at: at(1), action: 'discarded' })).toBe('ok');
  });

  it('só se trava rascunho ou send_failed: o descartado volta conflito', async () => {
    const { rest } = harness();
    const store = supabaseSupplierRequestStore(rest);
    const record = await created(store);
    record.request.discard('x');
    await store.save(record.request, { by: BY, at: NOW, action: 'discarded' });
    await store.get(record.request.id);
    expect(await store.claimSend(record.request.id, BY, at(1))).toEqual({ kind: 'conflict' });
  });

  it('soltar a trava a limpa, sobe a versão e registra no histórico; depois o pedido se descarta', async () => {
    const { fake, rest } = harness();
    const store = supabaseSupplierRequestStore(rest);
    const { request } = await created(store);
    await store.claimSend(request.id, BY, NOW);
    await store.releaseSend(request.id, BY, at(1));
    expect(fake.rows(TABLE)[0]).toMatchObject({ send_claim: null, send_claimed_at: null, version: 3 });
    expect((fake.rows(TABLE)[0]?.history as { action: string }[]).map((h) => h.action)).toEqual(['drafted', 'send_claimed', 'send_released']);
    request.discard('depois da trava solta');
    expect(await store.save(request, { by: BY, at: at(2), action: 'discarded' })).toBe('ok');
  });

  it('a trava é pedida por um PATCH condicional a versão, ao estado e ao prazo', async () => {
    const { fake, rest } = harness();
    const store = supabaseSupplierRequestStore(rest);
    const { request } = await created(store);
    await store.claimSend(request.id, BY, NOW);
    const patch = decodeURIComponent(fake.requests.filter((r) => r.method === 'PATCH').at(-1)?.url ?? '');
    expect(patch).toContain('version=eq.1');
    expect(patch).toContain('status=in.(draft,send_failed)');
    expect(patch).toContain(`or=(send_claim.is.null,send_claimed_at.lt.${new Date(NOW.getTime() - LEASE_MS).toISOString()})`);
  });
});
