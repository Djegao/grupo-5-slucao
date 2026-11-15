-- #156 O pedido ao fornecedor: rascunho que a pessoa edita e cujo status anda (upsert-with-history).
-- #156 O histórico mora em supplier_request_history, escrito por trigger na mesma transação do comando.
-- #156 Nada é apagado: o descarte é status. RLS ligado e nenhuma política: só a chave secreta lê e grava.
-- #156 Desenho: supabase/persistence/supplier-requests.md.

create table public.supplier_requests (
  id text not null,
  created_at timestamptz not null,
  created_by text not null,
  updated_at timestamptz not null,
  updated_by text not null,
  version integer not null default 1,
  invoice_access_key text not null,
  supplier_id text not null,
  request_type text not null,
  to_address text not null,
  subject text not null,
  body text,
  asks jsonb not null,
  attachments jsonb not null default '[]',
  due_on date,
  status text not null,
  send_failure text,
  channel text not null,
  model text,
  drafted_at timestamptz,
  edited_by text,
  edited_at timestamptz,
  sent_by text,
  sent_at timestamptz,
  provider_message_id text,
  discarded_by text,
  discarded_at timestamptz,
  discard_reason text,
  constraint supplier_requests_pkey primary key (id),
  constraint supplier_requests_invoice_fkey foreign key (invoice_access_key) references public.invoices (access_key),
  constraint supplier_requests_type_check check (
    request_type in ('return_note', 'cancel_invoice', 'deliver_missing', 'purchase_order_number', 'registry_data', 'notice')
  ),
  constraint supplier_requests_status_check check (status in ('writing', 'draft', 'sent', 'discarded', 'send_failed')),
  constraint supplier_requests_channel_check check (channel in ('mock', 'resend')),
  constraint supplier_requests_asks_check check (jsonb_typeof(asks) = 'array'),
  constraint supplier_requests_attachments_check check (jsonb_typeof(attachments) = 'array'),
  constraint supplier_requests_sent_check check (
    (status = 'sent') = (sent_by is not null and sent_at is not null and provider_message_id is not null)
  ),
  constraint supplier_requests_discarded_check check (
    (status = 'discarded') = (discarded_by is not null and discarded_at is not null and discard_reason is not null)
  ),
  -- #156 O descarte de um send_failed mantém o motivo, então aqui não é equivalência.
  constraint supplier_requests_send_failed_check check (status <> 'send_failed' or send_failure is not null),
  constraint supplier_requests_drafted_check check (
    status not in ('draft', 'sent', 'send_failed')
    or (body is not null and drafted_at is not null and model is not null and due_on is not null)
  ),
  -- #156 O domínio só envia a devolução com a nota anexa.
  constraint supplier_requests_return_note_attached_check check (
    not (request_type = 'return_note' and status = 'sent') or jsonb_array_length(attachments) > 0
  )
);

create table public.supplier_request_history (
  request_id text not null,
  version integer not null,
  at timestamptz not null,
  by text not null,
  state jsonb not null,
  constraint supplier_request_history_pkey primary key (request_id, version),
  constraint supplier_request_history_request_fkey foreign key (request_id) references public.supplier_requests (id)
);

-- #156 AC-8: um pedido aberto por nota de origem e tipo. Parcial: sent e discarded não bloqueiam o refazer.
create unique index supplier_requests_one_open_key
  on public.supplier_requests (invoice_access_key, request_type)
  where status in ('writing', 'draft', 'send_failed');
create index supplier_requests_invoice_idx on public.supplier_requests (invoice_access_key, created_at);
create index supplier_requests_status_idx on public.supplier_requests (status, created_at);

-- #156 A recusa vale para qualquer papel, inclusive o service_role (BYPASSRLS). Serve às tabelas append-only.
create function public.refuse_row_change() returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  raise exception '% em %.%: a tabela só recebe inserção', tg_op, tg_table_schema, tg_table_name;
end;
$$;

create trigger supplier_requests_refuse_delete
  before delete on public.supplier_requests
  for each row execute function public.refuse_row_change();

create trigger supplier_request_history_refuse_change
  before update or delete on public.supplier_request_history
  for each row execute function public.refuse_row_change();

-- #156 AC-7: os asks e o resto do que o agregado fixa não mudam; estado terminal não anda; a versão sobe aqui.
create function public.supplier_requests_before_update() returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  if new.id is distinct from old.id
    or new.created_at is distinct from old.created_at
    or new.created_by is distinct from old.created_by
    or new.invoice_access_key is distinct from old.invoice_access_key
    or new.supplier_id is distinct from old.supplier_id
    or new.request_type is distinct from old.request_type
    or new.to_address is distinct from old.to_address
    or new.subject is distinct from old.subject
    or new.asks is distinct from old.asks
    or new.channel is distinct from old.channel then
    raise exception 'supplier_requests: coluna fixa do pedido não muda';
  end if;
  if old.status in ('sent', 'discarded') then
    raise exception 'supplier_requests: pedido em estado terminal não muda';
  end if;
  if new.updated_at < old.updated_at then
    raise exception 'supplier_requests: updated_at não anda para trás';
  end if;
  new.version := old.version + 1;
  return new;
end;
$$;

create trigger supplier_requests_before_update
  before update on public.supplier_requests
  for each row execute function public.supplier_requests_before_update();

-- #156 O histórico entra na mesma transação do comando: o estado inteiro depois da mudança.
create function public.supplier_requests_write_history() returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  insert into public.supplier_request_history (request_id, version, at, by, state)
  values (new.id, new.version, new.updated_at, new.updated_by, to_jsonb(new));
  return null;
end;
$$;

create trigger supplier_requests_write_history
  after insert or update on public.supplier_requests
  for each row execute function public.supplier_requests_write_history();

alter table public.supplier_requests enable row level security;
alter table public.supplier_request_history enable row level security;
-- #156 TRUNCATE tem privilégio próprio e o trigger de recusa é de linha.
revoke truncate on public.supplier_requests, public.supplier_request_history from anon, authenticated, service_role;
