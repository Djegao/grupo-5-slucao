import type {
  RequestFilter,
  RequestStatus,
  RequestType,
  ReturnNoteDraft,
  SupplierReading,
  SupplierRequestText,
} from '../domain/index.js';

// #34: as portas da leitura da resposta do fornecedor (#4). Os casos de uso dependem destas interfaces;
// #34: o banco, a caixa de entrada mock, a caixa de saída e o relógio de verdade são das camadas de baixo.
// #34: nenhuma porta aqui escreve na proposta, no título nem no valor em risco (#4/AC-6): a gravação só alcança a leitura.

/** #34: o relógio do caso de uso; igual ao de #11 (ADR-005): o domínio não lê a hora. */
export type Clock = { now(): Date };

/** #34/AC-1: a resposta do fornecedor na caixa de entrada mock (inbox_supplier_messages), ligada ao pedido. */
export type InboxMessage = {
  readonly id: number;
  readonly requestId: number;
  /** #34: o texto do fornecedor: dado, nunca instrução; só o prompt o lê, escapado em <dados>. */
  readonly text: string;
};

export interface SupplierInbox {
  /** #34/AC-1: as mensagens com read_status `pending`. */
  listPending(): Promise<InboxMessage[]>;
  /** #34: a mensagem, se ainda estiver `pending`; lida, com erro ou inexistente, null. */
  get(id: number): Promise<InboxMessage | null>;
  /** #34/AC-1: a leitura foi aceita e gravada: a mensagem fica lida. */
  markRead(id: number): Promise<void>;
  /** #34/AC-1: a leitura foi recusada: a mensagem fica `error` com o motivo fechado, nunca com o texto do modelo ou do fornecedor. */
  markError(id: number, reason: string): Promise<void>;
}

/** #34/AC-4: o carimbo do envio da cobrança (ADR-005); o mesmo formato do carimbo de #11. */
export type FollowUpStamp = {
  readonly by: string;
  readonly at: Date;
  readonly channel: 'mock' | 'resend';
  readonly providerMessageId: string;
};

/** #34: o estado da cobrança no pedido. */
export type FollowUpState = {
  /** #34/AC-3: o rascunho no formato do pedido, com {{chave}}; null enquanto não há. */
  readonly draft: SupplierRequestText | null;
  /** #34/AC-3: o motivo de o texto do Claude ter sido recusado; sem rascunho. */
  readonly rejection: string | null;
  /** #34/AC-4: quem e quando enviou; null enquanto não saiu. */
  readonly sent: FollowUpStamp | null;
  /** #34/AC-4: o motivo curto da última falha do envio, da própria porta; nunca o texto do provedor. */
  readonly failure: string | null;
};

/** #34: o pedido como a leitura o vê: o que a lista, o prazo e a cobrança precisam. */
export type ReplyRequest = {
  readonly id: number;
  readonly invoiceAccessKey: string;
  readonly invoiceNumber: string;
  readonly supplierName: string | null;
  readonly requestType: RequestType;
  /** #34: o e-mail de teste do fornecedor, onde a cobrança é entregue. */
  readonly to: string;
  /** #34: a nota montada pela regra; dela vêm o fornecedor, o total e o catálogo de fatos. */
  readonly note: ReturnNoteDraft;
  /** #34: o que pedimos, como o pedido guarda (forma com {{chave}}). */
  readonly asks: readonly string[];
  readonly subject: string;
  readonly dueOn: string;
  readonly status: RequestStatus;
  readonly reading: SupplierReading | null;
  readonly followUp: FollowUpState;
};

/** #34/AC-1, #35: `superseded` é a leitura gravada no log que não é a atual: o pedido tem uma de mensagem mais nova. */
export type ReadingRecorded = 'recorded' | 'superseded';

/**
 * #34/AC-2: a gravação do pedido. Só há escrita da leitura e da cobrança: não existe método para a
 * proposta, o título nem o valor em risco, então a tarefa não tem como tocá-los.
 */
