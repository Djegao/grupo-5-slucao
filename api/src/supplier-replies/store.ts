// #157 A persistência da resposta do fornecedor: a caixa de entrada mock, as leituras, as confirmações e a
// cobrança enviada. Tudo append-only: o estado de cada pedido é derivado do último fato.
import { arrayOf, isRecord, isString, nullable, oneOf, parseRows, shaped, type Shape } from '../connectors/guards.js';
import type { SupabaseRest } from '../connectors/supabase-rest.js';
import type { FollowUpDraft, NextStep, ReplyOutcome, SupplierReplyReading } from '../domain/index.js';

export const INBOX = 'inbox_supplier_messages';
export const READINGS = 'supplier_reply_readings';
export const CONFIRMATIONS = 'supplier_document_confirmations';
export const FOLLOW_UPS = 'outbox_supplier_follow_ups';
export const CLOSURES = 'supplier_request_closures';

export type InboxMessage = {
  readonly id: string;
  readonly request_id: string;
  readonly from_address: string;
  readonly body: string;
  readonly received_at: string;
};

export type ReadingRow = {
  readonly id: string;
  readonly request_id: string;
  readonly message_id: string | null;
  readonly outcome: ReplyOutcome;
  readonly fulfilled_asks: string[];
  readonly supplier_document: string | null;
  readonly summary: string;
  readonly next_step: NextStep;
  readonly follow_up_draft: unknown;
  readonly injection_flag: string | null;
  readonly model: string | null;
  readonly read_at: string;
  readonly read_by: string;
};

export type ConfirmationRow = { readonly request_id: string; readonly reading_id: string; readonly confirmed_by: string; readonly confirmed_at: string };
export type FollowUpRow = {
  readonly request_id: string;
  readonly reading_id: string;
  readonly kind: 'follow_up' | 'answer';
  readonly subject: string;
  readonly body: string;
  readonly provider_message_id: string;
  readonly sent_by: string;
  readonly published_at: string;
};

const isInbox = shaped<InboxMessage>({
  id: isString,
  request_id: isString,
  from_address: isString,
  body: isString,
  received_at: isString,
} satisfies Shape<InboxMessage>);

const isReading = shaped<ReadingRow>({
  id: isString,
  request_id: isString,
  message_id: nullable(isString),
  outcome: oneOf('fulfilled', 'partially_fulfilled', 'refused', 'needs_information', 'no_reply'),
  fulfilled_asks: arrayOf(isString),
  supplier_document: nullable(isString),
  summary: isString,
  next_step: oneOf('close', 'confirm_document', 'answer_supplier', 'follow_up'),
  follow_up_draft: (v: unknown): v is unknown => v === null || isRecord(v),
  injection_flag: nullable(isString),
  model: nullable(isString),
  read_at: isString,
  read_by: isString,
} satisfies Shape<ReadingRow>);

const isConfirmation = shaped<ConfirmationRow>({
  request_id: isString,
  reading_id: isString,
  confirmed_by: isString,
  confirmed_at: isString,
} satisfies Shape<ConfirmationRow>);

const isFollowUp = shaped<FollowUpRow>({
  request_id: isString,
  reading_id: isString,
  kind: oneOf('follow_up', 'answer'),
  subject: isString,
  body: isString,
  provider_message_id: isString,
  sent_by: isString,
  published_at: isString,
} satisfies Shape<FollowUpRow>);

export type ClosureRow = { readonly request_id: string; readonly reading_id: string | null; readonly note: string | null; readonly closed_by: string; readonly closed_at: string };
const isClosure = shaped<ClosureRow>({
  request_id: isString,
  reading_id: nullable(isString),
  note: nullable(isString),
  closed_by: isString,
  closed_at: isString,
} satisfies Shape<ClosureRow>);

export const draftOf = (row: ReadingRow): FollowUpDraft | null => {
  const d = row.follow_up_draft;
  if (!isRecord(d) || !isString(d.to) || !isString(d.subject) || !isString(d.body) || !arrayOf(isString)(d.asks)) return null;
  return { to: d.to, subject: d.subject, body: d.body, asks: d.asks };
};

export type OverdueRow = {
  readonly id: string;
  readonly to_address: string;
  readonly subject: string;
  readonly asks: string[];
  readonly due_on: string | null;
  readonly sent_at: string | null;
};
const isOverdueRow = shaped<OverdueRow>({
  id: isString,
  to_address: isString,
  subject: isString,
  asks: arrayOf(isString),
  due_on: nullable(isString),
  sent_at: nullable(isString),
} satisfies Shape<OverdueRow>);

const inList = (ids: readonly string[]): string => `in.(${ids.join(',')})`;
const CHUNK = 50;

async function chunked<T>(ids: readonly string[], read: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const unique = [...new Set(ids)];
  const out: T[] = [];
  for (let i = 0; i < unique.length; i += CHUNK) out.push(...(await read(unique.slice(i, i + CHUNK))));
  return out;
}

/** #157 As leituras e gravações que os casos de uso usam. Um subrequest por chamada (ou por bloco de 50 ids). */
export class SupplierReplyStore {
  constructor(private readonly rest: SupabaseRest) {}

