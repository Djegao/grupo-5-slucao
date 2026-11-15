import type {
  InvoiceView,
  IssuedReturnNote,
  RequestTextRejection,
  RequestType,
  ReturnNoteDraft,
  SupplierRequest,
  SupplierRequestText,
} from '../domain/index.js';
import type { ReturnNoteQueue } from '../returns/return-notes.js';

// #11: as portas do pedido ao fornecedor (#2). Os casos de uso dependem destas interfaces; o banco, a
// #11: caixa de saída mock e o relógio de verdade são das camadas de baixo (OLTP e API), não desta.

/** #11: o relógio do caso de uso; o domínio não lê a hora (ADR-005). */
export type Clock = { now(): Date };

/** #11: o pedido como a persistência o guarda: a raiz, a devolução da fila e o e-mail do fornecedor. */
export type RequestRecord = {
  readonly request: SupplierRequest;
  /** #11: a devolução da fila (#140) que deu origem ao pedido; a raiz não a conhece. */
  readonly queueId: number;
  /** #11/AC-10 (#2): o e-mail de teste do fornecedor, onde o pedido é entregue. */
  readonly to: string;
};

/** #11/AC-2: o que o Claude escreveu foi aceito (rascunho) ou recusado (nasce descartado com o motivo). */
export type DraftOutcome =
  | { readonly kind: 'draft'; readonly text: SupplierRequestText }
  | { readonly kind: 'rejected'; readonly rejection: RequestTextRejection };

/** #11: o que se grava de novo; quem grava dá o id e monta a raiz com ele (SupplierRequest.draft ou rejected). */
export type NewRequest = {
  readonly invoiceAccessKey: string;
  readonly queueId: number;
  readonly note: ReturnNoteDraft;
  readonly to: string;
  /** #11: o dia do rascunho, AAAA-MM-DD; o prazo conta daqui. */
  readonly draftedOn: string;
  /** #11: o modelo que escreveu o texto, para o registro. */
  readonly model: string;
  readonly outcome: DraftOutcome;
};

/** #11: `conflict` é o índice único parcial (um pedido aberto por nota de origem e tipo) que recusou a gravação. */
export type CreateResult = { readonly kind: 'ok'; readonly record: RequestRecord } | { readonly kind: 'conflict' };

/** #11/AC-4: o carimbo do envio (ADR-005): quem, quando, por qual canal e o identificador que o canal deu. */
export type SendStamp = {
  readonly by: string;
  readonly at: Date;
  readonly channel: 'mock' | 'resend';
  readonly providerMessageId: string;
};

/** #11: o carimbo humano que acompanha a gravação; o estado em si vem da raiz. */
export type RequestChange = {
  readonly sent?: SendStamp;
  readonly discarded?: { readonly by: string; readonly at: Date };
};

export interface SupplierRequestStore {
  /** #11/AC-6: o pedido aberto (draft, sent ou send_failed) da nota de origem e do tipo, se houver. */
  findOpen(invoiceAccessKey: string, requestType: RequestType): Promise<RequestRecord | null>;
  get(id: number): Promise<RequestRecord | null>;
  create(request: NewRequest): Promise<CreateResult>;
  /** #11: grava o estado atual da raiz (estado, corpo, motivos, nota emitida) e o carimbo, se houver. */
  save(request: SupplierRequest, change?: RequestChange): Promise<void>;
}

/** #11/AC-5: a emissão mock, idempotente por devolução da fila: a segunda chamada devolve a nota já emitida. */
export interface IssuedNoteStore {
  issue(queueId: number, draft: ReturnNoteDraft, issuedOn: string): Promise<IssuedReturnNote>;
}

/** #11/AC-10: a nota de origem e o e-mail de teste do fornecedor dela. */
export type SourceInvoice = { readonly invoice: InvoiceView; readonly supplierEmail: string };

export interface SourceInvoices {
  find(invoiceAccessKey: string): Promise<SourceInvoice | null>;
}

/** #11/AC-4: o anexo do e-mail; a nota emitida em JSON no formato do kit. */
export type MailAttachment = { readonly filename: string; readonly contentType: string; readonly content: string };

/** #11/AC-4: o e-mail pronto, com os números já no lugar dos marcadores. */
export type MailMessage = {
  readonly invoiceAccessKey: string;
  readonly supplierId: string;
  readonly requestType: RequestType;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly asks: readonly string[];
  readonly attachments: readonly MailAttachment[];
  readonly dueOn: string;
};

/** #11/AC-5: `reason` é curto e próprio da porta (nunca o texto do provedor): vai para o pedido e para a pessoa. */
export type MailResult =
  | { readonly ok: true; readonly channel: 'mock' | 'resend'; readonly providerMessageId: string }
  | { readonly ok: false; readonly reason: string };

export interface SupplierMailer {
  send(message: MailMessage): Promise<MailResult>;
}

/** #11: tudo de que os casos de uso e a tarefa dependem. */
export type SupplierDeps = {
  readonly queue: ReturnNoteQueue;
  readonly requests: SupplierRequestStore;
  readonly notes: IssuedNoteStore;
  readonly source: SourceInvoices;
  readonly mailer: SupplierMailer;
  readonly clock: Clock;
};
