// #156: o mundo da API do pedido ao fornecedor: o Worker montado, o Cron, o kit decidido e o Claude falso.
import { proposeChecked } from '../../src/approval/propose-checked.js';
import type { Ask } from '../../src/claude/client.js';
import { supabaseConnectors } from '../../src/connectors/supabase-connectors.js';
import { SupabaseRest, type FetchFn } from '../../src/connectors/supabase-rest.js';
import { captureInvoices } from '../../src/cron/capture.js';
import { runSupplierRequestsRound } from '../../src/cron/supplier-requests.js';
import type { Env } from '../../src/env.js';
import type { AccessVerifier } from '../../src/http/access.js';
import { createWorker } from '../../src/index.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';

type Row = Record<string, unknown>;

export const NOW = new Date('2026-11-16T12:00:00Z');
export const ANALYST = 'ana@jachegou.test';
export const ENV: Env = {
  ACCESS_AUD: 'aud',
  ACCESS_TEAM_DOMAIN: 'time.cloudflareaccess.com',
  BARTE_ACADEMY_SUPABASE_URL: 'https://fake.supabase.co',
  BARTE_ACADEMY_SUPABASE_SECRET_KEY: 'sb_secret_fake',
};
const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;

/** #156: a nota 45321 do F11 (E2 do kit) e a 13745 do F07 (E3). */
export const E2_NUMBER = '45321';
export const E3_NUMBER = '13745';

export type World = WorldParts;
type WorldParts = {
  fake: FakePostgrest;
  rest: SupabaseRest;
  call: (path: string, method?: string, body?: unknown, env?: Env, token?: boolean) => Promise<Response>;
  cron: (ask?: Ask, env?: Env) => ReturnType<typeof runSupplierRequestsRound>;
  failOutbox: { remaining: number };
  broken: Set<string>;
};

type WorldOptions = { email?: string | null; failOutbox?: { remaining: number } };
export async function buildWorld(options: WorldOptions = {}): Promise<WorldParts> {
  const fake = new FakePostgrest({ ...kitTables(), supplier_contacts: [] });
  fake.uniques.push({
    table: 'supplier_requests',
    name: 'supplier_requests_one_open_key',
    columns: ['invoice_access_key', 'request_type'],
    where: (r) => ['writing', 'draft', 'send_failed'].includes(String(r.status)),
  });
  const failOutbox = options.failOutbox ?? { remaining: 0 };
  const broken = new Set<string>();
  const fetch: FetchFn = async (input, init) => {
    if (failOutbox.remaining > 0 && input.includes('/rest/v1/outbox_supplier_emails') && init?.method === 'POST') {
      failOutbox.remaining -= 1;
      return new Response('{"message":"SEGREDO-DO-PROVEDOR relation outbox_supplier_emails"}', { status: 500 });
    }
    for (const table of broken) {
      if (input.includes(`/rest/v1/${table}`)) return new Response('{"message":"SEGREDO-DO-PROVEDOR tabela interna"}', { status: 500 });
    }
    return fake.fetch(input, init);
  };
  const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch });
  const { captureDeps } = supabaseConnectors(rest);
  await captureInvoices(captureDeps);
  await proposeChecked({ rest, purchasing: captureDeps.purchasing, registry: captureDeps.registry, wms: captureDeps.wms, now: () => NOW });

  let n = 0;
  const ids = { next: () => `req-${++n}` };
  const clock = { now: () => NOW };
  const email = options.email === undefined ? ANALYST : options.email;
  const verifier: AccessVerifier = { verify: async () => ({ ok: true, identity: { email } }) };
  const supabase = (env: Env) => (env.BARTE_ACADEMY_SUPABASE_URL ? rest : null);
  const worker = createWorker({
    verifier,
    returnNotes: { supabase, now: () => NOW },
    supplierRequests: { supabase, clock, ids },
  });
  const call = (path: string, method = 'GET', body?: unknown, env: Env = ENV, token = true) =>
    worker.fetch(
      new Request(`https://worker.test${path}`, {
        method,
        headers: { ...(token ? { 'Cf-Access-Jwt-Assertion': 'token' } : {}), 'content-type': 'application/json' },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      }),
      env,
      ctx,
    );
  const cron = (ask?: Ask, env: Env = ENV) => runSupplierRequestsRound(rest, env, { ask, clock, ids, log: () => {} });
  return { fake, rest, call, cron, failOutbox, broken };
}

/** #156: decide, direto nas linhas, a proposta da nota com receber parcial devolvendo `amount` do primeiro item com SKU. */
type Decided = { key: string; invoice: Row; item: Row; supplierId: string };
export function decide(fake: FakePostgrest, classification: string, number: string, amount = 1): Decided {
  const invoice = fake.rows('invoices').find((i) => String(i.number) === number)!;
  const proposal = fake.rows('proposals').find((p) => p.invoice_access_key === invoice.access_key && p.classification === classification)!;
  const items = invoice.items as { sku: string | null; supplierCode: string; description: string; quantity: { amount: number; unit: string } }[];
  const item = items.find((i) => i.sku !== null)!;
  proposal.state = 'aprovada';
  proposal.dock_action = {
    kind: 'receber_parcial',
    lines: [{ sku: item.sku, quantity: { amount, unit: item.quantity.unit }, disposition: 'devolver' }],
  };
  fake.rows('approvals').push({
    id: 900 + fake.rows('approvals').length,
    proposal_id: proposal.id,
    approver: ANALYST,
    approver_level: 'diretoria',
    justification: null,
    dock_action: null,
    decided_on: '2026-11-16',
    approved_at: NOW.toISOString(),
  });
  fake.rows('supplier_contacts').push({ supplier_id: invoice.supplier_id, email: `fiscal@${String(invoice.supplier_id).toLowerCase()}.fornecedor.test` });
  return { key: String(invoice.access_key), invoice, item: item as Row, supplierId: String(invoice.supplier_id) };
}

/** #156: o Claude falso, nunca a rede. Devolve o texto dado ou um bom corpo só de marcadores. */
export function fakeAsk(body: string | ((prompt: string) => string)): Ask & { readonly calls: string[] } {
  const calls: string[] = [];
  const ask: Ask = <T>(options: { readonly prompt: string }): Promise<T> => {
    calls.push(options.prompt);
    const answer: unknown = { body: typeof body === 'function' ? body(options.prompt) : body };
    return Promise.resolve(answer as T);
  };
  return Object.assign(ask, { calls });
}

/** #156: um corpo bom: todo número é um marcador do catálogo; o código do item vem da proposta decidida. */
export const goodBody = (code: string): string =>
  `Olá. Na NF {{nota.numero}} veio {{devolucao.item[${code}].descricao}} ({{devolucao.item[${code}].quantidade}}, {{devolucao.valor_total}}). Pedimos a retirada até {{pedido.prazo}}.`;

/** #156: centavos como o catálogo os escreve (sem separador de milhar, só para valores abaixo de R$ 1.000,00). */
export const brl = (cents: number): string => `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;

/** #156: um texto reescrito que mantém o mesmo conjunto de marcadores, como a edição exige. */
export const rewrittenBody = (code: string): string =>
  `Olá, equipe. Sobre a NF {{nota.numero}}: {{devolucao.item[${code}].descricao}}, {{devolucao.item[${code}].quantidade}}, total {{devolucao.valor_total}}. Retirar até {{pedido.prazo}}.`;
