# ADR-003: Índice simples em `proposals`, sem CONCURRENTLY

- **Status:** accepted
- **Date:** 2026-11-15

## Context

O pedido ao fornecedor (#156) lê as propostas decididas por `state in (aprovada, alterada)`, e a migração `20261116150000_proposals_state_idx.sql` cria o índice `proposals_state_idx` em `(state, id)` na tabela existente `proposals`. Um índice criado sem `CONCURRENTLY` trava a escrita na tabela enquanto é construído. O `supabase db push` pode aplicar cada arquivo de migração dentro de uma transação, e `create index concurrently` não roda dentro de uma transação. A tabela `proposals` guarda uma linha por nota do kit, cerca de 80, então a construção é quase instantânea.

## Decision

A migração cria o índice comum, com `create index if not exists`, sem `CONCURRENTLY`. A trava de escrita em `proposals` dura o tempo de construir um índice de cerca de 80 linhas. O dono da migração aceita esta decisão; o status é `accepted`.

## Consequences

- A migração roda no `supabase db push` com ou sem transação por arquivo.
- A escrita em `proposals` espera brevemente durante a construção. Se a tabela crescer muito antes de a migração rodar em outro ambiente, a decisão deve ser reaberta.
- O `if not exists` permite reaplicar a migração.

## Alternatives considered

- `create index concurrently` em uma migração só dele. Rejeitada: exige que o arquivo rode fora de transação, o que o `supabase db push` não garante, e o ganho é nulo para uma tabela de cerca de 80 linhas.
