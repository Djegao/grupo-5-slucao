-- #156 A caixa de saída mock do e-mail ao fornecedor: um fato por envio (append-only).
-- #156 Idempotente por request_id: o mesmo pedido não gera outro envio. RLS ligado e nenhuma política.

create table public.outbox_supplier_emails (
  id bigint generated always as identity,
  request_id text not null,
  provider_message_id text not null,
  to_address text not null,
  subject text not null,
  body text not null,
  attachments jsonb not null,
  published_at timestamptz not null default now(),
  constraint outbox_supplier_emails_pkey primary key (id),
  constraint outbox_supplier_emails_request_id_key unique (request_id),
  constraint outbox_supplier_emails_provider_message_id_key unique (provider_message_id),
  constraint outbox_supplier_emails_request_fkey foreign key (request_id) references public.supplier_requests (id),
  constraint outbox_supplier_emails_attachments_check check (jsonb_typeof(attachments) = 'array')
);

create trigger outbox_supplier_emails_refuse_change
  before update or delete on public.outbox_supplier_emails
  for each row execute function public.refuse_row_change();

alter table public.outbox_supplier_emails enable row level security;
revoke truncate on public.outbox_supplier_emails from anon, authenticated, service_role;
