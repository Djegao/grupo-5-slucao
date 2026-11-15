import { describe, expect, it } from 'vitest';
import { SupabaseRest, SupabaseRestError } from '../../src/connectors/supabase-rest.js';
import { erpReturnNoteOutbox } from '../../src/connectors/erp-return-note.js';
import { Quantity, SupplierRequest, type ReturnNote, type SupplierRequestSnapshot } from '../../src/domain/index.js';
import { supabaseSupplierRequestRepository } from '../../src/supplier-requests/supabase-requests.js';
import { supabaseReturnNoteEmissions } from '../../src/supplier-requests/supabase-emissions.js';
import { supabaseReturnNoteWorkQueue } from '../../src/supplier-requests/supabase-queue.js';
import { supabaseSupplierEmailSender } from '../../src/supplier-requests/supabase-email-sender.js';
import { supabaseSupplierDirectory } from '../../src/supplier-requests/supabase-directory.js';
import { emitAndSend, openForDecided, writeDraft } from '../../src/supplier-requests/index.js';
import type { Ask } from '../../src/claude/client.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { GOOD_BODY, world } from './fakes.js';
import { ORIGIN_KEY } from '../domain/supplier-request-fixtures.js';

// #156 Os adaptadores do OLTP contra o PostgREST falso. Não há pista de banco real neste repositório:
// o fake não executa trigger, check, índice único parcial nem sequência; ele imita o 409 do índice
// parcial, o on_conflict, o PATCH condicional e a rota rpc (ver supabase/persistence/supplier-requests.md).

const rigged = (seed: Record<string, Record<string, unknown>[]> = {}) => {
  const fake = new FakePostgrest(seed);
  fake.uniques.push({
    table: 'supplier_requests',
    name: 'supplier_requests_one_open_key',
    columns: ['invoice_access_key', 'request_type'],
    where: (r) => ['writing', 'draft', 'send_failed'].includes(String(r.status)),
  });
  const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch });
  return { fake, rest };
};

const opened = (id = 'req-1', key = ORIGIN_KEY): SupplierRequest =>
  SupplierRequest.open({
    id,
    createdAt: '2026-11-16T12:00:00.000Z',
    createdBy: 'ana@jachegou.test',
    invoiceAccessKey: key,
    supplierId: 'F11',
    requestType: 'return_note',
    to: 'fiscal@f11.fornecedor.test',
    subject: 'NF 20046 · devolução do item trocado',
    asks: ['Retirar o item trocado', 'Entregar o item pedido'],
    channel: 'mock',
  });

const SENT: SupplierRequestSnapshot = {
  ...opened('req-sent').snapshot(),
  updatedAt: '2026-11-16T13:00:00.000Z',
  updatedBy: 'bia@jachegou.test',
  body: 'Olá, {{nota.numero}}',
  attachments: [{ kind: 'return_note', returnNoteId: 'ND-0012', filename: 'nota-devolucao-ND-0012.json' }],
  dueOn: '2026-11-19',
  status: 'sent',
  model: 'claude-test',
  draftedAt: '2026-11-16T12:30:00.000Z',
  editedBy: 'ana@jachegou.test',
  editedAt: '2026-11-16T12:40:00.000Z',
  sentBy: 'bia@jachegou.test',
  sentAt: '2026-11-16T13:00:00.000Z',
  providerMessageId: 'mock-abc',
};

const NOTE: ReturnNote = {
  nota_id: 'ND-0012',
  chave: '35261174055489000148559000000000121000000019',
  numero: 12,
  serie: 900,
  emitente: '12.345.678/0001-95',
  fornecedor_id: 'F11',
  destino: 'CD-01',
  data_emissao: '2026-11-16',
  nota_referenciada: ORIGIN_KEY,
  natureza: 'devolucao',
  itens: [
    {
      codigo_fornecedor: 'F11-001',
      sku: 'SKU-2001',
      descricao: 'Shampoo 350 ml',
      quantidade: 40,
      unidade: 'UN',
      preco_unitario: 54.08,
      valor: 2163.2,
    },
  ],
  valor_total: 2163.2,
};

