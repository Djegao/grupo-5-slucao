-- #156 O e-mail de teste de cada fornecedor do kit, para o pedido ao fornecedor.
-- #156 Tabela própria: o kit espelha a fonte (ADR-001) e o e-mail de teste não existe nela. Sem FK para
-- #156 kit_fornecedores: o kit é carregado depois das migrações. Fornecedor sem contato é tratado pelo caso de uso.
-- #156 Só migrações gravam: INSERT, UPDATE, DELETE e TRUNCATE ficam revogados dos papéis da API.
-- #156 Os endereços usam o domínio reservado .test (RFC 2606), nunca um endereço real.
-- #156 RLS ligado e nenhuma política: só a chave secreta lê.

create table public.supplier_contacts (
  supplier_id text not null,
  email text not null,
  constraint supplier_contacts_pkey primary key (supplier_id),
  constraint supplier_contacts_email_check check (email like '%@%.test')
);

insert into public.supplier_contacts (supplier_id, email)
select 'F' || lpad(n::text, 2, '0'), 'fiscal@f' || lpad(n::text, 2, '0') || '.fornecedor.test'
from generate_series(1, 12) as n;

alter table public.supplier_contacts enable row level security;
revoke insert, update, delete, truncate on public.supplier_contacts from anon, authenticated, service_role;
