# Desenho de persistência: pedido ao fornecedor e nota de devolução emulada

Issue: #156 (escopo do dono: `request_type = return_note`, só o ramo receber parcial E1, E2, E3; a recusa fica fora). Banco: PostgreSQL 17 no Supabase (`supabase/config.toml`, `major_version = 17`), acessado pelo Worker só pelo PostgREST (`api/src/connectors/supabase-rest.ts`). Registro: `supabase/persistence-modes.yaml`.

A camada de OLTP escreve as migrações e os adaptadores contra este desenho. Toda afirmação sobre o banco cita a página que a sustenta.

## Entradas

| Entrada | Valor | Fonte |
|---|---|---|
| Agregados e raízes | `SupplierRequest` (raiz, editado pela pessoa, status anda); `ReturnNote` emitida (fato, uma por linha da fila); a linha da fila da #140 (`outbox_return_notes`, raiz da #140) | `api/src/domain/supplier-request.ts`, `api/src/domain/return-note-emission.ts` |
| Portas a implementar | `SupplierRequestRepository`, `ReturnNoteEmissions`, `ReturnNoteWorkQueue`, `SupplierEmailSender` (mock), `SupplierDirectory`, `DecidedProposalSource` | `api/src/supplier-requests/ports.ts` |
| Consultas | Q1 `findById`; Q2 `listByInvoice` (do mais antigo ao mais novo); Q3 `listByStatus('writing')` (rodada do Cron, até `MAX_PER_RUN`); Q4 `save` condicional por id e `updated_at`; Q5 `findByQueueRow`; Q6 `findByNoteId`; Q7 `nextSequence`; Q8 `save` da emissão com vencedor da corrida; Q9 `ensureRow` por `idempotency_key`; Q10 `markEmitted` (PATCH por id e `status=pendente`); Q11 envio mock por `request_id`; Q12 `emailOf(supplierId)`; Q13 `listDecided` (propostas `aprovada`/`alterada`); Q14 `find(invoiceAccessKey)` (proposta, nota, aprovação) | portas e casos de uso em `api/src/supplier-requests/` |
| Inquilino | nenhum: uma empresa só; `supplier_id` é a contraparte | issue, `docs/domain` |
| Números assumidos | linhas por tabela: não informado (o kit tem 12 fornecedores); ritmo de pedidos: não informado | |

## Tabelas

| Tabela | Modo | Por quê | Histórico: forma e lugar | Versão | Inquilino |
|---|---|---|---|---|---|
| `supplier_requests` | upsert-with-history | o rascunho é uma entidade que a pessoa edita (AC-7) e cujo status anda; o agregado já é modelado como estado atual com `save(request, expectedUpdatedAt)` | tabela filha `supplier_request_history (request_id, version, at, by, state jsonb)`, escrita pelo trigger `AFTER INSERT OR UPDATE` com `to_jsonb(new)` (o estado inteiro depois) | `version integer not null default 1`, incrementada pelo trigger `BEFORE UPDATE` | nenhum |
| `supplier_request_history` | append-only | cada registro é um fato: o pedido ficou assim, por alguém, em tal instante | n/a | n/a | nenhum |
| `return_note_emissions` | append-only | a emissão é um fato; emitir de novo a mesma linha devolve a mesma nota (AC-4) | n/a | n/a | nenhum |
| `outbox_supplier_emails` | append-only | cada envio mock é um fato; o mesmo `request_id` não gera outro (AC-5) | n/a | n/a | nenhum |
| `supplier_contacts` | append-only, `growth: fixed` | o e-mail de teste por fornecedor, gravado só por migração | n/a | n/a | nenhum |