  async messagesOf(requestIds: readonly string[]): Promise<InboxMessage[]> {
    return chunked(requestIds, async (chunk) =>
      parseRows(await this.rest.select(INBOX, { filters: { request_id: inList(chunk) }, order: 'received_at' }), isInbox, INBOX),
    );
  }

  /**
   * #157/AC-1 As próximas respostas sem leitura, da mais antiga para a mais nova. As respostas são lidas em ordem
   * (toda resposta acaba com uma leitura, mesmo a ilegível), então a marca d'água é a data da última resposta lida:
   * 3 subrequests, sem varrer a caixa inteira. Uma resposta gravada com data anterior à marca não é vista.
   */
  async nextUnread(limit: number): Promise<InboxMessage[]> {
    const [last] = await this.rest.select(READINGS, { select: 'message_id', filters: { message_id: 'not.is.null' }, order: 'read_at.desc', limit: 1 });
    const lastId = isRecord(last) && isString(last.message_id) ? last.message_id : null;
    let filters: Record<string, string> = {};
    if (lastId) {
      const [msg] = parseRows(await this.rest.select(INBOX, { filters: { id: `eq.${lastId}` }, limit: 1 }), isInbox, INBOX);
      if (msg) filters = { received_at: `gte.${msg.received_at}` };
    }
    const candidates = parseRows(await this.rest.select(INBOX, { filters, order: 'received_at', limit: limit + 10 }), isInbox, INBOX);
    if (candidates.length === 0) return [];
    const read = new Set(
      (await this.rest.select(READINGS, { select: 'message_id', filters: { message_id: inList(candidates.map((m) => m.id)) } }))
        .map((r) => (isRecord(r) && isString(r.message_id) ? r.message_id : null)),
    );
    return candidates.filter((m) => !read.has(m.id)).slice(0, limit);
  }

  /** #157/AC-2 Os pedidos enviados com prazo vencido: 1 leitura (os 200 de prazo mais antigo), filtrados aqui. */
  async overdueSent(today: string): Promise<OverdueRow[]> {
    return parseRows(
      await this.rest.select('supplier_requests', {
        select: 'id,to_address,subject,asks,due_on,sent_at',
        filters: { status: 'eq.sent' },
        order: 'due_on',
        limit: 200,
      }),
      isOverdueRow,
      'supplier_requests',
    ).filter((r) => r.due_on !== null && r.due_on < today);
  }

  async readingsOf(requestIds: readonly string[]): Promise<ReadingRow[]> {
    return chunked(requestIds, async (chunk) =>
      parseRows(await this.rest.select(READINGS, { filters: { request_id: inList(chunk) }, order: 'read_at' }), isReading, READINGS),
    );
  }

  async confirmationsOf(requestIds: readonly string[]): Promise<ConfirmationRow[]> {
    return chunked(requestIds, async (chunk) =>
      parseRows(await this.rest.select(CONFIRMATIONS, { filters: { request_id: inList(chunk) } }), isConfirmation, CONFIRMATIONS),
    );
  }

  async followUpsOf(requestIds: readonly string[]): Promise<FollowUpRow[]> {
    return chunked(requestIds, async (chunk) =>
      parseRows(await this.rest.select(FOLLOW_UPS, { filters: { request_id: inList(chunk) }, order: 'published_at' }), isFollowUp, FOLLOW_UPS),
    );
  }

  async closuresOf(requestIds: readonly string[]): Promise<ClosureRow[]> {
    return chunked(requestIds, async (chunk) =>
      parseRows(await this.rest.select(CLOSURES, { filters: { request_id: inList(chunk) } }), isClosure, CLOSURES),
    );
  }

  async addClosure(row: ClosureRow & { readonly id: string }): Promise<void> {
    await this.rest.insert(CLOSURES, [row], { onConflict: 'request_id', ignoreDuplicates: true });
  }

  async addMessage(message: InboxMessage, attachments: readonly unknown[] = []): Promise<void> {
    await this.rest.insert(INBOX, [{ ...message, attachments }], { ignoreDuplicates: false });
  }

  async addReading(
    id: string,
    requestId: string,
    messageId: string | null,
    reading: SupplierReplyReading,
    meta: { readonly model: string | null; readonly at: string; readonly by: string },
  ): Promise<void> {
    await this.rest.insert(
      READINGS,
      [
        {
          id,
          request_id: requestId,
          message_id: messageId,
          outcome: reading.outcome,
          fulfilled_asks: reading.fulfilledAsks,
          supplier_document: reading.supplierDocument,
          summary: reading.summary,
          next_step: reading.nextStep,
          follow_up_draft: reading.followUpDraft,
          injection_flag: reading.injectionFlag,
          model: meta.model,
          read_at: meta.at,
          read_by: meta.by,
        },
      ],
      { ignoreDuplicates: false },
    );
  }

  async addConfirmation(row: ConfirmationRow & { readonly id: string }): Promise<void> {
    await this.rest.insert(CONFIRMATIONS, [row], { onConflict: 'reading_id', ignoreDuplicates: true });
  }

  async addFollowUp(row: Omit<FollowUpRow, 'published_at'> & { readonly to_address: string }): Promise<void> {
    await this.rest.insert(FOLLOW_UPS, [row], { onConflict: 'reading_id', ignoreDuplicates: true });
  }
}