describe('#156 rpc do cliente PostgREST', () => {
  it('chama a função por POST em rpc/<nome> e devolve o escalar', async () => {
    const { fake, rest } = rigged();
    expect(await rest.rpc('next_return_note_number', {})).toBe(1);
    expect(await rest.rpc('next_return_note_number')).toBe(2);
    expect(fake.requests[0]).toMatchObject({ method: 'POST' });
    expect(fake.requests[0]?.url).toBe('https://fake.supabase.co/rest/v1/rpc/next_return_note_number');
  });

  it('recusa um nome de função que não é identificador', async () => {
    const { rest } = rigged();
    await expect(rest.rpc('../invoices')).rejects.toBeInstanceOf(SupabaseRestError);
  });
});

describe('#156 SupplierRequestRepository sobre supplier_requests', () => {
  it('#156/AC-1 add e findById devolvem o mesmo instantâneo, do pedido aberto ao enviado', async () => {
    const { rest } = rigged({ supplier_requests: [] });
    const repo = supabaseSupplierRequestRepository(rest);
    expect(await repo.add(opened())).toBe('saved');
    expect(await repo.add(SupplierRequest.restore(SENT))).toBe('saved');
    expect((await repo.findById('req-1'))?.snapshot()).toEqual(opened().snapshot());
    expect((await repo.findById('req-sent'))?.snapshot()).toEqual(SENT);
    expect(await repo.findById('nada')).toBeNull();
  });

  it('lê timestamptz no formato do PostgREST (+00:00) como o ISO do domínio', async () => {
    const { fake, rest } = rigged();
    const repo = supabaseSupplierRequestRepository(rest);
    await repo.add(opened());
    const row = fake.rows('supplier_requests')[0]!;
    row.created_at = '2026-11-16T12:00:00+00:00';
    row.updated_at = '2026-11-16T12:00:00+00:00';
    expect((await repo.findById('req-1'))?.snapshot()).toEqual(opened().snapshot());
  });

  it('listByInvoice vem do mais antigo ao mais novo e listByStatus filtra pelo status', async () => {
    const { rest } = rigged();
    const repo = supabaseSupplierRequestRepository(rest);
    await repo.add(SupplierRequest.restore({ ...SENT, id: 'b', createdAt: '2026-11-16T12:10:00.000Z' }));
    await repo.add(SupplierRequest.restore({ ...SENT, id: 'a', createdAt: '2026-11-16T12:05:00.000Z' }));
    await repo.add(opened('c'));
    expect((await repo.listByInvoice(ORIGIN_KEY)).map((r) => r.id)).toEqual(['c', 'a', 'b']);
    expect((await repo.listByStatus('writing')).map((r) => r.id)).toEqual(['c']);
    expect(await repo.listByInvoice('outra')).toEqual([]);
  });

  it('#156/AC-8 add devolve duplicate_open quando o índice parcial recusa, e só então', async () => {
    const { fake, rest } = rigged();
    const repo = supabaseSupplierRequestRepository(rest);
    expect(await repo.add(opened('req-1'))).toBe('saved');
    expect(await repo.add(opened('req-2'))).toBe('duplicate_open');
    expect(fake.rows('supplier_requests')).toHaveLength(1);
    // enviado não bloqueia: o refazer entra
    fake.rows('supplier_requests')[0]!.status = 'sent';
    expect(await repo.add(opened('req-3'))).toBe('saved');
  });

  it('um 409 de outra restrição sobe como erro, não como duplicate_open', async () => {
    const { fake, rest } = rigged();
    fake.uniques.push({ table: 'supplier_requests', name: 'supplier_requests_pkey', columns: ['id'] });
    const repo = supabaseSupplierRequestRepository(rest);
    await repo.add(opened('req-1', '1'.repeat(44)));
    await expect(repo.add(opened('req-1', '2'.repeat(44)))).rejects.toBeInstanceOf(SupabaseRestError);
  });

  it('save grava o que mudou, com PATCH condicional por id, updated_at e version, sem as colunas fixas', async () => {
    const { fake, rest } = rigged();
    const repo = supabaseSupplierRequestRepository(rest);
    await repo.add(opened());
    const request = (await repo.findById('req-1'))!;
    const before = request.updatedAt;
    request.discard('bia@jachegou.test', '2026-11-16T14:00:00.000Z', 'texto ruim');
    expect(await repo.save(request, before)).toBe('saved');
    const patch = fake.requests.find((r) => r.method === 'PATCH')!;
    const url = new URL(patch.url);
    expect(url.searchParams.get('id')).toBe('eq.req-1');
    expect(url.searchParams.get('updated_at')).toBe(`eq.${before}`);
    expect(url.searchParams.get('version')).toBe('eq.1');
    const stored = fake.rows('supplier_requests')[0]!;
    expect(stored).toMatchObject({ status: 'discarded', discarded_by: 'bia@jachegou.test', discard_reason: 'texto ruim' });
    expect((await repo.findById('req-1'))?.snapshot()).toEqual(request.snapshot());
  });

  it('save não envia colunas fixas nem a versão', async () => {
    const { fake, rest } = rigged();
    const repo = supabaseSupplierRequestRepository(rest);
    await repo.add(opened());
    const request = (await repo.findById('req-1'))!;
    const before = request.updatedAt;
    request.discard('bia@jachegou.test', '2026-11-16T14:00:00.000Z', 'x');
    const sentBodies: string[] = [];
    const spy = new SupabaseRest({
      url: 'https://fake.supabase.co',
      secretKey: 'sb_secret_fake',
      fetch: async (input, init) => {
        if (init?.method === 'PATCH') sentBodies.push(String(init.body));
        return fake.fetch(input, init);
      },
    });
    const spied = supabaseSupplierRequestRepository(spy);
    await spied.findById('req-1');
    await spied.save(request, before);
    const body = JSON.parse(sentBodies[0]!) as Record<string, unknown>;
    for (const fixed of ['id', 'created_at', 'created_by', 'invoice_access_key', 'supplier_id', 'request_type', 'to_address', 'subject', 'asks', 'channel', 'version']) {
      expect(body).not.toHaveProperty(fixed);
    }
  });

  it('save com o updated_at velho devolve stale e não grava', async () => {
    const { fake, rest } = rigged();
    const repo = supabaseSupplierRequestRepository(rest);
    await repo.add(opened());
    const request = (await repo.findById('req-1'))!;
    request.discard('bia@jachegou.test', '2026-11-16T14:00:00.000Z', 'x');
    expect(await repo.save(request, '2026-11-16T11:00:00.000Z')).toBe('stale');
    expect(fake.rows('supplier_requests')[0]?.status).toBe('writing');
  });

  it('save com a version que outra gravação já subiu devolve stale, mesmo com o mesmo updated_at', async () => {
    const { fake, rest } = rigged();
    const repo = supabaseSupplierRequestRepository(rest);
    await repo.add(opened());
    const request = (await repo.findById('req-1'))!;
    fake.rows('supplier_requests')[0]!.version = 2; // outra pessoa gravou no mesmo milissegundo
    request.discard('bia@jachegou.test', '2026-11-16T14:00:00.000Z', 'x');
    expect(await repo.save(request, request.snapshot().createdAt)).toBe('stale');
  });

  it('duas gravações seguidas na mesma instância seguem a version devolvida pelo PATCH', async () => {
    const { fake, rest } = rigged();
    const repo = supabaseSupplierRequestRepository(rest);
    const draft: SupplierRequestSnapshot = {
      ...SENT,
      id: 'req-draft',
      status: 'draft',
      sentBy: null,
      sentAt: null,
      providerMessageId: null,
      attachments: [],
    };
    await repo.add(SupplierRequest.restore(draft));
    const request = (await repo.findById('req-draft'))!;
    const first = request.updatedAt;
    request.markSendFailed('mailbox_unavailable', 'ana@jachegou.test', '2026-11-16T15:00:00.000Z');
    expect(await repo.save(request, first)).toBe('saved');
    expect(fake.rows('supplier_requests')[0]?.version).toBe(2);
    const second = request.updatedAt;
    request.discard('bia@jachegou.test', '2026-11-16T16:00:00.000Z', 'x');
    expect(await repo.save(request, second)).toBe('saved');
    expect(fake.rows('supplier_requests')[0]?.version).toBe(3);
    expect(fake.rows('supplier_request_history').map((h) => h.version)).toEqual([1, 2, 3]);
  });

  it('save de um id que a instância não leu filtra só por updated_at', async () => {
    const { fake, rest } = rigged();
    await supabaseSupplierRequestRepository(rest).add(opened());
    const other = supabaseSupplierRequestRepository(rest);
    const request = SupplierRequest.restore(opened().snapshot());
    request.discard('bia@jachegou.test', '2026-11-16T14:00:00.000Z', 'x');
    expect(await other.save(request, opened().updatedAt)).toBe('saved');
    const patch = fake.requests.find((r) => r.method === 'PATCH')!;
    expect(new URL(patch.url).searchParams.has('version')).toBe(false);
  });
});

