/* #156: o repositório do pedido ao fornecedor sobre supplier_requests, pelo PostgREST. Cada chamada é uma
 * requisição, e portanto uma transação; a versão e o histórico são do banco (triggers), não do adaptador. */
import {
  arrayOf,
  isInteger,
  isString,
  nullable,
  oneOf,
  parseRows,
  shaped,
  type Guard,
  type Shape,
} from '../connectors/guards.js';
import { SupabaseRestError, type Row, type SupabaseRest } from '../connectors/supabase-rest.js';
import {
  SupplierRequest,
  type SupplierRequestAttachment,
  type SupplierRequestSnapshot,
  type SupplierRequestStatus,
} from '../domain/index.js';
import type { SupplierRequestRepository } from './ports.js';

const TABLE = 'supplier_requests';
/** #156/AC-8: o índice único parcial; a violação dele (e só dela) é `duplicate_open`. */
const ONE_OPEN_INDEX = 'supplier_requests_one_open_key';

type RequestRow = {
  id: string;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
  version: number;
  invoice_access_key: string;
  supplier_id: string;
  request_type: SupplierRequestSnapshot['requestType'];
  to_address: string;
  subject: string;
  body: string | null;
  asks: string[];
  attachments: SupplierRequestAttachment[];
  due_on: string | null;
  status: SupplierRequestStatus;
  send_failure: string | null;
  channel: SupplierRequestSnapshot['channel'];
  model: string | null;
  drafted_at: string | null;
  edited_by: string | null;
  edited_at: string | null;
  sent_by: string | null;
  sent_at: string | null;
  provider_message_id: string | null;
  discarded_by: string | null;
  discarded_at: string | null;
  discard_reason: string | null;
};

const isAttachment = shaped<SupplierRequestAttachment>({
  kind: oneOf('return_note'),
  returnNoteId: isString,
  filename: isString,
} satisfies Shape<SupplierRequestAttachment>);

const isRow: Guard<RequestRow> = shaped<RequestRow>({
  id: isString,
  created_at: isString,
  created_by: isString,
  updated_at: isString,
  updated_by: isString,
  version: isInteger,
  invoice_access_key: isString,
  supplier_id: isString,
  request_type: oneOf('return_note', 'cancel_invoice', 'deliver_missing', 'purchase_order_number', 'registry_data', 'notice'),
  to_address: isString,
  subject: isString,
  body: nullable(isString),
  asks: arrayOf(isString),
  attachments: arrayOf(isAttachment),
  due_on: nullable(isString),
  status: oneOf('writing', 'draft', 'sent', 'discarded', 'send_failed'),
  send_failure: nullable(isString),
  channel: oneOf('mock', 'resend'),
  model: nullable(isString),
  drafted_at: nullable(isString),
  edited_by: nullable(isString),
  edited_at: nullable(isString),
  sent_by: nullable(isString),
  sent_at: nullable(isString),
  provider_message_id: nullable(isString),
  discarded_by: nullable(isString),
  discarded_at: nullable(isString),
  discard_reason: nullable(isString),
} satisfies Shape<RequestRow>);

/** #156: o PostgREST devolve timestamptz como `…+00:00`; o domínio guarda o ISO com `Z`, e o filtro por updated_at precisa dele igual. */
function instant(value: string): string {
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw new SupabaseRestError('parse', TABLE, 0, 'data fora do formato');
  return new Date(time).toISOString();
}
const instantOrNull = (value: string | null): string | null => (value === null ? null : instant(value));

function toSnapshot(row: RequestRow): SupplierRequestSnapshot {
  return {
    id: row.id,
    createdAt: instant(row.created_at),
    createdBy: row.created_by,
    updatedAt: instant(row.updated_at),
    updatedBy: row.updated_by,
    invoiceAccessKey: row.invoice_access_key,
    supplierId: row.supplier_id,
    requestType: row.request_type,
    to: row.to_address,
    subject: row.subject,
    body: row.body,
    asks: row.asks,
    attachments: row.attachments,
    dueOn: row.due_on,
    status: row.status,
    sendFailure: row.send_failure,
    channel: row.channel,
    model: row.model,
    draftedAt: instantOrNull(row.drafted_at),
    editedBy: row.edited_by,
    editedAt: instantOrNull(row.edited_at),
    sentBy: row.sent_by,
    sentAt: instantOrNull(row.sent_at),
    providerMessageId: row.provider_message_id,
    discardedBy: row.discarded_by,
    discardedAt: instantOrNull(row.discarded_at),
    discardReason: row.discard_reason,
  };
}

