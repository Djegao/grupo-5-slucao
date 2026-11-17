// #13: o "mundo" dos testes do pedido ao fornecedor pela API: o Worker montado, o PostgREST falso com o kit e a fila,
// #13: o Access assinado no teste, o Cron do rascunho e as chamadas HTTP. Nenhuma rede: tudo cai no FakePostgrest.
import { ClaudeClient, type Ask } from '../../src/claude/client.js';
import { restDb } from '../../src/claude/db.js';
import { runTasks } from '../../src/claude/runner.js';
import type { Env } from '../../src/env.js';
import type { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { route } from '../../src/http/router.js';
import type { SupplierMailer } from '../../src/supplier/ports.js';
import { supplierRequestDraftTask } from '../../src/supplier/draft-task.js';
import { supplierDeps } from '../../src/supplier/supabase-deps.js';
import { SOURCE_KEY } from '../domain/supplier-request-fixtures.js';
import { NOW, fakeAsk } from '../supplier/doubles.js';
import { harness, invoiceRow, queueRow, supplierRow } from '../supplier/supabase-support.js';
import { accessEnv, accessKit } from './access-token.js';
import type { FakePostgrest } from './fake-postgrest.js';

export type WorldOptions = {
  /** #13: o e-mail da identidade do Access; vazio é um service token, sem e-mail. */
  readonly email?: string;
  readonly mailer?: SupplierMailer;
  /** #13: o `Ask` do "refazer"; sem ele, o do Env (sem credencial, nenhum). */
  readonly ask?: Ask | null;
  /** #13: `missing` simula o Worker sem as credenciais do Supabase. */
  readonly supabase?: 'ok' | 'missing';
  readonly env?: Env;
  /** #13: sem a devolução pendente na fila. */
  readonly emptyQueue?: boolean;
};

export type Reply = { readonly status: number; readonly body: Record<string, unknown>; readonly headers: Headers };

export type CallInit = { readonly body?: unknown; readonly json?: boolean; readonly token?: boolean; readonly raw?: string };

const JSON_TYPE = { 'Content-Type': 'application/json' };

export type SupplierWorld = {
  readonly fake: FakePostgrest;
  readonly rest: SupabaseRest;
  readonly call: (method: string, path: string, init?: CallInit) => Promise<Reply>;
  readonly runCron: (ask?: Ask) => Promise<readonly string[]>;
  readonly path: (suffix?: string, key?: string) => string;
  readonly rows: (table: string) => Record<string, unknown>[];
  readonly key: string;
};

export async function supplierWorld(options: WorldOptions = {}): Promise<SupplierWorld> {
  const { fake, rest } = harness({
    invoices: [invoiceRow()],
    kit_fornecedores: [supplierRow()],
    outbox_return_notes: options.emptyQueue ? [] : [queueRow()],
  });
  const kit = await accessKit(options.email ?? 'ana@jachegou.test');
  const token = await kit.token();
  const clock = { now: () => NOW };
  const env: Env = { ...accessEnv, ...options.env };
  const supplierRequests = {
    supabase: () => (options.supabase === 'missing' ? null : rest),
    clock,
    ...(options.mailer ? { mailer: options.mailer } : {}),
    ...(options.ask !== undefined ? { ask: () => options.ask ?? null } : {}),
  };

  /** #13: uma chamada HTTP pelo roteador de verdade; escrita leva JSON por padrão. */
  async function call(method: string, path: string, init: CallInit = {}): Promise<Reply> {
    const writing = method !== 'GET';
    const headers: Record<string, string> = { ...(init.token === false ? {} : { 'Cf-Access-Jwt-Assertion': token }) };
    if (writing && init.json !== false) Object.assign(headers, JSON_TYPE);
    const text = !writing ? undefined : (init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)));
    const request = new Request(`https://worker.test${path}`, { method, headers, ...(text === undefined ? {} : { body: text }) });
    const response = await route(request, env, { verifier: kit.verifier, supplierRequests });
    const body: unknown = await response.json();
    return { status: response.status, body: typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}, headers: response.headers };
  }

  /** #13/AC-1 (#2): o Cron roda a tarefa do rascunho com o Claude falso: o mesmo laço da produção, só a pergunta é nossa. */
  async function runCron(ask: Ask = fakeAsk()): Promise<readonly string[]> {
    const log: string[] = [];
    await runTasks({
      db: restDb(rest),
      ask,
      tasks: [supplierRequestDraftTask(supplierDeps(rest, { clock }))],
      log: (line) => log.push(line),
      now: clock.now,
    });
    return log;
  }

  const path = (suffix = '', key = SOURCE_KEY): string => `/api/supplier-requests/${key}${suffix}`;
  const rows = (table: string) => fake.rows(table);
  return { fake, rest, call, runCron, path, rows, key: SOURCE_KEY };
}

/** #13: um `Ask` de verdade (o cliente do Claude) sobre um fetch falso que responde com o status dado. */
export const askFailingWith = (status: number): Ask =>
  new ClaudeClient({ credentials: { kind: 'api-key', apiKey: 'chave-de-teste' }, fetch: async () => new Response('{}', { status }) }).ask;
