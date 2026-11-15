import { describe, expect, it } from 'vitest';
import { proposeChecked } from '../../src/approval/propose-checked.js';
import { supabaseConnectors } from '../../src/connectors/supabase-connectors.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { captureInvoices } from '../../src/cron/capture.js';
import { openForDecided, type SupplierRequestDeps } from '../../src/supplier-requests/index.js';
import { supabaseDecidedProposalSource } from '../../src/supplier-requests/supabase-source.js';
import { supabaseSupplierRequestDeps } from '../../src/supplier-requests/supabase-deps.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';

// #156 A fonte das propostas decididas, sobre as tabelas do domínio e a base do kit num PostgREST falso.

const NOW = new Date('2026-11-16T12:00:00Z');

async function decidedWorld() {
  const fake = new FakePostgrest({ ...kitTables(), supplier_contacts: [] });
  const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch });
  const { captureDeps } = supabaseConnectors(rest);
  await captureInvoices(captureDeps);
  await proposeChecked({ rest, purchasing: captureDeps.purchasing, registry: captureDeps.registry, wms: captureDeps.wms, now: () => NOW });
  return { fake, rest };
}

/** #156 Decide, direto nas linhas, a primeira proposta pendente da classificação: aprovada, com receber parcial devolvendo tudo o que a nota tem do SKU. */
function decide(fake: FakePostgrest, classification: string) {
  const proposal = fake.rows('proposals').find((p) => p.classification === classification && p.state === 'aguardando_aprovacao');
  if (!proposal) throw new Error(`o kit não tem proposta ${classification} pendente`);
  const invoice = fake.rows('invoices').find((i) => i.access_key === proposal.invoice_access_key)!;
  const item = (invoice.items as { sku: string | null; quantity: { amount: number; unit: string } }[]).find((i) => i.sku !== null)!;
  proposal.state = 'aprovada';
  proposal.dock_action = {
    kind: 'receber_parcial',
    lines: [{ sku: item.sku, quantity: { amount: 1, unit: item.quantity.unit }, disposition: 'devolver' }],
  };
  fake.rows('approvals').push({
    id: 900,
    proposal_id: proposal.id,
    approver: 'ana@jachegou.test',
    approver_level: 'diretoria',
    justification: null,
    dock_action: null,
    decided_on: '2026-11-16',
    approved_at: NOW.toISOString(),
  });
  return { proposal, invoice };
}

describe('#156 DecidedProposalSource sobre proposals, invoices, approvals e o kit', () => {
  it('listDecided traz a proposta aprovada com a nota, quem decidiu, a ação e o contexto do catálogo', async () => {
    const { fake, rest } = await decidedWorld();
    const { proposal, invoice } = decide(fake, 'E3');
    const source = supabaseDecidedProposalSource(rest);
    const found = (await source.listDecided()).find((c) => c.invoice.accessKey === proposal.invoice_access_key);
    expect(found).toBeDefined();
    expect(found?.proposal).toMatchObject({ classification: 'E3', state: 'aprovada' });
    expect(found?.proposal.dockAction.kind).toBe('receber_parcial');
    expect(found?.invoice.number).toBe(String(invoice.number));
    expect(found?.decidedBy).toBe('ana@jachegou.test');
    expect(found?.context.products.length).toBeGreaterThan(0);
    expect(found?.context.capturedInvoices.some((i) => i.accessKey === proposal.invoice_access_key)).toBe(false);
  });

  it('goodsEntered é verdadeiro quando o WMS tem recebimento para a nota', async () => {
    const { fake, rest } = await decidedWorld();
    const { proposal } = decide(fake, 'E3');
    const received = fake.rows('kit_recebimentos').some((r) => r.nota_chave === proposal.invoice_access_key);
    const found = (await supabaseDecidedProposalSource(rest).listDecided()).find(
      (c) => c.invoice.accessKey === proposal.invoice_access_key,
    );
    expect(found?.goodsEntered).toBe(received);
  });

  it('find devolve a decidida pela chave e null para a que ainda aguarda ou não existe', async () => {
    const { fake, rest } = await decidedWorld();
    const { proposal } = decide(fake, 'E3');
    const source = supabaseDecidedProposalSource(rest);
    expect((await source.find(String(proposal.invoice_access_key)))?.decidedBy).toBe('ana@jachegou.test');
    const waiting = fake.rows('proposals').find((p) => p.state === 'aguardando_aprovacao')!;
    expect(await source.find(String(waiting.invoice_access_key))).toBeNull();
    expect(await source.find('1'.repeat(44))).toBeNull();
  });

  it('listDecided não traz a proposta que ainda aguarda uma pessoa', async () => {
    const { fake, rest } = await decidedWorld();
    const waiting = fake.rows('proposals').filter((p) => p.state === 'aguardando_aprovacao');
    const listed = new Set((await supabaseDecidedProposalSource(rest).listDecided()).map((c) => c.invoice.accessKey));
    expect(waiting.length).toBeGreaterThan(0);
    expect(waiting.some((p) => listed.has(String(p.invoice_access_key)))).toBe(false);
  });
});

describe('#156 composição de SupplierRequestDeps', () => {
  it('monta as portas sobre o mesmo cliente, escolhe o canal pela configuração e abre o pedido da rodada', async () => {
    const { fake, rest } = await decidedWorld();
    const { proposal } = decide(fake, 'E3');
    // #156 o preço da linha devolvida tem de existir na nota de origem; o contato do fornecedor vem do cadastro
    const invoice = fake.rows('invoices').find((i) => i.access_key === proposal.invoice_access_key)!;
    fake.rows('supplier_contacts').push({ supplier_id: invoice.supplier_id, email: 'fiscal@f01.fornecedor.test' });
    const logs: string[] = [];
    const deps: SupplierRequestDeps = supabaseSupplierRequestDeps(rest, {
      issuerCnpj: '12.345.678/0001-95',
      resendApiKey: null,
      log: (l) => logs.push(l),
      clock: { now: () => NOW },
    });
    expect(deps.config).toEqual({ issuerCnpj: '12.345.678/0001-95', channel: 'mock' });
    const result = await openForDecided(deps);
    expect(result.opened).toHaveLength(1);
    expect(fake.rows('supplier_requests')).toHaveLength(1);
    expect(fake.rows('supplier_requests')[0]).toMatchObject({ status: 'writing', request_type: 'return_note', to_address: 'fiscal@f01.fornecedor.test', channel: 'mock' });
    expect(fake.rows('outbox_return_notes')).toHaveLength(1);
    const again = await openForDecided(deps);
    expect(again.opened).toEqual([]);
    expect(fake.rows('supplier_requests')).toHaveLength(1);
  });
});
