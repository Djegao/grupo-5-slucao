// #156: as portas dos casos de uso do pedido ao fornecedor. A camada de OLTP implementa as de
// persistência; o envio tem o mock em memória aqui e o do banco (outbox_supplier_emails) no OLTP.
import type { ReturnNoteLine } from '../connectors/ports.js';
import type {
  CheckContext,
  DecidedProposal,
  InvoiceView,
  ReturnNote,
  SupplierRequest,
  SupplierRequestChannel,
  SupplierRequestStatus,
  SupplierRequestType,
} from '../domain/index.js';

/** #156/AC-8: o repositório do agregado. Quem grava confere o `updatedAt` lido, para duas pessoas não se pisarem. */
export interface SupplierRequestRepository {
  findById(id: string): Promise<SupplierRequest | null>;
  listByInvoice(invoiceAccessKey: string): Promise<SupplierRequest[]>;
  listByStatus(status: SupplierRequestStatus): Promise<SupplierRequest[]>;
  /** #156/AC-8: o pedido aberto (escrevendo, rascunho ou envio falhado) deste tipo para a nota. */
  findOpen(invoiceAccessKey: string, requestType: SupplierRequestType): Promise<SupplierRequest | null>;
  /** #156/AC-8: insere o pedido novo; `duplicate_open` quando a corrida já deixou outro aberto (unicidade no banco). */
  add(request: SupplierRequest): Promise<'saved' | 'duplicate_open'>;
  /** #156: grava só se o `updatedAt` guardado ainda é `expectedUpdatedAt`; senão `stale`. */
  save(request: SupplierRequest, expectedUpdatedAt: string): Promise<'saved' | 'stale'>;
}

/** #156/AC-4: as notas de devolução que o mock emitiu, guardadas pela linha da fila da #140 que as originou. */
export interface ReturnNoteEmissions {
  findByQueueRow(queueRowId: number): Promise<ReturnNote | null>;
  findByNoteId(noteId: string): Promise<ReturnNote | null>;
  /** #156: o próximo sequencial do mock (vira `numero` e o sufixo de `nota_id`). */
  nextSequence(): Promise<number>;
  /** #156/AC-4: grava a nota da linha; se a linha já tem uma (corrida), devolve a que ficou. */
  save(queueRowId: number, note: ReturnNote): Promise<ReturnNote>;
}

export type QueueRow = {
  /** #156: o id da linha em outbox_return_notes. */
  readonly id: number;
  /** #156/AC-2: o valor da devolução na fila, em centavos (linhas vezes o preço na nota de origem). */
  readonly valueCents: number;
};

/** #156: a fila de notas de devolução da #140, como o pedido a usa. */
export interface ReturnNoteWorkQueue {
  /**
   * #156/AC-2: a linha da fila para a nota e as linhas devolvidas; se não existe, publica pela caixa
   * `ReturnNoteOutbox`, que é idempotente. Publicar não emite: a linha fica `pendente`.
   */
  ensureRow(input: {
    readonly invoiceAccessKey: string;
    readonly lines: readonly ReturnNoteLine[];
    readonly reason: string;
  }): Promise<QueueRow>;
  /**
   * #156/AC-4: pendente → emitida com o número da ND. Reemitir uma linha já emitida com o mesmo
   * número vale `ok`; outro número ou uma linha cancelada, `conflict`.
   */
  markEmitted(id: number, number: string, by: string, at: Date): Promise<'ok' | 'not_found' | 'conflict'>;
}

/** #156/AC-5: o e-mail que a porta de envio recebe; o corpo já vem com os marcadores trocados. */
export type SupplierEmail = {
  readonly requestId: string;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly attachments: readonly { readonly filename: string; readonly contentType: string; readonly content: string }[];
};

/**
 * #156/AC-5: o resultado do envio. `reason` é um código curto do adaptador (como `mailbox_unavailable`),
 * nunca o texto de erro nem a resposta do provedor: ele vai para o pedido e daí para a gaveta.
 */
export type SendResult =
  | { readonly ok: true; readonly providerMessageId: string; readonly channel: SupplierRequestChannel }
  | { readonly ok: false; readonly reason: string };

export interface SupplierEmailSender {
  send(email: SupplierEmail): Promise<SendResult>;
}

/** #156: o cadastro de fornecedores, só o e-mail. */
export interface SupplierDirectory {
  emailOf(supplierId: string): Promise<string | null>;
}

/** #156: a proposta decidida com tudo o que a regra da devolução lê. */
export type DecidedCase = {
  readonly proposal: DecidedProposal;
  readonly invoice: InvoiceView;
  /** #156: o WMS tem recebimento para a nota. */
  readonly goodsEntered: boolean;
  /** #156: o contexto do catálogo de fatos, como o dossiê o lê. */
  readonly context: CheckContext;
  /** #156: quando e por quem foi decidida; sem o dado, vale o instante da varredura e o sistema. */
  readonly decidedAt: string | null;
  readonly decidedBy: string | null;
};

export interface DecidedProposalSource {
  /** #156/AC-1: as propostas decididas (aprovada ou alterada). Quem não qualifica a regra descarta. */
  listDecided(): Promise<DecidedCase[]>;
  find(invoiceAccessKey: string): Promise<DecidedCase | null>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

export type SupplierRequestConfig = {
  /** #156: o CNPJ da Já Chegou, o emitente da nota de devolução. */
  readonly issuerCnpj: string;
  /** #156/AC-5: o canal escolhido pela configuração; fica no pedido ao abrir. */
  readonly channel: SupplierRequestChannel;
  /** #156: o modelo do Claude que escreve o texto; sem valor, o padrão do cliente. */
  readonly model?: string;
};

export type SupplierRequestDeps = {
  readonly requests: SupplierRequestRepository;
  readonly emissions: ReturnNoteEmissions;
  readonly queue: ReturnNoteWorkQueue;
  readonly sender: SupplierEmailSender;
  readonly directory: SupplierDirectory;
  readonly source: DecidedProposalSource;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly config: SupplierRequestConfig;
};
