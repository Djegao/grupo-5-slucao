import { buildSupplierRequestFacts, type FactCatalog } from '../domain/index.js';
import type { ReplyRequest } from './reply-ports.js';

// #34: o que a leitura e a cobrança dividem: o catálogo de fatos do pedido (o mesmo da #2) e o dia de hoje.

/** #34/AC-3: o catálogo do pedido, refeito da nota guardada, do número da nota de origem e do prazo gravado. */
export const catalogOf = (request: ReplyRequest): FactCatalog =>
  buildSupplierRequestFacts(request.note, { number: request.invoiceNumber }, request.dueOn);

const TIME_ZONE = 'America/Sao_Paulo';

// #34: igual a todayIso de #11 (draft.ts); unificar quando #38 entrar (ADR-005: o domínio não lê a hora).
export const todayIso = (now: Date): string => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(now);
