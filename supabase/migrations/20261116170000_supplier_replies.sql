-- #157 A resposta do fornecedor ao pedido da #156: a caixa de entrada mock, a leitura do agente, a confirmação
-- #157 do documento citado e a cobrança enviada. Tudo append-only (fatos); o estado de cada pedido é o último
-- #157 fato. Nenhuma tabela aqui aponta para proposta, título ou valor em risco (AC-6). RLS ligado e nenhuma política.

create table public.inbox_supplier_messages (
  id text not null,
  request_id text not null,
  from_address text not null,
  body text not null,
  attachments jsonb not null default '[]'::jsonb,
  received_at timestamptz not null default now(),
  constraint inbox_supplier_messages_pkey primary key (id),
  constraint inbox_supplier_messages_request_fkey foreign key (request_id) references public.supplier_requests (id),
  constraint inbox_supplier_messages_attachments_check check (jsonb_typeof(attachments) = 'array')
);
create index inbox_supplier_messages_request_idx on public.inbox_supplier_messages (request_id, received_at);
create index inbox_supplier_messages_received_idx on public.inbox_supplier_messages (received_at desc);

create table public.supplier_reply_readings (
  id text not null,
  request_id text not null,
  message_id text,
  outcome text not null,
  fulfilled_asks jsonb not null,
  supplier_document text,
  summary text not null,
  next_step text not null,
  follow_up_draft jsonb,
  injection_flag text,
  model text,
  read_at timestamptz not null,
  read_by text not null,
  constraint supplier_reply_readings_pkey primary key (id),
  constraint supplier_reply_readings_request_fkey foreign key (request_id) references public.supplier_requests (id),
  constraint supplier_reply_readings_message_fkey foreign key (message_id) references public.inbox_supplier_messages (id),
  constraint supplier_reply_readings_message_key unique (message_id),
  constraint supplier_reply_readings_outcome_check
    check (outcome in ('fulfilled', 'partially_fulfilled', 'refused', 'needs_information', 'no_reply')),
  constraint supplier_reply_readings_next_step_check
    check (next_step in ('close', 'confirm_document', 'answer_supplier', 'follow_up')),
  -- #157/AC-3 "Atendeu" nunca fecha sozinho: o próximo passo é confirmar o documento.
  constraint supplier_reply_readings_fulfilled_check check (outcome <> 'fulfilled' or next_step = 'confirm_document'),
  constraint supplier_reply_readings_asks_check check (jsonb_typeof(fulfilled_asks) = 'array')
);
create index supplier_reply_readings_request_idx on public.supplier_reply_readings (request_id, read_at);
-- #157/AC-2 Um no_reply só por pedido (a leitura sem resposta).
create unique index supplier_reply_readings_one_no_reply on public.supplier_reply_readings (request_id) where message_id is null;

create table public.supplier_document_confirmations (
  id text not null,
  request_id text not null,
  reading_id text not null,
  confirmed_by text not null,
  confirmed_at timestamptz not null,
  constraint supplier_document_confirmations_pkey primary key (id),
  constraint supplier_document_confirmations_reading_key unique (reading_id),
  constraint supplier_document_confirmations_request_fkey foreign key (request_id) references public.supplier_requests (id),
  constraint supplier_document_confirmations_reading_fkey foreign key (reading_id) references public.supplier_reply_readings (id)
);
create index supplier_document_confirmations_request_idx on public.supplier_document_confirmations (request_id);

-- #157/AC-2 A caixa de saída mock da cobrança: um envio por leitura, só com uma pessoa.
create table public.outbox_supplier_follow_ups (
  id bigint generated always as identity,
  request_id text not null,
  reading_id text not null,
  to_address text not null,
  subject text not null,
  body text not null,
  provider_message_id text not null,
  sent_by text not null,
  published_at timestamptz not null default now(),
  constraint outbox_supplier_follow_ups_pkey primary key (id),
  constraint outbox_supplier_follow_ups_reading_key unique (reading_id),
  constraint outbox_supplier_follow_ups_provider_message_id_key unique (provider_message_id),
  constraint outbox_supplier_follow_ups_request_fkey foreign key (request_id) references public.supplier_requests (id),
  constraint outbox_supplier_follow_ups_reading_fkey foreign key (reading_id) references public.supplier_reply_readings (id)
);
create index outbox_supplier_follow_ups_request_idx on public.outbox_supplier_follow_ups (request_id);

-- #157 Append-only: o banco recusa UPDATE e DELETE (a mesma função da #156).
create trigger inbox_supplier_messages_refuse_change
  before update or delete on public.inbox_supplier_messages
  for each row execute function public.refuse_row_change();
create trigger supplier_reply_readings_refuse_change
  before update or delete on public.supplier_reply_readings
  for each row execute function public.refuse_row_change();
create trigger supplier_document_confirmations_refuse_change
  before update or delete on public.supplier_document_confirmations
  for each row execute function public.refuse_row_change();
create trigger outbox_supplier_follow_ups_refuse_change
  before update or delete on public.outbox_supplier_follow_ups
  for each row execute function public.refuse_row_change();

alter table public.inbox_supplier_messages enable row level security;
alter table public.supplier_reply_readings enable row level security;
alter table public.supplier_document_confirmations enable row level security;
alter table public.outbox_supplier_follow_ups enable row level security;
revoke truncate on public.inbox_supplier_messages, public.supplier_reply_readings,
  public.supplier_document_confirmations, public.outbox_supplier_follow_ups from anon, authenticated, service_role;