describe('#156/AC-4 ReturnNoteEmissions sobre return_note_emissions e a sequência', () => {
  it('nextSequence usa a rota rpc e devolve inteiros crescentes', async () => {
    const { fake, rest } = rigged();
    const emissions = supabaseReturnNoteEmissions(rest);
    expect(await emissions.nextSequence()).toBe(1);
    expect(await emissions.nextSequence()).toBe(2);
    expect(fake.requests.every((r) => r.url.endsWith('/rpc/next_return_note_number'))).toBe(true);
  });

  it('um retorno da rpc que não é inteiro sobe como erro de formato', async () => {
    const { fake, rest } = rigged();
    const emissions = supabaseReturnNoteEmissions(
      new SupabaseRest({
        url: 'https://fake.supabase.co',
        secretKey: 'sb_secret_fake',
        fetch: async () => new Response('"x"', { status: 200 }),
      }),
    );
    await expect(emissions.nextSequence()).rejects.toBeInstanceOf(SupabaseRestError);
    expect(fake.requests).toHaveLength(0);
    expect(rest).toBeDefined();
  });

  it('save grava a nota pela linha da fila e findByQueueRow e findByNoteId a devolvem igual', async () => {
    const { fake, rest } = rigged();
    const emissions = supabaseReturnNoteEmissions(rest);
    expect(await emissions.save(140, NOTE)).toEqual(NOTE);
    expect(fake.rows('return_note_emissions')[0]).toMatchObject({
      note_id: 'ND-0012',
      queue_row_id: 140,
      access_key: NOTE.chave,
      number: 12,
      series: 900,
    });
    expect(await emissions.findByQueueRow(140)).toEqual(NOTE);
    expect(await emissions.findByNoteId('ND-0012')).toEqual(NOTE);
    expect(await emissions.findByQueueRow(141)).toBeNull();
    expect(await emissions.findByNoteId('ND-9999')).toBeNull();
  });

  it('#156/AC-4 emitir de novo a mesma linha devolve a nota que ficou, sem gravar outra', async () => {
    const { fake, rest } = rigged();
    const emissions = supabaseReturnNoteEmissions(rest);
    await emissions.save(140, NOTE);
    const loser: ReturnNote = { ...NOTE, nota_id: 'ND-0013', numero: 13, chave: '9'.repeat(44) };
    expect(await emissions.save(140, loser)).toEqual(NOTE);
    expect(fake.rows('return_note_emissions')).toHaveLength(1);
    expect(fake.requests.find((r) => r.url.includes('on_conflict=queue_row_id'))?.headers.Prefer).toContain('ignore-duplicates');
  });
});

