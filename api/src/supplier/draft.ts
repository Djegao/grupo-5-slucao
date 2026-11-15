import { DEFAULT_MODEL, type Ask } from '../claude/client.js';
import {
  DEFAULT_DUE_BUSINESS_DAYS,
  DomainError,
  addBusinessDays,
  buildReturnNote,
  buildSupplierRequestFacts,
  validateRequestText,
  type FactCatalog,
  type ReturnNoteDraft,
  type SupplierRequestText,
} from '../domain/index.js';
import type { ReturnNoteView } from '../returns/return-notes.js';
import { buildSupplierRequestPrompt } from './prompt.js';
import type { DraftOutcome, RequestRecord, SupplierDeps } from './ports.js';

// #11: o caminho único do rascunho (#2): a tarefa do Cron e o "refazer" da pessoa passam por aqui.
// #11: preparar o rascunho nunca emite nota nem envia e-mail (#2/AC-3).

const REQUEST_TYPE = 'return_note';
/** #12/AC-4: quem consta no histórico de um rascunho: o agente do Claude, no Cron e no refazer. */
export const AGENT_ACTOR = 'agente';

export type DraftResult =
  | { readonly kind: 'ok'; readonly record: RequestRecord }
  | { readonly kind: 'conflict'; readonly reason: 'open_request_exists' | 'queue_not_pending' }
  | { readonly kind: 'invalid'; readonly reason: 'source_missing' | 'note_not_buildable' };

const TIME_ZONE = 'America/Sao_Paulo';

/** #11: o dia de hoje no fuso do caso, AAAA-MM-DD (o en-CA formata assim). */
export const todayIso = (now: Date): string => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(now);

const queueLines = (entry: ReturnNoteView) =>
  entry.lines.map((l) => ({ supplierCode: l.supplierCode, amount: l.quantity.amount, unit: l.quantity.unit }));

/** #11/AC-2: o que o Claude escreveu, aceito pelo catálogo ou recusado com o motivo. */
function judge(raw: unknown, catalog: FactCatalog): DraftOutcome {
  const checked = validateRequestText(raw, catalog);
  if (!checked.ok) return { kind: 'rejected', rejection: checked };
  const text: SupplierRequestText = checked.text;
  return { kind: 'draft', text };
}

// #11/AC-1: prepara o rascunho da devolução `queueId` da fila: a nota pela regra, o e-mail pelo Claude.
// #11/AC-1: erro do Claude (inclusive 401 e 429) sobe como está: nada é gravado.
export async function draftRequest(deps: SupplierDeps, queueId: number, ask: Ask): Promise<DraftResult> {
  const now = deps.clock.now();
  const entry = (await deps.queue.list('pendente', now)).find((e) => e.id === queueId);
  if (entry === undefined) return { kind: 'conflict', reason: 'queue_not_pending' };
  if ((await deps.requests.findOpen(entry.invoiceAccessKey, REQUEST_TYPE)) !== null) {
    return { kind: 'conflict', reason: 'open_request_exists' };
  }
  const source = await deps.source.find(entry.invoiceAccessKey);
  if (source === null) return { kind: 'invalid', reason: 'source_missing' };
  let note: ReturnNoteDraft;
  try {
    note = buildReturnNote({ invoiceAccessKey: entry.invoiceAccessKey, lines: queueLines(entry) }, source.invoice);
  } catch (error) {
    if (error instanceof DomainError) return { kind: 'invalid', reason: 'note_not_buildable' };
    throw error;
  }
  const draftedOn = todayIso(now);
  const dueOn = addBusinessDays(draftedOn, DEFAULT_DUE_BUSINESS_DAYS);
  const catalog = buildSupplierRequestFacts(note, source.invoice, dueOn);
  const raw = await ask<unknown>(buildSupplierRequestPrompt(catalog, REQUEST_TYPE));
  const created = await deps.requests.create({
    invoiceAccessKey: entry.invoiceAccessKey,
    queueId,
    note,
    to: source.supplierEmail,
    draftedOn,
    model: DEFAULT_MODEL,
    by: AGENT_ACTOR,
    outcome: judge(raw, catalog),
  });
  return created.kind === 'ok' ? { kind: 'ok', record: created.record } : { kind: 'conflict', reason: 'open_request_exists' };
}