O histórico em `jsonb` ao lado da entidade é a forma que `docs/entity-history.md` do plugin dá para um banco com JSON indexável, e o PostgreSQL tem `jsonb` com índice ([jsonb Indexing](https://www.postgresql.org/docs/current/datatype-json.html#JSON-INDEXING)).

### `supplier_requests`

Colunas (nomes em inglês, a regra de linguagem; nenhum literal do kit aqui):

`id text` (PK; a identidade vem do `IdGenerator` do Worker, o domínio não gera ids), `created_at timestamptz`, `created_by text`, `updated_at timestamptz`, `updated_by text`, `version integer not null default 1`, `invoice_access_key text not null` (FK `invoices(access_key)`, sem cascade), `supplier_id text not null`, `request_type text not null` (check nos seis tipos do domínio), `to_address text not null` (`to` é palavra reservada), `subject text not null`, `body text`, `asks jsonb not null` (check `jsonb_typeof(asks) = 'array'`), `attachments jsonb not null default '[]'` (array), `due_on date`, `status text not null` (check `writing|draft|sent|discarded|send_failed`), `send_failure text`, `channel text not null` (check `mock|resend`), `model text`, `drafted_at timestamptz`, `edited_by text`, `edited_at timestamptz`, `sent_by text`, `sent_at timestamptz`, `provider_message_id text`, `discarded_by text`, `discarded_at timestamptz`, `discard_reason text`.

Checks de consistência, no estilo das da #140 (`outbox_return_notes_emitida_check`):

- `(status = 'sent') = (sent_by is not null and sent_at is not null and provider_message_id is not null)`;
- `(status = 'discarded') = (discarded_by is not null and discarded_at is not null and discard_reason is not null)`;
- `status <> 'send_failed' or send_failure is not null` (o descarte de um `send_failed` mantém o motivo, então não é equivalência);
- `status not in ('draft', 'sent', 'send_failed') or (body is not null and drafted_at is not null and model is not null and due_on is not null)`;
- `not (request_type = 'return_note' and status = 'sent') or jsonb_array_length(attachments) > 0` (o domínio só envia a devolução com a nota anexa).

Triggers (PL/pgSQL; um `BEFORE` de linha pode devolver `NEW` modificado e um erro no trigger desfaz o comando e o trigger juntos, [Overview of Trigger Behavior](https://www.postgresql.org/docs/current/trigger-definition.html), [Trigger Functions](https://www.postgresql.org/docs/current/plpgsql-trigger.html)):

1. `BEFORE UPDATE`: recusa (`raise exception`) se mudou alguma coluna fixa do agregado (`id`, `created_at`, `created_by`, `invoice_access_key`, `supplier_id`, `request_type`, `to_address`, `subject`, `asks`, `channel`: AC-7 trava os asks); recusa se o status antigo é terminal (`sent`, `discarded`); recusa se `new.updated_at < old.updated_at`; faz `new.version := old.version + 1`.
2. `BEFORE DELETE`: recusa. Nada é apagado (PER-5); o descarte é `status = 'discarded'` com quem, quando e o motivo.
3. `AFTER INSERT OR UPDATE`: insere em `supplier_request_history` `(new.id, new.version, new.updated_at, new.updated_by, to_jsonb(new))`. Roda na mesma transação da requisição: "a trigger is executed as part of the same transaction as the statement that triggered it, so if either the statement or the trigger causes an error, the effects of both will be rolled back" ([trigger-definition](https://www.postgresql.org/docs/current/trigger-definition.html)). É isso que dá PER-3 e TRX-1 com uma só chamada ao PostgREST.

A recusa por trigger vale para qualquer papel, inclusive o `service_role` da chave secreta, que tem `BYPASSRLS` ([Supabase: API keys](https://supabase.com/docs/guides/api/api-keys)). `TRUNCATE` tem privilégio próprio, fora de `DELETE` ([Privileges](https://www.postgresql.org/docs/current/ddl-priv.html)), e o trigger de recusa é de linha: a migração revoga `TRUNCATE` de `anon`, `authenticated` e `service_role` nas cinco tabelas.

### `supplier_request_history`

`request_id text not null` (FK `supplier_requests(id)`), `version integer not null`, `at timestamptz not null`, `by text not null`, `state jsonb not null`; PK `(request_id, version)`. Trigger `BEFORE UPDATE OR DELETE` que recusa. O adaptador nunca escreve aqui; só o trigger.

### `return_note_emissions`

`note_id text` (PK, o `nota_id` `ND-nnnn`), `queue_row_id bigint not null` (unique, FK `outbox_return_notes(id)`), `access_key text not null` (unique, check `access_key ~ '^[0-9]{44}$'`), `number integer not null` (unique, check `number between 1 and 999999999`, o teto do domínio), `series smallint not null`, `note jsonb not null` (a nota inteira no formato do kit: as chaves em português do JSON seguem o ADR-001, por serem cópia do formato de `data/kit/notas.json`), `emitted_at timestamptz not null default now()`. Checks de coerência entre colunas e documento: `note->>'nota_id' = note_id`, `note->>'chave' = access_key`, `(note->>'numero')::integer = number`. Trigger `BEFORE UPDATE OR DELETE` que recusa.

### `outbox_supplier_emails`

`id bigint generated always as identity` (PK), `request_id text not null` (unique, FK `supplier_requests(id)`), `provider_message_id text not null` (unique; gerado pelo adaptador mock, por exemplo `mock-` mais um UUID do Worker), `to_address text not null`, `subject text not null`, `body text not null`, `attachments jsonb not null`, `published_at timestamptz not null default now()` (o mesmo nome das outras caixas). Trigger `BEFORE UPDATE OR DELETE` que recusa.

### `supplier_contacts`: onde mora o e-mail de teste

Decisão: tabela própria, `supplier_contacts (supplier_id text primary key, email text not null, check (email like '%@%.test'))`, preenchida pela própria migração com um e-mail de teste no domínio reservado `.test` para cada fornecedor do kit (`F01` a `F12`). Por quê:

- Uma coluna nova em `kit_fornecedores` muda o contrato do kit: `data/kit/fornecedores.json`, `data/kit/contrato.json`, o carregador `scripts/load_kit.py` e o teste `scripts/kit_contract_test.py`, que confere a migração da base contra o contrato. O kit espelha a fonte (ADR-001) e o e-mail de teste não existe na fonte.
- O plano do grupo 5 na issue já diz "contato do fornecedor numa tabela própria".
- Sem FK para `kit_fornecedores`: o kit é carregado por `scripts/load_kit.py` depois das migrações, então num banco novo a carga da migração falharia na FK. Um fornecedor sem contato vira `skipped: no_supplier_email` no caso de uso, que já trata esse caminho.

Recusa por privilégio: a migração revoga `INSERT`, `UPDATE`, `DELETE` e `TRUNCATE` de `anon`, `authenticated` e `service_role`; o Worker só lê. As migrações rodam com o dono das tabelas e seguem gravando. Trocar um e-mail é uma migração nova.

## Sequencial da nota (`nextSequence`)

Recomendação: uma sequência do Postgres exposta por uma função RPC, a primeira do projeto (hoje não há `rpc` em `api/src` nem em `api/test`).

```sql
-- #156 O sequencial do mock: numero e o sufixo de nota_id.
create sequence public.return_note_number_seq as integer minvalue 1 maxvalue 999999999 no cycle;
create function public.next_return_note_number() returns integer
  language sql volatile security invoker set search_path = ''
  as $$ select nextval('public.return_note_number_seq')::integer $$;
revoke execute on function public.next_return_note_number() from public, anon, authenticated;
grant execute on function public.next_return_note_number() to service_role;
grant usage on sequence public.return_note_number_seq to service_role;
```

- Seguro sob concorrência: "even if multiple sessions execute `nextval` concurrently, each will safely receive a distinct sequence value" ([Sequence Manipulation Functions](https://www.postgresql.org/docs/current/functions-sequence.html)).
- A função é `volatile` e chamada por `POST /rest/v1/rpc/next_return_note_number`: o PostgREST roda o POST de uma função `VOLATILE` em transação `READ WRITE`, e o de uma `STABLE`/`IMMUTABLE` em `READ ONLY`, onde ela falharia ([PostgREST: Transactions, Access Mode](https://docs.postgrest.org/en/stable/references/transactions.html)). Um `GET` numa view com `nextval` cairia em `READ ONLY` e falharia pelo mesmo motivo.
- O `revoke` é necessário: o Postgres dá `EXECUTE` a `PUBLIC` em toda função nova ([Privileges](https://www.postgresql.org/docs/current/ddl-priv.html)), o PostgREST expõe em `/rpc` toda função do schema exposto que o papel pode executar ([PostgREST: Functions as RPC](https://docs.postgrest.org/en/stable/references/api/functions.html)), e o `supabase/config.toml` registra que objetos novos em `public` ficam alcançáveis pelos papéis da Data API sem `GRANT` explícito. `USAGE` na sequência é o que permite `nextval` ([Privileges](https://www.postgresql.org/docs/current/ddl-priv.html)).
- Buracos são aceitos: o valor de `nextval` "is not reclaimed for re-use if the calling transaction later aborts", e sequências "cannot be used to obtain gapless sequences" ([functions-sequence](https://www.postgresql.org/docs/current/functions-sequence.html)). Aqui um buraco aparece quando a corrida de `save` perde (outra emissão ganhou a mesma linha da fila) ou quando o Worker cai entre `nextSequence` e `save`. A emissão é emulada; numeração sem buraco seria exigência fiscal real, fora da issue.
- O adaptador ganha um método `rpc(name, args)` no `SupabaseRest` (POST em `rpc/<nome>`, mesmo tratamento de erro e tempo limite) e o `api/test/support/fake-postgrest.ts` ganha a rota `rpc/next_return_note_number` com um contador.

Alternativa pesada e rejeitada: `select max(number) + 1` e `unique (number)` com nova tentativa. A porta separa `nextSequence()` de `save()` em duas chamadas e o caso de uso não repete; duas emissões de linhas diferentes ao mesmo tempo dariam 409 no `save` (o PostgREST devolve 409 para `23505`, [Errors](https://docs.postgrest.org/en/stable/references/errors.html)) e erro para a pessoa, e o laço de nova tentativa iria para o caso de uso.

## Como cada porta usa o PostgREST

| Porta | Chamada | Tabela e filtro |
|---|---|---|
| `SupplierRequestRepository.findById` | GET | `supplier_requests?id=eq.<id>` |
| `.listByInvoice` | GET | `supplier_requests?invoice_access_key=eq.<k>&order=created_at` |
| `.listByStatus` | GET | `supplier_requests?status=eq.<s>&order=created_at` (a rodada corta em `MAX_PER_RUN`; pode passar `limit`) |
| `.add` | POST sem `on_conflict` e com `ignoreDuplicates: false` | 409 com `23505` e o nome `supplier_requests_one_open_key` na mensagem vira `duplicate_open`; qualquer outro erro sobe |
| `.save` | PATCH, `Prefer: return=representation` | `supplier_requests?id=eq.<id>&updated_at=eq.<expected>&version=eq.<v>`; zero linhas devolvidas vira `stale`. O adaptador não envia `version` (o trigger incrementa) |
| `ReturnNoteEmissions.findByQueueRow` / `findByNoteId` | GET | `return_note_emissions?queue_row_id=eq.<n>` / `?note_id=eq.<id>` |
| `.nextSequence` | POST | `rpc/next_return_note_number` |
| `.save` | POST com `on_conflict=queue_row_id` e `ignoreDuplicates: true`; vazio, GET por `queue_row_id` e devolve a que ficou | `return_note_emissions` |
| `ReturnNoteWorkQueue.ensureRow` | `erpReturnNoteOutbox(rest).publish` (já idempotente por `idempotency_key`) e o valor pela nota de origem, como `api/src/returns/return-notes.ts` calcula | `outbox_return_notes`, `invoices` |
| `.markEmitted` | o mesmo PATCH condicional da #140 (`id=eq.<n>&status=eq.pendente`); zero linhas, GET da linha: `emitida` com o mesmo `nfe_number` vale `ok`, outra coisa `conflict`, ausente `not_found` | `outbox_return_notes` |
| `SupplierEmailSender` (mock) | POST com `on_conflict=request_id` e `ignoreDuplicates: true`; vazio, GET por `request_id` e devolve o `provider_message_id` guardado | `outbox_supplier_emails` |
| `SupplierDirectory.emailOf` | GET | `supplier_contacts?supplier_id=eq.<id>` |
| `DecidedProposalSource.listDecided` | GET | `proposals?state=in.(aprovada,alterada)&order=id`, depois `invoices`, `approvals` (`approver` é o `decidedBy`, #211) e o resto do contexto por `in.(...)`, como `api/src/approval/supabase-store.ts` já faz |
| `.find` | GET | `proposals?invoice_access_key=eq.<k>` e o mesmo contexto |

Sobre o `save` condicional: em Read Committed, quando duas gravações disputam a mesma linha, a segunda espera a primeira e "the search condition of the command (the `WHERE` clause) is re-evaluated to see if the updated version of the row still matches" ([Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html)). O filtro por `updated_at` é o da porta; o filtro por `version` fecha o caso em que duas gravações caem no mesmo milissegundo e o `updated_at` não se mexe. O adaptador guarda, por instância, a `version` que leu em `findById`/`list*` ou que recebeu do último `save` (a resposta do PATCH traz a linha); um `save` de um id que a instância não leu filtra só por `updated_at`.

## Índices

| Índice | Tabela | Colunas | Serve | Sai sem travar escrita por |
|---|---|---|---|---|
| `supplier_requests_pkey` | `supplier_requests` | `(id)` | Q1, Q4 | tabela nova: n/a |
| `supplier_requests_one_open_key` (unique parcial) | `supplier_requests` | `(invoice_access_key, request_type) where status in ('writing','draft','send_failed')` | AC-8 e `add` → `duplicate_open`. Índice único parcial é a forma documentada de "um só entre as linhas que satisfazem o predicado" ([Partial Indexes, Example 11.3](https://www.postgresql.org/docs/current/indexes-partial.html)). Por ser parcial, o `add` não usa `on_conflict`: a inferência de um índice parcial pede o predicado no `ON CONFLICT` ([INSERT](https://www.postgresql.org/docs/current/sql-insert.html)), que o `on_conflict` do PostgREST não leva | tabela nova: n/a |
| `supplier_requests_invoice_idx` | `supplier_requests` | `(invoice_access_key, created_at)` | Q2 (igualdade na nota, ordem por criação) e a FK para `invoices` | tabela nova: n/a |
| `supplier_requests_status_idx` | `supplier_requests` | `(status, created_at)` | Q3 (`writing` mais antigos primeiro) | tabela nova: n/a |
| `supplier_request_history_pkey` | `supplier_request_history` | `(request_id, version)` | unicidade da versão e a FK para `supplier_requests` | tabela nova: n/a |
| `return_note_emissions_pkey` | `return_note_emissions` | `(note_id)` | Q6 | tabela nova: n/a |
| `return_note_emissions_queue_row_id_key` | `return_note_emissions` | `(queue_row_id)` unique | Q5, Q8 (`on_conflict`), uma nota por linha | tabela nova: n/a |
| `return_note_emissions_access_key_key` | `return_note_emissions` | `(access_key)` unique | chave única (AC-4) | tabela nova: n/a |
| `return_note_emissions_number_key` | `return_note_emissions` | `(number)` unique | número único | tabela nova: n/a |
| `outbox_supplier_emails_request_id_key` | `outbox_supplier_emails` | `(request_id)` unique | Q11 (`on_conflict` e leitura) e a FK | tabela nova: n/a |
| `outbox_supplier_emails_provider_message_id_key` | `outbox_supplier_emails` | `(provider_message_id)` unique | unicidade do id do envio | tabela nova: n/a |
| `supplier_contacts_pkey` | `supplier_contacts` | `(supplier_id)` | Q12 (tabela fixa) | tabela nova: n/a |
| `proposals_state_idx` | `proposals` | `(state, id)` | Q13 (e o `listDecidedOn` da #63, que já filtra por `state=in.(aprovada,alterada)`) | índice comum, `create index if not exists`: trava curta de escrita em `proposals`, aceita (decisão registrada em "Decisões da camada de OLTP") |

Q9 usa `outbox_return_notes_idempotency_key_key` e Q10 a PK de `outbox_return_notes`; Q14 usa `proposals_invoice_key`, `approvals_proposal_key` e `invoices_pkey`. Nenhum índice novo para eles.

## Transações

Nenhum caso de uso abre transação: a unidade de trabalho é a requisição ao PostgREST, que roda inteira numa transação e termina em `COMMIT` quando não falha ([PostgREST: Transactions](https://docs.postgrest.org/en/stable/references/transactions.html)); um erro do comando ou do trigger desfaz os dois ([trigger-definition](https://www.postgresql.org/docs/current/trigger-definition.html)). Nenhum adaptador escreve `BEGIN`/`COMMIT` (TRX-2), e nenhuma transação fica aberta entre chamadas (TRX-4). Quando um caso de uso toca mais de uma raiz, cada raiz é uma requisição, e cada passo é idempotente e chaveado, de modo que repetir o caso de uso inteiro depois de uma queda no meio termina no mesmo estado.

| Caso de uso | Requisições, em ordem | Raiz de cada | Escritas dentro | Falha no meio |
|---|---|---|---|---|
| `openForDecided` / `openPlanned` | `ensureRow` (POST idempotente); `add` (POST) | fila #140; `SupplierRequest` | linha `pendente`; pedido mais histórico v1 pelo trigger | queda depois do `ensureRow`: a linha fica `pendente` sem pedido; a próxima varredura reusa a linha pela `idempotency_key` e abre o pedido. Corrida no `add`: 409 → `duplicate_open` |
| `writeDraft` / `writeDrafts` | PATCH condicional | `SupplierRequest` | pedido mais histórico | falha do Claude antes do PATCH: nada gravado, segue `writing`; PATCH com 0 linhas: `stale` |
| `editBody` | PATCH condicional | `SupplierRequest` | pedido mais histórico | 0 linhas: `stale` |
| `discardRequest` | PATCH condicional | `SupplierRequest` | pedido mais histórico | 0 linhas: `stale` |
| `redo` | `ensureRow`; `add` | fila #140; `SupplierRequest` | como `openPlanned` | como `openPlanned` |
| `emitAndSend` | `ensureRow`; `findByQueueRow`; `nextSequence` (RPC); `emissions.save`; `markEmitted`; PATCH do anexo; envio mock (POST); PATCH `markSent`/`markSendFailed` | fila #140; emissão; emissão; fila #140; `SupplierRequest`; caixa de e-mail; `SupplierRequest` | cada passo grava uma raiz só | qualquer queda é retomada ao repetir: a emissão volta pela `queue_row_id`; `markEmitted` com o mesmo número vale `ok`; o anexo é pulado se já está lá; o envio devolve o `provider_message_id` guardado; o número tirado e não gravado vira buraco |
| `retrySend` | envio mock (POST); PATCH | caixa de e-mail; `SupplierRequest` | | idem |
| Leituras (`readSupplierRequests`, `listDecided`, `find`) | GETs em `READ ONLY` | | nenhuma | sem efeito |

O efeito na outra raiz (a fila da #140, a caixa de e-mail) não é um evento gravado na mesma transação, como `docs/transactions.md` do plugin prefere: com o PostgREST sem RPC por caso de uso, a garantia equivalente vem da chave de idempotência de cada passo e da repetição do caso de uso. Fica registrado como desvio consciente em "Regras", TRX-3.

## Estratégia de inquilino

Nenhum inquilino: a Já Chegou é uma empresa só e `supplier_id` é a contraparte do pedido, não um dono de dados. `strategies.tenancy.strategy: none`. As tabelas novas seguem a convenção do projeto: RLS ligado e nenhuma política (AC-6 da #59), só o Worker lê e grava, com a chave secreta (`service_role`, que tem `BYPASSRLS`, [Supabase: API keys](https://supabase.com/docs/guides/api/api-keys)), como o comentário de `20261115130000_dominio.sql` registra para as demais tabelas.

## Migrações

Depois de `20261116100000`, com comentários `-- #156` e RLS ligado em toda tabela nova:

1. `20261116110000_supplier_contacts.sql`: tabela, carga dos 12 contatos, `revoke`.
2. `20261116120000_supplier_requests.sql`: `supplier_requests`, `supplier_request_history`, os três triggers, os índices, `revoke truncate`.
3. `20261116130000_return_note_emissions.sql`: tabela, sequência, função `next_return_note_number`, `revoke`/`grant`, trigger de recusa.
4. `20261116140000_outbox_supplier_emails.sql`: tabela, trigger de recusa.
5. `20261116150000_proposals_state_idx.sql`: só `create index if not exists proposals_state_idx on public.proposals (state, id);`, sem `concurrently` (ver "Decisões da camada de OLTP").

## Regras

| Condição | Atendida por | Não atendida, e por quê |
|---|---|---|
| PER-1 | as cinco tabelas novas no registro | as tabelas anteriores à #156 não estão declaradas (lista no registro); declarar é dos donos delas |
| PER-2 | triggers de recusa em `supplier_request_history`, `return_note_emissions`, `outbox_supplier_emails`; `revoke` em `supplier_contacts`; nenhum adaptador faz PATCH/DELETE nelas | |
| PER-3 | trigger `AFTER INSERT OR UPDATE` grava `(id, version, at, by, state)` na mesma transação | o teste de integração (mudar duas vezes, achar dois registros) pede um banco real; ver "Em aberto" |
| PER-4 | `version` pelo trigger; PATCH filtra `updated_at` e `version` | teste de gravação velha contra banco real: ver "Em aberto" |
| PER-5 | `BEFORE DELETE` recusa em `supplier_requests`; descarte é status | |
| PER-6 | nenhuma tabela append-only daqui alimenta um estado derivado: cada linha é lida pela chave | n/a |
| PER-7 | primeiro modo de cada tabela | n/a |
| PER-8 | `json-child-table` em `jsonb`, a forma para PostgreSQL | |
| TRX-1 | entidade e histórico numa requisição só, pelo trigger | o detector (fazer o histórico falhar e achar a entidade intacta) pede banco real |
| TRX-2 | nenhum adaptador abre transação | |
| TRX-3 | cada requisição muda uma raiz | o efeito na outra raiz não é evento na mesma transação; vem da idempotência por chave e da repetição (acima) |
| TRX-4 | o PostgREST termina cada requisição | |
| IDX-1 | um índice por consulta (tabela de índices) | a leitura do plano no teste pede banco real |
| IDX-2 | cada índice nomeia a consulta | |
| IDX-3 | n/a (relacional) | |
| IDX-4 | `proposals_state_idx` como índice comum | trava curta de escrita em `proposals` durante a construção, aceita porque a tabela é pequena; ver "Decisões da camada de OLTP" |
| MT-1 a MT-5 | n/a: sem inquilino | |

## Em aberto

- **Sem pista de banco real.** Os testes usam `api/test/support/fake-postgrest.ts`, que não executa trigger, check, índice único parcial nem sequência. Os detectores de PER-3, PER-4, TRX-1, IDX-1 e da recusa append-only ficam sem teste até haver uma pista local (`supabase start` e a suíte contra ela) ou outra forma; decisão do dono do repositório. O fake precisa, no mínimo, imitar o 409 do índice parcial no `add`, o `on_conflict` em `queue_row_id` e `request_id`, e a rota `rpc`.
- **Decisão a registrar:** a unidade de trabalho (uma requisição ao PostgREST, histórico por trigger, passos idempotentes entre raízes) e a primeira função RPC. Se o dono quiser o registro, é um ADR-003; o registro marca `unit_of_work_decision: none recorded yet`.
- **Dados pessoais.** `created_by`, `edited_by`, `sent_by`, `discarded_by` e o `state` do histórico guardam o identificador de quem agiu; o projeto não tem caminho de apagamento registrado (o mesmo vale para `approvals.approver`). Decisão do dono, fora da #156.
- **`outbox_return_notes` muda no lugar sem histórico** (transição da #140). A #156 só reusa a transição; declarar o modo da tabela é da #140.
- **Envio feito e gravação `stale`.** Se outra pessoa descarta o pedido entre o envio e o PATCH `markSent`, o e-mail saiu (e fica em `outbox_supplier_emails`) e o pedido fica descartado. A caixa de e-mail é a prova do envio; como mostrar isso na gaveta é do caso de uso.
- **Valores dos e-mails de teste**: um por fornecedor, domínio `.test`; os endereços exatos ficam com o builder.

## Decisões da camada de OLTP

- **`proposals_state_idx` é um índice comum, sem `concurrently`** (decisão do Apollo, na rodada 1 da camada de OLTP). `create index concurrently` não roda dentro de bloco de transação ([CREATE INDEX](https://www.postgresql.org/docs/current/sql-createindex.html#SQL-CREATEINDEX-CONCURRENTLY)) e o `supabase db push` pode envolver cada arquivo numa transação. A tabela `proposals` é pequena (uma proposta por nota), então a trava de escrita durante a construção é curta. A migração usa `if not exists` para poder ser reaplicada. A decisão está registrada no ADR-003 (`docs/adr/ADR-003-indice-simples-em-proposals.md`, status `proposed` até o dono aceitar).
- **O adaptador de `ReturnNoteWorkQueue` recusa uma devolução sem valor.** Quando a nota de origem não traz uma das linhas, `ensureRow` lança antes de publicar, para não deixar na fila da #140 uma linha que o rascunho não fecha.
- **`SupplierRequestRepository` guarda a `version` por instância.** Monte as dependências uma vez por requisição ou rodada.
- **Verificação.** Sem pista de banco real, as migrações têm só a verificação estática de `api/test/supplier-requests/migrations.test.ts` e os adaptadores rodam contra `api/test/support/fake-postgrest.ts`, que imita o 409 do índice parcial, a restrição única por `on_conflict`, o PATCH condicional, a rota `rpc/next_return_note_number`, a subida de `version` e o histórico do pedido. Triggers, checks e a sequência só se verificam num banco real.