describe('#156 ReturnNoteWorkQueue sobre outbox_return_notes', () => {
  const invoiceRow = {
    access_key: ORIGIN_KEY,
    number: '20046',
    series: '1',
    supplier_id: 'F11',
    items: [
      { supplierCode: 'F11-001', sku: 'SKU-2001', description: 'Shampoo 350 ml', unitPriceCents: 5408 },
      { supplierCode: 'F11-002', sku: 'SKU-2002', description: 'Sabonete 90 g', unitPriceCents: 250 },
    ],
  };
  const input = {
    invoiceAccessKey: ORIGIN_KEY,
    lines: [{ supplierCode: 'F11-001', quantity: Quantity.of(40, 'UN') }],
    reason: 'E2 nota 20046: devolução',
  };

  it('#156/AC-2 ensureRow publica a linha pendente quando falta e devolve id e valor da fila', async () => {
    const { fake, rest } = rigged({ invoices: [invoiceRow] });
    const queue = supabaseReturnNoteWorkQueue(rest);
    const row = await queue.ensureRow(input);
    expect(row.valueCents).toBe(216320);
    expect(fake.rows('outbox_return_notes')).toHaveLength(1);
    expect(fake.rows('outbox_return_notes')[0]).toMatchObject({ id: row.id, status: 'pendente', invoice_access_key: ORIGIN_KEY });
  });

  it('ensureRow de novo devolve a mesma linha, sem publicar outra (idempotente pela chave)', async () => {
    const { fake, rest } = rigged({ invoices: [invoiceRow] });
    const queue = supabaseReturnNoteWorkQueue(rest);
    const first = await queue.ensureRow(input);
    expect(await queue.ensureRow(input)).toEqual(first);
    expect(fake.rows('outbox_return_notes')).toHaveLength(1);
  });

  it('ensureRow reaproveita a linha publicada antes pela caixa da #59', async () => {
    const { fake, rest } = rigged({ invoices: [invoiceRow] });
    const published = await erpReturnNoteOutbox(rest).publish({
      invoiceAccessKey: ORIGIN_KEY,
      lines: input.lines,
      reason: input.reason,
    });
    expect((await supabaseReturnNoteWorkQueue(rest).ensureRow(input)).id).toBe(published.id);
    expect(fake.rows('outbox_return_notes')).toHaveLength(1);
  });

  it('ensureRow recusa quando a fila não tem valor (a nota de origem não traz a linha)', async () => {
    const { rest } = rigged({ invoices: [{ ...invoiceRow, items: [] }] });
    await expect(supabaseReturnNoteWorkQueue(rest).ensureRow(input)).rejects.toThrow(/sem valor/);
  });

  it('ensureRow recusa quando a nota de origem não existe', async () => {
    const { rest } = rigged();
    await expect(supabaseReturnNoteWorkQueue(rest).ensureRow(input)).rejects.toThrow(/sem valor/);
  });

  it('markEmitted passa a linha de pendente a emitida; repetir com o mesmo número vale ok', async () => {
    const { fake, rest } = rigged({ invoices: [invoiceRow] });
    const queue = supabaseReturnNoteWorkQueue(rest);
    const { id } = await queue.ensureRow(input);
    const at = new Date('2026-11-16T13:00:00.000Z');
    expect(await queue.markEmitted(id, '12', 'bia@jachegou.test', at)).toBe('ok');
    expect(fake.rows('outbox_return_notes')[0]).toMatchObject({
      status: 'emitida',
      nfe_number: '12',
      emitted_by: 'bia@jachegou.test',
      emitted_at: '2026-11-16T13:00:00.000Z',
    });
    expect(await queue.markEmitted(id, '12', 'bia@jachegou.test', at)).toBe('ok');
  });

  it('markEmitted com outro número numa linha emitida é conflict; linha ausente é not_found', async () => {
    const { rest } = rigged({ invoices: [invoiceRow] });
    const queue = supabaseReturnNoteWorkQueue(rest);
    const { id } = await queue.ensureRow(input);
    const at = new Date('2026-11-16T13:00:00.000Z');
    await queue.markEmitted(id, '12', 'bia@jachegou.test', at);
    expect(await queue.markEmitted(id, '13', 'bia@jachegou.test', at)).toBe('conflict');
    expect(await queue.markEmitted(9999, '12', 'bia@jachegou.test', at)).toBe('not_found');
  });

  it('markEmitted numa linha cancelada é conflict', async () => {
    const { fake, rest } = rigged({ invoices: [invoiceRow] });
    const queue = supabaseReturnNoteWorkQueue(rest);
    const { id } = await queue.ensureRow(input);
    fake.rows('outbox_return_notes')[0]!.status = 'cancelada';
    expect(await queue.markEmitted(id, '12', 'bia@jachegou.test', new Date())).toBe('conflict');
  });
});

