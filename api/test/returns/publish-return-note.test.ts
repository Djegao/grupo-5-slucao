import { describe, expect, it } from 'vitest';
import type { Published, ReturnNoteMessage, ReturnNoteOutbox } from '../../src/connectors/ports.js';
import { DockAction, Invoice, Money, Quantity, type Classification, type Product, type Receipt, type Unit } from '../../src/domain/index.js';
import type { DecidedReturnSource } from '../../src/returns/decided-return-source.js';
import { publishReturnNote, type DecidedReturnCase } from '../../src/returns/publish-return-note.js';
import { sweepReturnNotes } from '../../src/returns/sweep-return-notes.js';

const KEY = '35261100000000000000550010000099991000099999';
const OTHER_KEY = '35261100000000000000550010000088881000088888';

const item = (code: string, sku: string, amount: number, unit: Unit = 'UN') => ({
  supplierCode: code,
  sku,
  description: `Item ${code}`,
  quantity: Quantity.of(amount, unit),
  unitPrice: Money.ofCents(1000),
  total: Money.ofCents(1000 * amount),
});

const invoiceOf = (accessKey: string, number: string) =>
  Invoice.receive({
    accessKey,
    number,
    series: '1',
    supplierId: 'F08',
    store: 'LJ-001',
    issuedOn: '2026-11-10',
    purchaseOrderRef: 'OC-1',
    entryChannel: 'SEFAZ',
    items: [item('F08-001', 'SKU-1', 100), item('F08-003', 'SKU-3', 50)],
    total: Money.ofCents(150_000),
  });

const receipt = (id: string, receivedOn: string, items: readonly [string, number][], accessKey: string | null = KEY): Receipt => ({
  id,
  invoiceAccessKey: accessKey,
  purchaseOrderId: 'OC-1',
  supplierId: 'F08',
  store: 'LJ-001',
  receivedOn,
  items: items.map(([supplierCode, amount]) => ({ supplierCode, description: supplierCode, quantity: Quantity.of(amount, 'UN') })),
  note: '',
});

const NO_PRODUCTS: readonly Product[] = [];

function decided(
  classification: Classification,
  dockAction: DockAction,
  over: Partial<DecidedReturnCase> = {},
  accessKey = KEY,
): DecidedReturnCase {
  return {
    invoice: invoiceOf(accessKey, accessKey === KEY ? '9999' : '8888'),
    decision: { classification, state: 'aprovada', dockAction, decidedOn: '2026-11-12' },
    receipts: [],
    products: NO_PRODUCTS,
    ...over,
  };
}

const partialE3 = () =>
  DockAction.partial([{ sku: 'SKU-1', quantity: Quantity.of(20, 'UN'), disposition: 'devolver' }]);

/** Dublê em memória da caixa de saída: idempotente pela nota, como a real, e conta as chamadas. */
function memoryOutbox(seed: readonly ReturnNoteMessage[] = []) {
  const rows: Published<ReturnNoteMessage>[] = seed.map((m, i) => ({ ...m, id: i + 1, publishedAt: '2026-11-12T10:00:00Z' }));
  const calls = { publish: 0, list: 0 };
  const outbox: ReturnNoteOutbox = {
    publish: (message) => {
      calls.publish += 1;
      const row = { ...message, id: rows.length + 1, publishedAt: '2026-11-12T11:00:00Z' };
      rows.push(row);
      return Promise.resolve(row);
    },
    list: () => {
      calls.list += 1;
      return Promise.resolve([...rows]);
    },
  };
  return { outbox, rows, calls };
}

function memorySource(cases: readonly DecidedReturnCase[]) {
  const calls = { listDecided: 0 };
  const source: DecidedReturnSource = {
    listDecided: () => {
      calls.listDecided += 1;
      return Promise.resolve(cases);
    },
  };
  return { source, calls };
}

const queued = (accessKey: string): ReturnNoteMessage => ({
  invoiceAccessKey: accessKey,
  lines: [{ supplierCode: 'F08-001', quantity: Quantity.of(1, 'UN') }],
  reason: 'já na fila',
});

