// #156: a fila de notas de devolução da #140 (outbox_return_notes), como o pedido ao fornecedor a usa:
// a linha é publicada pela caixa idempotente da #59 e a emissão passa pela transição da #140.
import { erpReturnNoteOutbox } from '../connectors/erp-return-note.js';
import { arrayOf, isNumber, isString, nullable, parseRows, shaped, type Shape } from '../connectors/guards.js';
import { SupabaseRestError, type SupabaseRest } from '../connectors/supabase-rest.js';
import { lineValueCents, supabaseReturnNoteQueue, totalValueCents } from '../returns/return-notes.js';
import type { QueueRow, ReturnNoteWorkQueue } from './ports.js';

type OriginItem = { supplierCode: string; unitPriceCents: number };
type OriginRow = { items: OriginItem[] };
type QueueStateRow = { status: string; nfe_number: string | null };

const isOriginRow = shaped<OriginRow>({
  items: arrayOf(shaped<OriginItem>({ supplierCode: isString, unitPriceCents: isNumber } satisfies Shape<OriginItem>)),
} satisfies Shape<OriginRow>);

const QUEUE = 'outbox_return_notes';

class SupabaseReturnNoteWorkQueue implements ReturnNoteWorkQueue {
  private readonly outbox;
  private readonly queue;

  constructor(private readonly rest: SupabaseRest) {
    this.outbox = erpReturnNoteOutbox(rest);
    this.queue = supabaseReturnNoteQueue(rest);
  }

  /** #156/AC-2: publica a linha se falta (idempotente pela chave da #59) e lê o valor como a fila da #140 o calcula. */
  async ensureRow(input: Parameters<ReturnNoteWorkQueue['ensureRow']>[0]): Promise<QueueRow> {
    const origin = parseRows(
      await this.rest.select('invoices', { select: 'items', filters: { access_key: `eq.${input.invoiceAccessKey}` } }),
      isOriginRow,
      'invoices',
    )[0];
    const value = totalValueCents(
      input.lines.map((l) => {
        const item = origin?.items.find((i) => i.supplierCode === l.supplierCode);
        return item ? lineValueCents(item.unitPriceCents, l.quantity.amount) : null;
      }),
    );
    // #156: a fila sem valor não fecha com o rascunho; recusar antes de publicar não deixa linha órfã.
    if (value === null) throw new SupabaseRestError('select', QUEUE, 0, 'a devolução fica sem valor: a nota de origem não traz a linha');
    const published = await this.outbox.publish({
      invoiceAccessKey: input.invoiceAccessKey,
      lines: input.lines,
      reason: input.reason,
    });
    return { id: published.id, valueCents: value };
  }

  /**
   * #156/AC-4: pendente → emitida pela transição da #140. Linha já emitida com o mesmo número vale `ok`
   * (retomada de uma queda); outro número ou linha cancelada, `conflict`.
   */
  async markEmitted(id: number, number: string, by: string, at: Date): Promise<'ok' | 'not_found' | 'conflict'> {
    const result = await this.queue.emit(id, number, by, at);
    if (result.kind === 'ok') return 'ok';
    if (result.kind === 'not_found') return 'not_found';
    const [row] = parseRows(
      await this.rest.select(QUEUE, { select: 'status,nfe_number', filters: { id: `eq.${id}` } }),
      shaped<QueueStateRow>({ status: isString, nfe_number: nullable(isString) } satisfies Shape<QueueStateRow>),
      QUEUE,
    );
    return row?.status === 'emitida' && row.nfe_number === number ? 'ok' : 'conflict'; // ADR-002
  }
}

export function supabaseReturnNoteWorkQueue(rest: SupabaseRest): ReturnNoteWorkQueue {
  return new SupabaseReturnNoteWorkQueue(rest);
}
