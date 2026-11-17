import { arrayOf, isInteger, isString, isUnknown, nullable, parseRows, shaped, type Shape } from '../connectors/guards.js';
import { SupabaseRestError, type Filters, type SupabaseRest } from '../connectors/supabase-rest.js';
import type { SupplierReading, SupplierRequestText } from '../domain/index.js';
import { SUPPLIER_FOLLOW_UP_TASK } from './follow-up-task.js';
import type { ClaimWrite, Clock, FollowUpClaim, FollowUpStamp, ReadingRecorded, ReplyRequest, ReplyRequestStore } from './reply-ports.js';
import { guarded, pgCode, refused } from './supabase-reply-call.js';
import { LEASE_MS } from './supabase-store.js';
import { READINGS_TABLE, readingToRow } from './supabase-reply-reading.js';
import {
  FOLLOW_UP_COLUMNS,
  OUTBOX_TABLE,
  READINGS_ORDER,
  REQUEST_SELECT,
  followUpShape,
  followUpSummary,
  isRequestRow,
  lastState,
  toReplyRequest,
  type FollowUpColumns,
} from './supabase-reply-request-row.js';

// #35: o pedido na leitura da resposta sobre o PostgREST. Toda gravação é UMA requisição numa tabela (uma transação):
// #35: a leitura é um POST no log supplier_reply_readings (append-only, a atual é derivada pela ordem das mensagens);
// #35: a cobrança é um PATCH guardado nas colunas follow_up_* de outbox_supplier_emails, sob a versão e o histórico da #12.
// #35: nenhuma gravação alcança a proposta, o título nem o valor em risco (#4/AC-6).

const INVOICES = 'invoices';
/** #35: as notas por requisição: a URL cresce com as chaves (44 algarismos cada). */
const KEYS_PER_REQUEST = 50;
const CLOSED_REASON = /^[a-z_]+: [a-z_]+$/;
const SHORT_REASON = /^[a-z][a-z0-9_]{0,39}$/;

const SENT = { status: 'eq.sent' } as const;
/** #35/AC-3: a cobrança não se repete: só grava rascunho ou recusa quem ainda não tem nenhum dos dois. */
const NO_TEXT = { ...SENT, follow_up_draft: 'is.null', follow_up_rejection: 'is.null' } as const;
/**
 * #35: a reivindicação do envio tem o prazo da #12 (`LEASE_MS`, o do `send_claim`): sem reivindicação, ou com uma mais velha que o
 * #35: prazo, o envio pode ser reivindicado de novo, com outra ficha (`follow_up_claim`, o `send_claim` da #12). A falha e o carimbo
 * #35: filtram pela ficha de quem os grava (`held`): quem perdeu a reivindicação no prazo recebe 0 linhas e não toca a linha. Risco
 * #35: aceito: se quem a perdeu chegou a enviar e morreu antes de gravar o carimbo, o segundo e-mail sai. Com o carimbo gravado
 * #35: (`follow_up_sent_at`) a reivindicação nunca vence.
 */
const claimable = (at: Date): Filters => ({
  ...SENT,
  follow_up_draft: 'not.is.null',
  follow_up_sent_at: 'is.null',
  or: `(follow_up_claimed_at.is.null,follow_up_claimed_at.lt.${new Date(at.getTime() - LEASE_MS).toISOString()})`,
});
/** #35: a guarda da falha e do carimbo: o envio ainda não carimbado e a reivindicação é a deste detentor, pela ficha. */
const held = (claim: FollowUpClaim): Filters => ({ ...SENT, follow_up_claim: `eq.${claim}`, follow_up_sent_at: 'is.null' });

type WriteRow = FollowUpColumns & { id: number; version: number; history: unknown[]; follow_up_claim: string | null };

const isWriteRow = shaped<WriteRow>({
  ...followUpShape,
  follow_up_claim: nullable(isString),
  id: isInteger,
  version: isInteger,
  history: arrayOf(isUnknown),
} satisfies Shape<WriteRow>);

const isInvoice = shaped<{ access_key: string; number: string }>({ access_key: isString, number: isString });
const isId = shaped<{ id: number }>({ id: isInteger });

/** #35: uma gravação da cobrança: o que muda, quem e quando, e a guarda atômica da transição. */
type FollowUpChange = {
  readonly action: 'follow_up_drafted' | 'follow_up_rejected' | 'follow_up_claimed' | 'follow_up_failed' | 'follow_up_sent';
  readonly by: string;
  readonly at: Date;
  readonly guard: Filters;
  readonly columns: Partial<FollowUpColumns> & { follow_up_claim?: string | null };
};

