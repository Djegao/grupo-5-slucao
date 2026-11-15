import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/* #156 Verificação estática das migrações do pedido ao fornecedor. Não há pista de banco real neste
 * repositório: isto confere o texto das migrações contra o desenho (supabase/persistence/supplier-requests.md),
 * não o comportamento do Postgres. */

const DIR = new URL('../../../supabase/migrations/', import.meta.url);
const sql = (prefix: string): string => {
  const file = readdirSync(DIR).find((f) => f.startsWith(prefix));
  if (!file) throw new Error(`migração ${prefix} ausente`);
  return readFileSync(new URL(file, DIR), 'utf8');
};
const OURS = readdirSync(DIR).filter((f) => f >= '20261116110000' && f <= '20261116159999');

describe('#156 migrações do pedido ao fornecedor', () => {
  it('são cinco, depois da #211, cada uma com comentário -- #156 e nenhuma com CONCURRENTLY', () => {
    expect(OURS).toHaveLength(5);
    for (const f of OURS) {
      const text = readFileSync(new URL(f, DIR), 'utf8');
      const code = text.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
      expect(text).toContain('-- #156');
      expect(code.toLowerCase()).not.toMatch(/create\s+(unique\s+)?index\s+concurrently/);
    }
  });

  it('toda tabela nova liga o RLS, sem política, e revoga TRUNCATE dos papéis da API', () => {
    const all = OURS.map((f) => readFileSync(new URL(f, DIR), 'utf8')).join('\n');
    for (const table of ['supplier_contacts', 'supplier_requests', 'supplier_request_history', 'return_note_emissions', 'outbox_supplier_emails']) {
      expect(all).toContain(`alter table public.${table} enable row level security;`);
      expect(all).toMatch(new RegExp(`revoke [a-z, ]*truncate on [^;]*public\\.${table}\\b[^;]*from anon, authenticated, service_role;`));
    }
    expect(all.toLowerCase()).not.toContain('create policy');
  });

  it('o índice único parcial de AC-8 cobre só os status abertos', () => {
    expect(sql('20261116120000')).toMatch(
      /create unique index supplier_requests_one_open_key\s+on public\.supplier_requests \(invoice_access_key, request_type\)\s+where status in \('writing', 'draft', 'send_failed'\);/,
    );
  });

  it('o pedido tem os triggers de versão, de colunas fixas e estado terminal, de não apagar e de histórico', () => {
    const text = sql('20261116120000');
    expect(text).toContain('new.version := old.version + 1;');
    expect(text).toContain('new.asks is distinct from old.asks');
    expect(text).toContain("old.status in ('sent', 'discarded')");
    expect(text).toContain('before delete on public.supplier_requests');
    expect(text).toContain('after insert or update on public.supplier_requests');
    expect(text).toContain('to_jsonb(new)');
  });

  it('as tabelas append-only recusam UPDATE e DELETE por trigger', () => {
    expect(sql('20261116120000')).toContain('before update or delete on public.supplier_request_history');
    expect(sql('20261116130000')).toContain('before update or delete on public.return_note_emissions');
    expect(sql('20261116140000')).toContain('before update or delete on public.outbox_supplier_emails');
  });

  it('a função do sequencial é volátil e só o service_role a executa', () => {
    const text = sql('20261116130000');
    expect(text).toMatch(/create function public\.next_return_note_number\(\) returns integer\s+language sql\s+volatile/);
    expect(text).toContain('revoke execute on function public.next_return_note_number() from public, anon, authenticated;');
    expect(text).toContain('grant execute on function public.next_return_note_number() to service_role;');
    expect(text).toContain('grant usage on sequence public.return_note_number_seq to service_role;');
  });

  it('supplier_contacts traz um e-mail .test para cada F01 a F12 e fica só para leitura', () => {
    const text = sql('20261116110000');
    expect(text).toContain("check (email like '%@%.test')");
    expect(text).toContain('generate_series(1, 12)');
    expect(text).toContain('revoke insert, update, delete, truncate on public.supplier_contacts from anon, authenticated, service_role;');
  });

  it('o envio mock é único por pedido e por id do provedor', () => {
    const text = sql('20261116140000');
    expect(text).toContain('outbox_supplier_emails_request_id_key unique (request_id)');
    expect(text).toContain('outbox_supplier_emails_provider_message_id_key unique (provider_message_id)');
  });

  it('o índice das propostas é comum e idempotente', () => {
    expect(sql('20261116150000')).toContain('create index if not exists proposals_state_idx on public.proposals (state, id);');
  });
});
