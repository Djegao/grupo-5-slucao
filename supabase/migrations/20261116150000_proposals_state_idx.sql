-- #156 Q13: as propostas decididas (state in aprovada, alterada), do pedido ao fornecedor e do listDecidedOn da #63.
-- #156 ADR-003: índice comum, sem CONCURRENTLY, decisão em docs/adr/ADR-003-indice-simples-em-proposals.md.
-- #156 Índice comum, sem CONCURRENTLY: proposals é pequena e o `supabase db push` pode envolver cada
-- #156 arquivo numa transação, onde CREATE INDEX CONCURRENTLY falha.

create index if not exists proposals_state_idx on public.proposals (state, id);