/** #156: as colunas que mudam depois que o pedido existe; as fixas do agregado e a versão o banco recusa ou cuida. */
function changingColumns(s: SupplierRequestSnapshot): Row {
  return {
    updated_at: s.updatedAt,
    updated_by: s.updatedBy,
    body: s.body,
    attachments: s.attachments,
    due_on: s.dueOn,
    status: s.status,
    send_failure: s.sendFailure,
    model: s.model,
    drafted_at: s.draftedAt,
    edited_by: s.editedBy,
    edited_at: s.editedAt,
    sent_by: s.sentBy,
    sent_at: s.sentAt,
    provider_message_id: s.providerMessageId,
    discarded_by: s.discardedBy,
    discarded_at: s.discardedAt,
    discard_reason: s.discardReason,
  };
}

function toRow(s: SupplierRequestSnapshot): Row {
  return {
    id: s.id,
    created_at: s.createdAt,
    created_by: s.createdBy,
    invoice_access_key: s.invoiceAccessKey,
    supplier_id: s.supplierId,
    request_type: s.requestType,
    to_address: s.to,
    subject: s.subject,
    asks: s.asks,
    channel: s.channel,
    ...changingColumns(s),
  };
}

/** #156 Chaves por leitura em `listByInvoices`. */
const INVOICE_CHUNK = 50;

class SupabaseSupplierRequestRepository implements SupplierRequestRepository {
  /** #156: a `version` que esta instância leu ou recebeu do último `save`, para o PATCH condicional. */
  private readonly versions = new Map<string, number>();

  constructor(private readonly rest: SupabaseRest) {}

  async findById(id: string): Promise<SupplierRequest | null> {
    const [request] = await this.read({ id: `eq.${id}` });
    return request ?? null;
  }

  listByInvoice(invoiceAccessKey: string): Promise<SupplierRequest[]> {
    return this.read({ invoice_access_key: `eq.${invoiceAccessKey}` }, 'created_at');
  }

  /** #156 Em blocos de 50 chaves (a URL do `in.()` fica em ~2,3 KB): 1 subrequest a cada 50 notas. */
  async listByInvoices(invoiceAccessKeys: readonly string[]): Promise<SupplierRequest[]> {
    const keys = [...new Set(invoiceAccessKeys)];
    const out: SupplierRequest[] = [];
    for (let i = 0; i < keys.length; i += INVOICE_CHUNK) {
      const chunk = keys.slice(i, i + INVOICE_CHUNK);
      out.push(...(await this.read({ invoice_access_key: `in.(${chunk.join(',')})` }, 'created_at')));
    }
    return out;
  }

  listByStatus(status: SupplierRequestStatus): Promise<SupplierRequest[]> {
    return this.read({ status: `eq.${status}` }, 'created_at');
  }

  /** #156/AC-8: sem `on_conflict`: o índice é parcial, e só a violação dele vira `duplicate_open`. */
  async add(request: SupplierRequest): Promise<'saved' | 'duplicate_open'> {
    try {
      const rows = await this.rest.insert(TABLE, [toRow(request.snapshot())], { ignoreDuplicates: false });
      this.remember(parseRows(rows, isRow, TABLE));
      return 'saved';
    } catch (error) {
      if (error instanceof SupabaseRestError && error.status === 409 && error.detail.includes(ONE_OPEN_INDEX)) {
        return 'duplicate_open';
      }
      throw error;
    }
  }

  /** #156: PATCH por id, `updated_at` e (se lida) `version`; nenhuma linha de volta é `stale`. */
  async save(request: SupplierRequest, expectedUpdatedAt: string): Promise<'saved' | 'stale'> {
    const filters: Record<string, string> = { id: `eq.${request.id}`, updated_at: `eq.${expectedUpdatedAt}` };
    const version = this.versions.get(request.id);
    if (version !== undefined) filters.version = `eq.${version}`;
    const rows = parseRows(await this.rest.update(TABLE, filters, changingColumns(request.snapshot())), isRow, TABLE);
    if (rows.length === 0) return 'stale';
    this.remember(rows);
    return 'saved';
  }

  private async read(filters: Record<string, string>, order?: string): Promise<SupplierRequest[]> {
    const rows = parseRows(await this.rest.select(TABLE, order ? { filters, order } : { filters }), isRow, TABLE);
    this.remember(rows);
    return rows.map((row) => SupplierRequest.restore(toSnapshot(row)));
  }

  private remember(rows: readonly RequestRow[]): void {
    for (const row of rows) this.versions.set(row.id, row.version);
  }
}

export function supabaseSupplierRequestRepository(rest: SupabaseRest): SupplierRequestRepository {
  return new SupabaseSupplierRequestRepository(rest);
}