export interface ReplyRequestStore {
  get(id: number): Promise<ReplyRequest | null>;
  /** #34: os pedidos `sent`; é de onde saem a varredura, a tarefa da cobrança e a lista. */
  listSent(): Promise<ReplyRequest[]>;
  /**
   * #34/AC-1, #35: grava a leitura do pedido como um fato novo (append-only), numa requisição só, sem ler antes.
   * `messageId` é a mensagem de onde ela veio. A leitura atual do pedido é derivada pela ordem das mensagens:
   * a de maior id vence, e a leitura de qualquer mensagem vence a da varredura do prazo (origem nula), então a
   * resposta tardia vence o no_reply (#34). Uma leitura antiga que chega depois de uma nova (o runner #66 roda as
   * chaves novas antes das retentativas) é gravada e perde pela ordem. `superseded` quer dizer: gravada no log,
   * mas não é a leitura atual. A mesma mensagem lida duas vezes mantém a primeira leitura. `null` é a varredura
   * do prazo: grava um único no_reply por pedido e, se já havia um, devolve `superseded`.
   */
  recordReading(id: number, reading: SupplierReading, messageId: number | null): Promise<ReadingRecorded>;
  saveFollowUpDraft(id: number, text: SupplierRequestText): Promise<void>;
  recordFollowUpRejection(id: number, reason: string): Promise<void>;
  /**
   * #34/AC-4: reivindica o envio da cobrança antes do e-mail sair: true para quem ganhou, false se já
   * há envio reivindicado ou carimbado. O OLTP tem de garantir que é uma transição guardada e atômica
   * (um UPDATE condicional por pedido), e `by` entra no histórico (#35), para duas chamadas ao mesmo tempo não ganharem as duas.
   */
  claimFollowUpSend(id: number, by: string): Promise<boolean>;
  /** #34/AC-4: grava o motivo da falha e solta a reivindicação, para a pessoa poder tentar de novo; `by` entra no histórico (#35). */
  recordFollowUpFailure(id: number, reason: string, by: string): Promise<void>;
  /** #34/AC-4: grava o carimbo; a reivindicação fica presa depois dele, e só a falha do envio a solta. */
  recordFollowUpSent(id: number, stamp: FollowUpStamp): Promise<void>;
}

/** #34/AC-4: o e-mail da cobrança, com a forma do MailMessage de #11, para o adaptador de #11 servir aqui. */
export type FollowUpMail = {
  readonly invoiceAccessKey: string;
  readonly supplierId: string;
  readonly requestType: RequestType;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly asks: readonly string[];
  readonly attachments: readonly { readonly filename: string; readonly contentType: string; readonly content: string }[];
  readonly dueOn: string;
};

/** #34/AC-4: igual ao MailResult de #11; `reason` é da porta, nunca o texto do provedor. */
export type FollowUpMailResult =
  | { readonly ok: true; readonly channel: 'mock' | 'resend'; readonly providerMessageId: string }
  | { readonly ok: false; readonly reason: string };

export interface FollowUpMailer {
  send(message: FollowUpMail): Promise<FollowUpMailResult>;
}

/** #34: tudo de que as tarefas e os casos de uso da leitura dependem. */
export type ReplyDeps = {
  readonly inbox: SupplierInbox;
  readonly requests: ReplyRequestStore;
  readonly mailer: FollowUpMailer;
  readonly clock: Clock;
};

/** #34/AC-5: a linha da lista; a leitura vai inteira, a camada da API dá os nomes do contrato. */
export type ReplyListRow = {
  readonly id: number;
  readonly invoiceAccessKey: string;
  readonly invoiceNumber: string;
  readonly supplierId: string;
  readonly supplierName: string | null;
  readonly requestType: RequestType;
  readonly totalValue: number;
  readonly dueOn: string;
  readonly status: RequestStatus;
  readonly reading: SupplierReading | null;
  readonly followUpDrafted: boolean;
  readonly followUpSent: boolean;
};

export type ReplyList = {
  readonly filter: RequestFilter;
  readonly rows: readonly ReplyListRow[];
  readonly counts: Readonly<Record<RequestFilter, number>>;
};