export function supabaseReplyRequestStore(rest: SupabaseRest, clock: Clock): ReplyRequestStore {
  /** #35 QR1b: o número da nota de origem de cada pedido; a tabela do pedido não tem chave estrangeira para invoices. */
  async function invoiceNumbers(keys: readonly string[]): Promise<Map<string, string>> {
    const numbers = new Map<string, string>();
    for (let start = 0; start < keys.length; start += KEYS_PER_REQUEST) {
      const filters = { access_key: `in.(${keys.slice(start, start + KEYS_PER_REQUEST).join(',')})` };
      const rows = await guarded(() => rest.select(INVOICES, { select: 'access_key,number', filters }));
      for (const row of parseRows(rows, isInvoice, INVOICES)) numbers.set(row.access_key, row.number);
    }
    return numbers;
  }

  /** #35 QR1 e QR2: o pedido, o fornecedor e as leituras numa requisição, mais as notas de origem. */
  async function load(filters: Filters, limit?: number): Promise<ReplyRequest[]> {
    const options = { select: REQUEST_SELECT, filters: { ...filters, ...READINGS_ORDER }, order: 'id', ...(limit === undefined ? {} : { limit }) };
    const rows = parseRows(await guarded(() => rest.select(OUTBOX_TABLE, options)), isRequestRow, OUTBOX_TABLE);
    const numbers = await invoiceNumbers([...new Set(rows.map((row) => row.invoice_access_key))]);
    return rows.map((row) => {
      const number = numbers.get(row.invoice_access_key);
      if (number === undefined) throw new SupabaseRestError('parse', INVOICES, 0, 'a nota de origem do pedido não foi achada');
      return toReplyRequest(row, number);
    });
  }

  /** #35: a linha lida para montar a gravação da cobrança: a versão, o histórico, as colunas da cobrança e a ficha da reivindicação. */
  async function readForWrite(id: number): Promise<WriteRow | null> {
    const select = `id,version,history,follow_up_claim,${FOLLOW_UP_COLUMNS}`;
    const rows = await guarded(() => rest.select(OUTBOX_TABLE, { select, filters: { id: `eq.${id}` }, limit: 1 }));
    return parseRows(rows, isWriteRow, OUTBOX_TABLE)[0] ?? null;
  }

  /**
   * #35: lê a linha e faz UM `PATCH` filtrado pela versão lida e pela guarda da transição, com a entrada de histórico no mesmo
   * `PATCH` (a disciplina da #12). `missing`: não há o pedido; `refused`: nenhuma linha passou na versão e na guarda.
   */
  async function writeFollowUp(id: number, change: FollowUpChange): Promise<'ok' | 'missing' | 'refused'> {
    const row = await readForWrite(id);
    if (row === null) return 'missing';
    const after: FollowUpColumns = { ...row, ...change.columns };
    const version = row.version + 1;
    const at = change.at.toISOString();
    const entry = { version, at, by: change.by, action: change.action, state: lastState(row.history), follow_up: followUpSummary(after) };
    const body = { ...change.columns, version, updated_at: at, history: [...row.history, entry] };
    const updated = await guarded(() => rest.update(OUTBOX_TABLE, { id: `eq.${id}`, version: `eq.${row.version}`, ...change.guard }, body));
    return updated.length > 0 ? 'ok' : 'refused';
  }

  /** #35/AC-3: rascunho e recusa: com um dos dois já gravado, volta sem gravar; qualquer outro motivo de recusa lança. */
  async function saveText(id: number, operation: string, change: FollowUpChange): Promise<void> {
    const written = await writeFollowUp(id, change);
    if (written === 'ok') return;
    const row = written === 'refused' ? await readForWrite(id) : null;
    if (row !== null && (row.follow_up_draft !== null || row.follow_up_rejection !== null)) return;
    throw refused(operation, OUTBOX_TABLE);
  }

  /**
   * #35: falha e envio da cobrança, de quem diz deter a reivindicação `claim`. Lê a linha: se a ficha não é a dele, volta `lost` sem
   * #35: gravar. O `PATCH` filtra pela ficha também; com 0 linhas relê: a ficha deixou de ser dele no meio (`lost`), ou o dado fora
   * #35: do esperado (a versão andou com a reivindicação dele de pé), que lança.
   */
  async function settle(id: number, claim: FollowUpClaim, change: FollowUpChange): Promise<ClaimWrite> {
    const row = await readForWrite(id);
    if (row === null) throw refused(change.action, OUTBOX_TABLE);
    if (row.follow_up_claim !== claim) return 'lost';
    const written = await writeFollowUp(id, { ...change, guard: held(claim) });
    if (written === 'ok') return 'recorded';
    if (written === 'refused' && (await readForWrite(id))?.follow_up_claim !== claim) return 'lost';
    throw refused(change.action, OUTBOX_TABLE);
  }

  /** #35 QR5: existe leitura que vence a recém-gravada? Só informa a saída da tarefa; qual vale é a projeção. */
  async function newerThan(id: number, messageId: number | null): Promise<boolean> {
    const filters = { request_id: `eq.${id}`, message_id: messageId === null ? 'not.is.null' : `gt.${messageId}` };
    const rows = await guarded(() => rest.select(READINGS_TABLE, { select: 'id', filters, limit: 1 }));
    return parseRows(rows, isId, READINGS_TABLE).length > 0;
  }

  /** #35 QR4: o único no_reply por pedido: o índice único parcial responde 409 com 23505 à segunda varredura. */
  async function insertSweep(row: Record<string, unknown>): Promise<'inserted' | 'already'> {
    try {
      await rest.insert(READINGS_TABLE, [row], { ignoreDuplicates: false });
      return 'inserted';
    } catch (error) {
      if (error instanceof SupabaseRestError && error.operation === 'insert' && error.status === 409 && pgCode(error.detail) === '23505') return 'already';
      return guarded(() => Promise.reject(error));
    }
  }

  return {
    get: async (id) => (await load({ id: `eq.${id}` }, 1))[0] ?? null,
    listSent: () => load(SENT),

    async recordReading(id: number, reading: SupplierReading, messageId: number | null): Promise<ReadingRecorded> {
      const row = readingToRow(id, messageId, reading);
      if (messageId === null) {
        if ((await insertSweep(row)) === 'already') return 'superseded';
      } else {
        // #35 QR3: uma leitura por mensagem; a repetida (retentativa de markRead) é ignorada e a primeira fica.
        await guarded(() => rest.insert(READINGS_TABLE, [row], { onConflict: 'message_id', ignoreDuplicates: true }));
      }
      return (await newerThan(id, messageId)) ? 'superseded' : 'recorded';
    },

    saveFollowUpDraft: (id: number, text: SupplierRequestText) =>
      saveText(id, 'save_follow_up_draft', {
        action: 'follow_up_drafted',
        by: SUPPLIER_FOLLOW_UP_TASK,
        at: clock.now(),
        guard: NO_TEXT,
        columns: { follow_up_draft: { subject: text.subject, body: text.body, asks: [...text.asks] } },
      }),

    recordFollowUpRejection(id, reason) {
      // #35/AC-3: só o motivo fechado da regra vai ao banco; o texto do modelo não é gravado.
      if (!CLOSED_REASON.test(reason)) return Promise.reject(refused('record_follow_up_rejection', OUTBOX_TABLE));
      return saveText(id, 'record_follow_up_rejection', {
        action: 'follow_up_rejected',
        by: SUPPLIER_FOLLOW_UP_TASK,
        at: clock.now(),
        guard: NO_TEXT,
        columns: { follow_up_rejection: reason },
      });
    },

    async claimFollowUpSend(id, by) {
      const at = clock.now();
      const claim = crypto.randomUUID();
      const columns = { follow_up_claimed_at: at.toISOString(), follow_up_claim: claim };
      const change: FollowUpChange = { action: 'follow_up_claimed', by, at, guard: claimable(at), columns };
      return (await writeFollowUp(id, change)) === 'ok' ? claim : null;
    },

    recordFollowUpFailure(id, claim, reason, by) {
      // #34/AC-4: o motivo curto da própria porta; o texto do provedor não cabe no formato e não é gravado.
      if (!SHORT_REASON.test(reason)) return Promise.reject(refused('record_follow_up_failure', OUTBOX_TABLE));
      return settle(id, claim, {
        action: 'follow_up_failed',
        by,
        at: clock.now(),
        guard: {},
        columns: { follow_up_claimed_at: null, follow_up_claim: null, follow_up_failure: reason },
      });
    },

    recordFollowUpSent: (id, claim, stamp: FollowUpStamp) =>
      settle(id, claim, {
        action: 'follow_up_sent',
        by: stamp.by,
        at: stamp.at,
        guard: {},
        // #35: a reivindicação fica de pé depois do envio, com a ficha: é ela que impede o segundo e-mail.
        columns: {
          follow_up_sent_by: stamp.by,
          follow_up_sent_at: stamp.at.toISOString(),
          follow_up_channel: stamp.channel,
          follow_up_provider_message_id: stamp.providerMessageId,
          follow_up_failure: null,
        },
      }),
  };
}
