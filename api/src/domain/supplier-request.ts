import { renderText, textChecks, type FactCatalog } from './dossier.js';
import { DomainError, InvalidTransitionError } from './errors.js';
import type { ReturnNote } from './return-note-emission.js';

/* #156: o pedido ao fornecedor: o e-mail (e, quando a decisão devolve, a nota de devolução emitida)
   que o agente prepara para a pessoa revisar, emitir e enviar. Nada sai sem uma pessoa (AC-3). */

export type SupplierRequestType = // #156
  | 'return_note'
  | 'cancel_invoice'
  | 'deliver_missing'
  | 'purchase_order_number'
  | 'registry_data'
  | 'notice';

export type SupplierRequestStatus = 'writing' | 'draft' | 'sent' | 'discarded' | 'send_failed'; // #156
export type SupplierRequestChannel = 'mock' | 'resend'; // #156

/** #156: de quem é a ação quando não é de uma pessoa: o descarte pela validação do texto. */
export const SYSTEM_ACTOR = 'system';

/** #156: motivos que o domínio mesmo registra ao descartar. O descarte por uma pessoa traz o dela. */
export type DraftDiscardReason = 'number_mismatch' | 'invalid_shape';

const OPEN_STATUSES: ReadonlySet<SupplierRequestStatus> = new Set(['writing', 'draft', 'send_failed']);

/** #156/AC-8: aberto é escrevendo, rascunho ou envio falhado. Enviado e descartado não bloqueiam. */
export const isOpenStatus = (status: SupplierRequestStatus): boolean => OPEN_STATUSES.has(status);

/** #156/AC-8: a nota de origem já tem um pedido aberto deste tipo? */
export function hasOpenRequest(
  requests: readonly {
    readonly invoiceAccessKey: string;
    readonly requestType: SupplierRequestType;
    readonly status: SupplierRequestStatus;
  }[],
  invoiceAccessKey: string,
  requestType: SupplierRequestType,
): boolean {
  return requests.some(
    (r) => r.invoiceAccessKey === invoiceAccessKey && r.requestType === requestType && isOpenStatus(r.status),
  );
}

/** #156: o anexo do e-mail. Hoje só a nota de devolução emitida, em JSON. */
export type SupplierRequestAttachment = {
  readonly kind: 'return_note';
  readonly notaId: string;
  readonly filename: string;
};

export type SupplierRequestSnapshot = {
  /** #156: a identidade do pedido, dada por quem o abre: o domínio não gera identificadores. */
  readonly id: string;
  readonly createdAt: string;
  readonly createdBy: string;
  /** #156: quando e por quem o pedido mudou pela última vez; ao abrir, quando e por quem foi aberto. */
  readonly updatedAt: string;
  readonly updatedBy: string;
  readonly invoiceAccessKey: string;
  readonly supplierId: string;
  readonly requestType: SupplierRequestType;
  readonly to: string;
  readonly subject: string;
  readonly body: string | null;
  readonly asks: readonly string[];
  readonly attachments: readonly SupplierRequestAttachment[];
  readonly dueOn: string | null;
  readonly status: SupplierRequestStatus;
  readonly sendFailure: string | null;
  readonly channel: SupplierRequestChannel;
  readonly model: string | null;
  readonly draftedAt: string | null;
  readonly editedBy: string | null;
  readonly editedAt: string | null;
  readonly sentBy: string | null;
  readonly sentAt: string | null;
  readonly providerMessageId: string | null;
  readonly discardedBy: string | null;
  readonly discardedAt: string | null;
  readonly discardReason: string | null;
};

export type SupplierRequestOpenProps = {
  id: string;
  /** #156: quando e por quem o pedido foi aberto: o instante da decisão e quem decidiu. */
  createdAt: string;
  createdBy: string;
  invoiceAccessKey: string;
  supplierId: string;
  requestType: SupplierRequestType;
  to: string;
  /** #156: o assunto, com o número da nota de origem, posto pela regra e não pelo Claude. */
  subject: string;
  /** #156: o que o fornecedor precisa fazer, fixo da regra. */
  asks: readonly string[];
  channel: SupplierRequestChannel;
};