describe('publicar a devolução de uma decisão: publishReturnNote', () => {
  it('#1/AC-1 #7/AC-1: decisão que devolve grava a nota na caixa de saída e a devolve', async () => {
    const { outbox, rows } = memoryOutbox();
    const published = await publishReturnNote(decided('E3', partialE3()), outbox);
    expect(rows).toHaveLength(1);
    expect(published?.invoiceAccessKey).toBe(KEY);
    expect(rows[0]?.lines.map((l) => [l.supplierCode, l.quantity.amount, l.quantity.unit])).toEqual([['F08-001', 20, 'UN']]);
  });

  it('#1/AC-8 #7/AC-1: decisão que não devolve não grava nada e devolve null', async () => {
    const { outbox, rows, calls } = memoryOutbox();
    expect(await publishReturnNote(decided('MATCH', DockAction.receive()), outbox)).toBeNull();
    expect(await publishReturnNote(decided('E4', DockAction.receive()), outbox)).toBeNull();
    expect(rows).toHaveLength(0);
    expect(calls.publish).toBe(0);
  });

  it('#1/AC-5 #7/AC-1: recusa sem recebimento até o dia da decisão não grava nada', async () => {
    const { outbox, rows } = memoryOutbox();
    const late = [receipt('RC-9', '2026-11-13', [['F08-001', 100]])];
    expect(await publishReturnNote(decided('E1', DockAction.refuse(), { receipts: late }), outbox)).toBeNull();
    expect(await publishReturnNote(decided('E1', DockAction.refuse()), outbox)).toBeNull();
    expect(rows).toHaveLength(0);
  });

  it('#1/AC-4 #7/AC-1: recusa com um recebimento do dia da decisão devolve o que entrou', async () => {
    const { outbox, rows } = memoryOutbox();
    const r = [receipt('RC-1', '2026-11-12', [['F08-001', 40]])];
    await publishReturnNote(decided('E1', DockAction.refuse(), { receipts: r }), outbox);
    expect(rows[0]?.lines.map((l) => [l.supplierCode, l.quantity.amount])).toEqual([['F08-001', 40]]);
  });

  it('#1/AC-4 #7/AC-3: nota contada em mais de um recebimento junta todos os itens, sem subcontar', async () => {
    const { outbox, rows } = memoryOutbox();
    const r = [
      receipt('RC-1', '2026-11-11', [['F08-001', 40]]),
      receipt('RC-2', '2026-11-12', [['F08-001', 30], ['F08-003', 10]]),
    ];
    await publishReturnNote(decided('E1', DockAction.refuse(), { receipts: r }), outbox);
    expect(rows[0]?.lines.map((l) => [l.supplierCode, l.quantity.amount])).toEqual([
      ['F08-001', 70],
      ['F08-003', 10],
    ]);
  });

  it('#1/AC-4 #7/AC-3: só entram os recebimentos do dia da decisão ou anteriores', async () => {
    const { outbox, rows } = memoryOutbox();
    const r = [receipt('RC-1', '2026-11-12', [['F08-001', 40]]), receipt('RC-2', '2026-11-13', [['F08-001', 30]])];
    await publishReturnNote(decided('E1', DockAction.refuse(), { receipts: r }), outbox);
    expect(rows[0]?.lines.map((l) => l.quantity.amount)).toEqual([40]);
  });

  it('#1/AC-4 #7/AC-3: recebimento de outra nota ou sem nota não entra na soma', async () => {
    const { outbox, rows } = memoryOutbox();
    const r = [
      receipt('RC-1', '2026-11-12', [['F08-001', 40]]),
      receipt('RC-2', '2026-11-12', [['F08-001', 30]], OTHER_KEY),
      receipt('RC-3', '2026-11-12', [['F08-001', 20]], null),
    ];
    await publishReturnNote(decided('E1', DockAction.refuse(), { receipts: r }), outbox);
    expect(rows[0]?.lines.map((l) => l.quantity.amount)).toEqual([40]);
  });

  it('#1/AC-4 #7/AC-3: a ordem dos recebimentos não muda a nota publicada', async () => {
    const a = memoryOutbox();
    const b = memoryOutbox();
    const r = [receipt('RC-1', '2026-11-11', [['F08-001', 40]]), receipt('RC-2', '2026-11-12', [['F08-003', 10]])];
    await publishReturnNote(decided('E1', DockAction.refuse(), { receipts: r }), a.outbox);
    await publishReturnNote(decided('E1', DockAction.refuse(), { receipts: [...r].reverse() }), b.outbox);
    expect(a.rows[0]?.lines).toEqual(b.rows[0]?.lines);
  });
});