describe('#156/AC-5 envio mock sobre outbox_supplier_emails', () => {
  const email = (requestId = 'req-1') => ({
    requestId,
    to: 'fiscal@f11.fornecedor.test',
    subject: 'NF 20046 · devolução do item trocado',
    body: 'Olá',
    attachments: [{ filename: 'nota-devolucao-ND-0012.json', contentType: 'application/json', content: '{}' }],
  });

  it('grava o envio com o id do provedor gerado pelo adaptador e canal mock', async () => {
    const { fake, rest } = rigged();
    const sender = supabaseSupplierEmailSender(rest, { newId: () => 'uuid-1' });
    expect(await sender.send(email())).toEqual({ ok: true, providerMessageId: 'mock-uuid-1', channel: 'mock' });
    expect(fake.rows('outbox_supplier_emails')[0]).toMatchObject({
      request_id: 'req-1',
      provider_message_id: 'mock-uuid-1',
      to_address: 'fiscal@f11.fornecedor.test',
      subject: 'NF 20046 · devolução do item trocado',
      body: 'Olá',
      attachments: email().attachments,
    });
  });

  it('reenviar o mesmo pedido devolve o provider_message_id guardado e não grava outro e-mail', async () => {
    const { fake, rest } = rigged();
    let n = 0;
    const sender = supabaseSupplierEmailSender(rest, { newId: () => `uuid-${++n}` });
    const first = await sender.send(email());
    expect(await sender.send(email())).toEqual(first);
    expect(fake.rows('outbox_supplier_emails')).toHaveLength(1);
    expect(await sender.send(email('req-2'))).toMatchObject({ ok: true, providerMessageId: 'mock-uuid-3' });
  });

  it('por padrão o id do provedor é mock- mais um UUID', async () => {
    const { rest } = rigged();
    const result = await supabaseSupplierEmailSender(rest).send(email());
    expect(result).toMatchObject({ ok: true, channel: 'mock' });
    expect(result.ok && result.providerMessageId).toMatch(/^mock-[0-9a-f-]{36}$/);
  });
});

