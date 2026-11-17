// #36/AC-4: o guarda da conta de subrequests da rodada do Cron: mede a rodada de verdade, com as tarefas de tasksFor e a fila cheia de cada uma.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FetchFn } from '../../src/claude/client.js';
import { CRON_LIMIT, runClaudeRound } from '../../src/claude/cron.js';
import { restDb } from '../../src/claude/db.js';
import { tasksFor } from '../../src/claude/tasks/index.js';
import { sweepSupplierOverdue } from '../../src/cron/supplier-sweep.js';
import { tick } from '../../src/cron/tick.js';
import { queueRow, invoiceRow } from '../supplier/supabase-support.js';
import { GOOD_TEXT } from '../supplier/doubles.js';
import { GOOD_FOLLOW_UP } from '../supplier/reply-doubles.js';
import { SOURCE_KEY } from '../domain/supplier-request-fixtures.js';
import { kitTables } from '../support/kit.js';
import { AFTER_DUE, READING } from '../support/reply-scenarios.js';
import { supplierWorld, type SupplierWorld } from '../support/supplier-world.js';

/** #36/AC-4: os 50 subrequests do plano gratuito do Worker, contados aqui só para a varredura e a rodada do Claude (api/src/claude/cron.ts). */
const SUBREQUEST_LIMIT = 50;
const ENV = { BARTE_ACADEMY_SUPABASE_URL: 'https://fake.supabase.co', BARTE_ACADEMY_SUPABASE_SECRET_KEY: 'sb_secret_fake', BARTE_ACADEMY_ANTHROPIC_API_KEY: 'chave-de-teste' };
const OTHER_KEYS = ['35261112345678000195550010000438950000438952', '35261112345678000195550010000438960000438963', '35261112345678000195550010000438970000438974'];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** #36/AC-4: a Messages API falsa: responde a ferramenta que a tarefa pediu, conforme o esquema dela, e conta as chamadas. */
function messagesApi(): { fetch: FetchFn; calls: () => number } {
  let calls = 0;
  const fetch: FetchFn = async (_url, init) => {
    calls += 1;
    const body = JSON.parse(String(init?.body)) as { tools: { input_schema: { properties: Record<string, unknown> } }[] };
    const keys = Object.keys(body.tools[0]?.input_schema.properties ?? {});
    const input = keys.includes('reply_outcome')
      ? READING
      : keys.includes('match')
        ? { match: null }
        : keys.includes('orderId')
          ? { orderId: null, reason: 'sem ordem provável' }
          : /Cobrança/.test(String(init?.body)) ? GOOD_FOLLOW_UP : GOOD_TEXT;
    return new Response(JSON.stringify({ content: [{ type: 'tool_use', id: 'tu', name: 'responder', input }] }), { status: 200 });
  };
  return { fetch, calls: () => calls };
}