describe('a varredura das decisões: sweepReturnNotes', () => {
  it('#1/AC-6 #7/AC-2: publica a devolução de toda decisão que devolve e ainda não está na fila', async () => {
    const { outbox, rows } = memoryOutbox();
    const { source } = memorySource([
      decided('E3', partialE3()),
      decided('E3', partialE3(), {}, OTHER_KEY),
      decided('MATCH', DockAction.receive(), {}, '35261100000000000000550010000077771000077777'),
    ]);
    const result = await sweepReturnNotes(source, outbox);
    expect(result).toEqual({ published: 2, alreadyQueued: 0, withoutReturn: 1 });
    expect(rows.map((r) => r.invoiceAccessKey)).toEqual([KEY, OTHER_KEY]);
  });

  it('#1/AC-7 #7/AC-3: com tudo na fila, em qualquer situação, não publica de novo', async () => {
    const { outbox, calls } = memoryOutbox([queued(KEY), queued(OTHER_KEY)]);
    const { source } = memorySource([decided('E3', partialE3()), decided('E3', partialE3(), {}, OTHER_KEY)]);
    const result = await sweepReturnNotes(source, outbox);
    expect(result).toEqual({ published: 0, alreadyQueued: 2, withoutReturn: 0 });
    expect(calls.publish).toBe(0);
  });

  it('#1/AC-7 #7/AC-3: rodar duas vezes seguidas deixa uma linha só por nota', async () => {
    const { outbox, rows } = memoryOutbox();
    const { source } = memorySource([decided('E3', partialE3())]);
    await sweepReturnNotes(source, outbox);
    const second = await sweepReturnNotes(source, outbox);
    expect(second.published).toBe(0);
    expect(rows).toHaveLength(1);
  });

  it('#1/AC-7 #7/AC-3: duas decisões da mesma nota na mesma rodada publicam uma vez só', async () => {
    const { outbox, rows } = memoryOutbox();
    const { source } = memorySource([decided('E3', partialE3()), decided('E3', partialE3())]);
    const result = await sweepReturnNotes(source, outbox);
    expect(result.published).toBe(1);
    expect(rows).toHaveLength(1);
  });

  it('#1/AC-6 #7/AC-2: uma leitura da fonte, uma listagem da fila e uma publicação por nota nova', async () => {
    const { outbox, calls } = memoryOutbox([queued(OTHER_KEY)]);
    const { source, calls: sourceCalls } = memorySource([
      decided('E3', partialE3()),
      decided('E3', partialE3(), {}, OTHER_KEY),
    ]);
    await sweepReturnNotes(source, outbox);
    expect(sourceCalls.listDecided).toBe(1);
    expect(calls.list).toBe(1);
    expect(calls.publish).toBe(1);
  });

  it('#1/AC-8 #7/AC-2: sem decisão que devolva, não publica nada', async () => {
    const { outbox, calls } = memoryOutbox();
    const { source } = memorySource([decided('E5', DockAction.receive())]);
    expect(await sweepReturnNotes(source, outbox)).toEqual({ published: 0, alreadyQueued: 0, withoutReturn: 1 });
    expect(calls.publish).toBe(0);
  });
});