describe('#156 SupplierDirectory sobre supplier_contacts', () => {
  it('devolve o e-mail do fornecedor e null para o que não tem contato', async () => {
    const { rest } = rigged({ supplier_contacts: [{ supplier_id: 'F11', email: 'fiscal@f11.fornecedor.test' }] });
    const directory = supabaseSupplierDirectory(rest);
    expect(await directory.emailOf('F11')).toBe('fiscal@f11.fornecedor.test');
    expect(await directory.emailOf('F99')).toBeNull();
  });
});

describe('#156 a falha do envio não leva o texto nem a resposta do provedor a quem chama', () => {
  it('o pedido guarda o código send_error e o log leva só a operação, a tabela e o status', async () => {
    const PROVIDER_TEXT = 'resposta-do-provedor-com-detalhe-interno';
    const failing = new SupabaseRest({
      url: 'https://fake.supabase.co',
      secretKey: 'sb_secret_fake',
      fetch: async () => new Response(JSON.stringify({ message: PROVIDER_TEXT }), { status: 500 }),
    });
    const w = world();
    const deps = { ...w.deps, sender: supabaseSupplierEmailSender(failing) };
    await openForDecided(deps);
    const id = [...w.requests.rows.keys()][0]!;
    await writeDraft(deps, id, (async () => ({ body: GOOD_BODY })) as Ask);
    const result = await emitAndSend(deps, id, 'ana@jachegou.test');
    expect(result).toMatchObject({ kind: 'ok', status: 'send_failed' });
    const stored = w.requests.rows.get(id);
    expect(stored?.sendFailure).toBe('send_error');
    expect(JSON.stringify(result)).not.toContain(PROVIDER_TEXT);
    expect(w.logs.join('\n')).not.toContain(PROVIDER_TEXT);
    expect(w.logs.join('\n')).toContain('insert em outbox_supplier_emails falhou (HTTP 500)');
  });
});