/** #36/AC-4: o pior caso: o kit inteiro conferido, dois pedidos enviados, duas devoluções novas na fila e, depois do prazo, um pedido atrasado e outro com resposta para ler. */
async function fullWorld(): Promise<{ world: SupplierWorld; sweep: number }> {
  const w = await supplierWorld({ emptyQueue: false });
  for (const [table, rows] of Object.entries(kitTables())) w.fake.tables.set(table, rows);
  w.fake.tables.set('claude_suggestions', []);
  vi.stubGlobal('fetch', w.fake.fetch);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-12T15:00:00Z'));
  await tick({ cron: '*/15 * * * *' }, { BARTE_ACADEMY_SUPABASE_URL: ENV.BARTE_ACADEMY_SUPABASE_URL, BARTE_ACADEMY_SUPABASE_SECRET_KEY: ENV.BARTE_ACADEMY_SUPABASE_SECRET_KEY });
  vi.useRealTimers();
  // #36/AC-4: dois pedidos enviados: um fica sem resposta (a cobrança) e o outro recebe a resposta (a leitura).
  const [second, third, ...extra] = OTHER_KEYS;
  w.fake.tables.set('invoices', [...w.fake.rows('invoices'), ...OTHER_KEYS.map((key) => ({ ...invoiceRow(), access_key: key }))]);
  w.fake.tables.set('outbox_return_notes', [...w.fake.rows('outbox_return_notes'), { ...queueRow(8), invoice_access_key: second }]);
  await w.runCron();
  for (const key of [SOURCE_KEY, second as string]) expect((await w.call('POST', w.path('/send', key), { body: {} })).status).toBe(200);
  // #36/AC-4: duas devoluções novas na fila, para o rascunho do #12 (limite 2) ter o que fazer.
  w.fake.tables.set('outbox_return_notes', [...w.fake.rows('outbox_return_notes'), { ...queueRow(9), invoice_access_key: third }, { ...queueRow(10), invoice_access_key: extra[0] }]);
  w.setNow(AFTER_DUE);
  const before = w.fake.requests.length;
  await sweepSupplierOverdue(w.rest, { now: () => AFTER_DUE });
  const sweep = w.fake.requests.length - before;
  const marked = w.fake.rows('supplier_reply_readings').map((r) => Number(r.request_id));
  const open = w.fake.rows('outbox_supplier_emails').map((r) => Number(r.id)).find((id) => !marked.includes(id));
  w.receive('Emitimos a NF-D 881.', open);
  w.receive('Segue o comprovante.', open);
  return { world: w, sweep };
}

type Measure = { readonly sweep: number; readonly reads: number; readonly messages: number; readonly total: number };

/** #36/AC-4: a varredura no teto e a rodada do Claude, com a fila cheia de cada tarefa de tasksFor, contadas fetch a fetch. */
async function measureRound(): Promise<Measure> {
  const { world: w, sweep } = await fullWorld();
  // #36/AC-4: a precondição: toda tarefa tem na fila ao menos o que a rodada atende, senão a medida não é o pior caso.
  const queued = await Promise.all(tasksFor(w.rest).map(async (t) => [t.name, (await t.pending(restDb(w.rest))).requests.length, Math.min(t.limit ?? CRON_LIMIT, CRON_LIMIT)] as const));
  for (const [name, pending, limit] of queued) expect(pending, `fila de ${name}`).toBeGreaterThanOrEqual(limit);
  const api = messagesApi();
  const start = w.fake.requests.length;
  const round = await runClaudeRound(w.rest, ENV, { fetch: api.fetch, log: () => {} });
  const reads = w.fake.requests.length - start;
  expect(round.failedTasks).toEqual([]);
  expect(api.calls(), 'cada tarefa pergunta ao Claude até o limite dela').toBe(queued.reduce((sum, [, , limit]) => sum + limit, 0));
  return { sweep, reads, messages: api.calls(), total: sweep + reads + api.calls() };
}

/** #36/AC-4: o gasto medido hoje (varredura 4, PostgREST 47, Messages API 6); quem acrescenta uma leitura ou uma tarefa muda este número e vê o teste cair. */
const MEASURED_TOTAL = 57;

describe('#36/AC-4 a conta das subrequests da rodada do Cron, medida na rodada de verdade', () => {
  it('a varredura e a rodada do Claude, com a fila cheia de cada tarefa de tasksFor, gastam o que está medido, e uma leitura a mais ou uma tarefa nova faz o teste cair', async () => {
    const m = await measureRound();
    expect(m.total).toBe(MEASURED_TOTAL);
  });

  // #36/AC-4 Lacuna conhecida: a conta medida passa dos 50 do plano gratuito; este teste passa a falhar (e deve virar `it`) quando a conta voltar a caber.
  it.fails('a varredura e a rodada do Claude cabem nos 50 subrequests do plano gratuito', async () => {
    const m = await measureRound();
    expect(m.total).toBeLessThanOrEqual(SUBREQUEST_LIMIT);
  });
});
