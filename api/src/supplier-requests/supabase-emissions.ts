// #156/AC-4: as notas de devolução emitidas pelo mock, em return_note_emissions: uma por linha da fila da #140.
import {
  arrayOf,
  isInteger,
  isNumber,
  isString,
  nullable,
  oneOf,
  parseOne,
  parseRows,
  shaped,
  type Guard,
  type Shape,
} from '../connectors/guards.js';
import { SupabaseRestError, type SupabaseRest } from '../connectors/supabase-rest.js';
import type { KitItem, ReturnNote } from '../domain/index.js';
import type { ReturnNoteEmissions } from './ports.js';

const TABLE = 'return_note_emissions';
const NEXT_NUMBER = 'next_return_note_number';

type EmissionRow = { note_id: string; queue_row_id: number; note: ReturnNote };

const isKitItem = shaped<KitItem>({
  codigo_fornecedor: isString, // ADR-001
  sku: nullable(isString),
  descricao: isString, // ADR-001
  quantidade: isNumber, // ADR-001
  unidade: isString, // ADR-001
  preco_unitario: isNumber, // ADR-001
  valor: isNumber, // ADR-001
} satisfies Shape<KitItem>);

const isNote = shaped<ReturnNote>({
  nota_id: isString, // ADR-001
  chave: isString, // ADR-001
  numero: isInteger, // ADR-001
  serie: isInteger, // ADR-001
  emitente: isString, // ADR-001
  fornecedor_id: isString, // ADR-001
  destino: isString, // ADR-001
  data_emissao: isString, // ADR-001
  nota_referenciada: isString, // ADR-001
  natureza: oneOf('devolucao'), // ADR-001
  itens: arrayOf(isKitItem), // ADR-001
  valor_total: isNumber, // ADR-001
} satisfies Shape<ReturnNote>);

const isRow: Guard<EmissionRow> = shaped<EmissionRow>({
  note_id: isString,
  queue_row_id: isInteger,
  note: isNote,
} satisfies Shape<EmissionRow>);

class SupabaseReturnNoteEmissions implements ReturnNoteEmissions {
  constructor(private readonly rest: SupabaseRest) {}

  findByQueueRow(queueRowId: number): Promise<ReturnNote | null> {
    return this.find({ queue_row_id: `eq.${queueRowId}` });
  }

  findByNoteId(noteId: string): Promise<ReturnNote | null> {
    return this.find({ note_id: `eq.${noteId}` });
  }

  /** #156: `nextval` da sequência, por uma função VOLATILE; buracos são aceitos. */
  async nextSequence(): Promise<number> {
    const value = await this.rest.rpc(NEXT_NUMBER, {});
    if (!isInteger(value)) throw new SupabaseRestError('parse', `rpc/${NEXT_NUMBER}`, 0, 'o sequencial não é um inteiro');
    return value;
  }

  /** #156/AC-4: `on_conflict=queue_row_id` ignorando a duplicada; se a linha já tinha nota, vale a que ficou. */
  async save(queueRowId: number, note: ReturnNote): Promise<ReturnNote> {
    const inserted = parseRows(
      await this.rest.insert(
        TABLE,
        [
          {
            note_id: note.nota_id, // ADR-001
            queue_row_id: queueRowId,
            access_key: note.chave, // ADR-001
            number: note.numero, // ADR-001
            series: note.serie, // ADR-001
            note,
          },
        ],
        { onConflict: 'queue_row_id', ignoreDuplicates: true },
      ),
      isRow,
      TABLE,
    );
    const [first] = inserted;
    if (first) return first.note;
    const winner = await this.findByQueueRow(queueRowId);
    if (!winner) throw new SupabaseRestError('select', TABLE, 0, 'a emissão da linha não foi encontrada depois do conflito');
    return winner;
  }

  private async find(filters: Record<string, string>): Promise<ReturnNote | null> {
    const [row] = await this.rest.select(TABLE, { select: 'note_id,queue_row_id,note', filters, limit: 1 });
    return row === undefined ? null : parseOne(row, isRow, TABLE).note;
  }
}

export function supabaseReturnNoteEmissions(rest: SupabaseRest): ReturnNoteEmissions {
  return new SupabaseReturnNoteEmissions(rest);
}
