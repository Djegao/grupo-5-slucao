-- #156 A nota de devolução emitida pelo mock: um fato, uma por linha da fila da #140 (append-only).
-- #156 O sequencial vem de uma sequência exposta por RPC, a primeira função do projeto.
-- #156 RLS ligado e nenhuma política: só a chave secreta lê e grava.

create table public.return_note_emissions (
  note_id text not null,
  queue_row_id bigint not null,
  access_key text not null,
  number integer not null,
  series smallint not null,
  -- #156 A nota inteira no formato do kit: as chaves em português seguem o ADR-001.
  note jsonb not null,
  emitted_at timestamptz not null default now(),
  constraint return_note_emissions_pkey primary key (note_id),
  constraint return_note_emissions_queue_row_id_key unique (queue_row_id),
  constraint return_note_emissions_access_key_key unique (access_key),
  constraint return_note_emissions_number_key unique (number),
  constraint return_note_emissions_queue_row_fkey foreign key (queue_row_id) references public.outbox_return_notes (id),
  constraint return_note_emissions_access_key_check check (access_key ~ '^[0-9]{44}$'),
  constraint return_note_emissions_number_check check (number between 1 and 999999999),
  constraint return_note_emissions_note_id_check check (note->>'nota_id' = note_id), -- ADR-001
  constraint return_note_emissions_chave_check check (note->>'chave' = access_key), -- ADR-001
  constraint return_note_emissions_numero_check check ((note->>'numero')::integer = number) -- ADR-001
);

create trigger return_note_emissions_refuse_change
  before update or delete on public.return_note_emissions
  for each row execute function public.refuse_row_change();

alter table public.return_note_emissions enable row level security;
revoke truncate on public.return_note_emissions from anon, authenticated, service_role;

-- #156 O sequencial do mock: numero é ele e nota_id leva o sufixo. Buracos são aceitos.
create sequence public.return_note_number_seq as integer minvalue 1 maxvalue 999999999 no cycle;

-- #156 VOLATILE: o PostgREST roda o POST de uma função volátil em transação de escrita; nextval falharia em leitura.
create function public.next_return_note_number() returns integer
  language sql
  volatile
  security invoker
  set search_path = ''
as $$ select nextval('public.return_note_number_seq')::integer $$;

-- #156 O Postgres dá EXECUTE a PUBLIC em função nova e o PostgREST expõe em /rpc o que o papel executa.
revoke execute on function public.next_return_note_number() from public, anon, authenticated;
grant execute on function public.next_return_note_number() to service_role;
grant usage on sequence public.return_note_number_seq to service_role;