export type DraftMeta = {
  readonly draftedAt: string;
  readonly model: string;
  /** #156: o prazo de resposta, 'AAAA-MM-DD'; o padrão é `defaultDueOn(draftedAt)`. */
  readonly dueOn: string;
};

/** #156: o schema da saída estruturada do Claude: só o corpo, com os números como `{{chave}}`. */
export const SUPPLIER_REQUEST_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['body'],
  properties: { body: { type: 'string' } },
} as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;
const MARKER = /\{\{([^{}]+)\}\}/g;

const markers = (text: string): Set<string> => new Set([...text.matchAll(MARKER)].map((m) => m[1] ?? ''));

const catalogAccepts = (text: string, catalog: FactCatalog): boolean =>
  textChecks(text, catalog, new Set(catalog.identifiers));

/**
 * #156: o prazo padrão: 3 dias úteis depois de `draftedAt`, pulando sábado e domingo. Conta pela
 * data do instante em UTC.
 */
export function defaultDueOn(draftedAt: string, businessDays = 3): string {
  if (!ISO_DATE.test(draftedAt)) throw new DomainError(`SupplierRequest: data inválida ${draftedAt}`);
  const date = new Date(`${draftedAt.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new DomainError(`SupplierRequest: data inválida ${draftedAt}`);
  let remaining = businessDays;
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6) remaining -= 1;
  }
  return date.toISOString().slice(0, 10);
}

/** #156: o pedido ao fornecedor: raiz do agregado. Os asks e os anexos não mudam por edição. */
export class SupplierRequest {
  readonly id: string;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly invoiceAccessKey: string;
  readonly supplierId: string;
  readonly requestType: SupplierRequestType;
  readonly to: string;
  readonly subject: string;
  readonly asks: readonly string[];
  readonly channel: SupplierRequestChannel;
  private data: Omit<SupplierRequestSnapshot, 'id' | 'createdAt' | 'createdBy' | 'invoiceAccessKey' | 'supplierId' | 'requestType' | 'to' | 'subject' | 'asks' | 'channel'>;

  private constructor(s: SupplierRequestSnapshot) {
    this.id = s.id;
    this.createdAt = s.createdAt;
    this.createdBy = s.createdBy;
    this.invoiceAccessKey = s.invoiceAccessKey;
    this.supplierId = s.supplierId;
    this.requestType = s.requestType;
    this.to = s.to;
    this.subject = s.subject;
    this.asks = Object.freeze([...s.asks]);
    this.channel = s.channel;
    this.data = {
      body: s.body,
      attachments: Object.freeze([...s.attachments]),
      dueOn: s.dueOn,
      status: s.status,
      sendFailure: s.sendFailure,
      model: s.model,
      draftedAt: s.draftedAt,
      updatedAt: s.updatedAt,
      updatedBy: s.updatedBy,
      editedBy: s.editedBy,
      editedAt: s.editedAt,
      sentBy: s.sentBy,
      sentAt: s.sentAt,
      providerMessageId: s.providerMessageId,
      discardedBy: s.discardedBy,
      discardedAt: s.discardedAt,
      discardReason: s.discardReason,
    };
  }

  /** #156/AC-1: o pedido nasce escrevendo e espera a tarefa do Claude. Nada é emitido nem enviado. */
  static open(props: SupplierRequestOpenProps): SupplierRequest {
    if (props.id.trim() === '') throw new DomainError('SupplierRequest: o pedido precisa de identidade');
    if (props.to.trim() === '') throw new DomainError('SupplierRequest: o fornecedor não tem e-mail no cadastro');
    return new SupplierRequest({
      ...props,
      updatedAt: props.createdAt,
      updatedBy: props.createdBy,
      body: null,
      attachments: [],
      dueOn: null,
      status: 'writing',
      sendFailure: null,
      model: null,
      draftedAt: null,
      editedBy: null,
      editedAt: null,
      sentBy: null,
      sentAt: null,
      providerMessageId: null,
      discardedBy: null,
      discardedAt: null,
      discardReason: null,
    });
  }

  /** #156: reconstitui o pedido do que a persistência guardou. */
  static restore(snapshot: SupplierRequestSnapshot): SupplierRequest {
    return new SupplierRequest(snapshot);
  }

  snapshot(): SupplierRequestSnapshot {
    return Object.freeze({
      id: this.id,
      createdAt: this.createdAt,
      createdBy: this.createdBy,
      invoiceAccessKey: this.invoiceAccessKey,
      supplierId: this.supplierId,
      requestType: this.requestType,
      to: this.to,
      subject: this.subject,
      asks: this.asks,
      channel: this.channel,
      ...this.data,
    });
  }

  get updatedAt(): string {
    return this.data.updatedAt;
  }
  get updatedBy(): string {
    return this.data.updatedBy;
  }
  get status(): SupplierRequestStatus {
    return this.data.status;
  }
  get isOpen(): boolean {
    return isOpenStatus(this.data.status);
  }
  get body(): string | null {
    return this.data.body;
  }
  get attachments(): readonly SupplierRequestAttachment[] {
    return this.data.attachments;
  }
  get dueOn(): string | null {
    return this.data.dueOn;
  }
  get sendFailure(): string | null {
    return this.data.sendFailure;
  }
  get model(): string | null {
    return this.data.model;
  }
  get draftedAt(): string | null {
    return this.data.draftedAt;
  }
  get editedBy(): string | null {
    return this.data.editedBy;
  }
  get editedAt(): string | null {
    return this.data.editedAt;
  }
  get sentBy(): string | null {
    return this.data.sentBy;
  }
  get sentAt(): string | null {
    return this.data.sentAt;
  }
  get providerMessageId(): string | null {
    return this.data.providerMessageId;
  }
  get discardedBy(): string | null {
    return this.data.discardedBy;
  }
  get discardedAt(): string | null {
    return this.data.discardedAt;
  }
  get discardReason(): string | null {
    return this.data.discardReason;
  }

  /**
   * #156/AC-6: recebe a resposta crua do Claude. Só o campo `body` é lido, e todo número dele tem de
   * ser um `{{chave}}` do catálogo: com um número solto ou um marcador desconhecido o rascunho é
   * descartado, com o motivo registrado. Devolve o estado em que o pedido ficou.
   */
  acceptDraft(raw: unknown, catalog: FactCatalog, meta: DraftMeta): 'draft' | 'discarded' {
    this.assertStatus(['writing'], 'aceitar o texto do Claude');
    const body = typeof raw === 'object' && raw !== null && 'body' in raw ? raw.body : undefined;
    if (typeof body !== 'string' || body.trim() === '') {
      this.discardBySystem('invalid_shape', meta.draftedAt);
      return 'discarded';
    }
    if (!catalogAccepts(body, catalog)) {
      this.discardBySystem('number_mismatch', meta.draftedAt);
      return 'discarded';
    }
    this.data = {
      ...this.data,
      status: 'draft',
      body,
      model: meta.model,
      draftedAt: meta.draftedAt,
      dueOn: meta.dueOn,
      updatedBy: SYSTEM_ACTOR,
      updatedAt: meta.draftedAt,
    };
    return 'draft';
  }

  /** #156: o corpo com os marcadores trocados pelos valores do banco, como o fornecedor o lê. */
  renderedBody(catalog: FactCatalog): string {
    if (this.data.body === null) throw new DomainError('SupplierRequest: o pedido ainda não tem texto');
    return renderText(this.data.body, catalog);
  }

  /**
   * #156/AC-7: a pessoa edita só o texto do e-mail, e só em rascunho. Números, itens e asks ficam
   * travados: o texto novo não pode ter número fora do catálogo nem trocar o conjunto de marcadores.
   */
  editBody(text: string, catalog: FactCatalog, by: string, at: string): void {
    this.assertStatus(['draft'], 'editar o texto');
    if (text.trim() === '') throw new DomainError('SupplierRequest: o texto do e-mail não pode ficar vazio');
    if (!catalogAccepts(text, catalog)) {
      throw new DomainError('SupplierRequest: o texto traz um número ou um marcador que não está no catálogo');
    }
    const before = markers(this.data.body ?? '');
    const after = markers(text);
    if (before.size !== after.size || [...before].some((k) => !after.has(k))) {
      throw new DomainError('SupplierRequest: os números do e-mail são travados; os marcadores não mudam');
    }
    this.data = { ...this.data, body: text, editedBy: by, editedAt: at, updatedBy: by, updatedAt: at };
  }

  /** #156/AC-4: anexa a nota de devolução emitida, uma só vez. Reemitir não gera outra. */
  attachReturnNote(note: ReturnNote, by: string, at: string): void {
    this.assertStatus(['draft', 'send_failed'], 'anexar a nota de devolução');
    if (this.data.attachments.some((a) => a.kind === 'return_note')) {
      throw new DomainError('SupplierRequest: a nota de devolução já está anexa');
    }
    const attachment: SupplierRequestAttachment = Object.freeze({
      kind: 'return_note',
      notaId: note.nota_id,
      filename: `nota-devolucao-${note.nota_id}.json`,
    });
    this.data = {
      ...this.data,
      attachments: Object.freeze([...this.data.attachments, attachment]),
      updatedBy: by,
      updatedAt: at,
    };
  }

  /** #156/AC-5: o envio feito; de `draft`, ou de `send_failed` na nova tentativa, sem reemitir. */
  markSent(by: string, at: string, providerMessageId: string): void {
    this.assertStatus(['draft', 'send_failed'], 'enviar');
    if (this.requestType === 'return_note' && this.data.attachments.length === 0) {
      throw new DomainError('SupplierRequest: o pedido de devolução só sai com a nota de devolução emitida');
    }
    this.data = {
      ...this.data,
      status: 'sent',
      sendFailure: null,
      sentBy: by,
      sentAt: at,
      providerMessageId,
      updatedBy: by,
      updatedAt: at,
    };
  }

  /** #156: o envio falhou; a nota segue emitida e o motivo fica registrado. */
  markSendFailed(reason: string, by: string, at: string): void {
    this.assertStatus(['draft', 'send_failed'], 'registrar a falha do envio');
    this.data = { ...this.data, status: 'send_failed', sendFailure: reason, updatedBy: by, updatedAt: at };
  }

  /** #156: a pessoa descarta o pedido, escrevendo, em rascunho ou com o envio falhado. */
  discard(by: string, at: string, reason: string): void {
    this.assertStatus(['writing', 'draft', 'send_failed'], 'descartar');
    this.data = { ...this.data, status: 'discarded', discardedBy: by, discardedAt: at, discardReason: reason, updatedBy: by, updatedAt: at };
  }

  private discardBySystem(reason: DraftDiscardReason, at: string): void {
    this.data = {
      ...this.data,
      status: 'discarded',
      discardedBy: SYSTEM_ACTOR,
      discardedAt: at,
      discardReason: reason,
      updatedBy: SYSTEM_ACTOR,
      updatedAt: at,
    };
  }

  private assertStatus(allowed: readonly SupplierRequestStatus[], action: string): void {
    if (!allowed.includes(this.data.status)) {
      throw new InvalidTransitionError('SupplierRequest', this.data.status, action);
    }
  }
}
