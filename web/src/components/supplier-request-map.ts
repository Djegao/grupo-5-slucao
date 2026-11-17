// #21 Liga o contrato da lista dos pedidos ao fornecedor (api/src/http/supplier-requests.ts, #36) às visões da #19 e ao estado da #20.
// #21 Puro: sem API nem React. O servidor decide o filtro e as contagens; aqui só se traduz o formato, sem recontar nem refiltrar.
import type { NextStepDto, ReadingListDto, ReadingRowDto, ReplyFilterDto, SentRequestDetailDto } from "../api/contract";
import { texts } from "../texts";
import type { SendResult } from "./supplier-request-state";
import type {
  FollowUpDraftView,
  SupplierBlockStatus,
  SupplierConversationView,
  SupplierFilter,
  SupplierNextStep,
  SupplierReadingView,
  SupplierRequestRow,
  SupplierRowStatus,
} from "./supplier-request-view";

/** #5/AC-2 O filtro do servidor de cada chip da tela: Aguardando, Atendidos, Precisam de você e Atrasados. */
export const FILTER_OF_CHIP: Record<SupplierFilter, ReplyFilterDto> = {
  waiting: "awaiting",
  fulfilled: "answered",
  needsYou: "needs_you",
  late: "overdue",
};

/** #5/AC-4 Em quantos dias úteis vence a cobrança que a pessoa envia (o "Novo prazo" do rascunho, estado 8 do wireframe). */
export const FOLLOW_UP_BUSINESS_DAYS = 3;

const ZONE = "America/Sao_Paulo";

/** #21 O dia de hoje em São Paulo, AAAA-MM-DD: o mesmo dia que o servidor usa para decidir o que está no prazo (#36). */
export function todayInSaoPaulo(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** #21 O instante do carimbo em São Paulo: o dia (AAAA-MM-DD) e a hora ("HH:MM"); sem carimbo, nada a mostrar. */
export function momentOf(instant: string | null): { sentOn: string; sentTime?: string } {
  if (instant === null) return { sentOn: "—" };
  const at = new Date(instant);
  if (Number.isNaN(at.getTime())) return { sentOn: "—" };
  const sentTime = new Intl.DateTimeFormat("en-GB", { timeZone: ZONE, hour: "2-digit", minute: "2-digit", hour12: false }).format(at);
  return { sentOn: todayInSaoPaulo(at), sentTime };
}

/** #5/AC-4 O dia útil `days` dias depois de `from` (AAAA-MM-DD), pulando sábado e domingo; feriados não entram. */
export function followUpDueOn(from: string, days: number = FOLLOW_UP_BUSINESS_DAYS): string {
  const day = new Date(`${from}T00:00:00Z`);
  let left = days;
  while (left > 0) {
    day.setUTCDate(day.getUTCDate() + 1);
    const weekday = day.getUTCDay();
    if (weekday !== 0 && weekday !== 6) left -= 1;
  }
  return day.toISOString().slice(0, 10);
}

/** #5/AC-1 A coluna Fornecedor: o código e, havendo, o nome ("F07 Limpeza"). */
const supplierOf = (row: ReadingRowDto): string => (row.supplierName ? `${row.supplierId} ${row.supplierName}` : row.supplierId);

/**
 * #5/AC-2 A situação da linha, pelo filtro em que o servidor a pôs: o servidor é quem sabe o dia do prazo e o que fecha sozinho (#36),
 * então a tela não compara datas. Cada situação cai, na #20, no mesmo chip do filtro de onde veio.
 */
type Situation = { status: Exclude<SupplierRowStatus, "fulfilledToConfirm"> } | { status: "fulfilledToConfirm"; document: string };

function rowStatus(row: ReadingRowDto, filter: ReplyFilterDto): Situation {
  if (filter === "awaiting") return { status: "waiting" };
  if (filter === "overdue") return { status: "late" };
  if (filter === "answered") return { status: "fulfilled" };
  switch (row.reading?.replyOutcome) {
    case "needs_information":
      return { status: "needsInformation" };
    case "refused":
      return { status: "refused" };
    case "partially_fulfilled":
      return { status: "partiallyFulfilled" };
    default:
      // #36 Atendeu com documento citado nunca fecha sozinho: fica para a pessoa confirmar.
      return { status: "fulfilledToConfirm", document: row.reading?.supplierDocument ?? "—" };
  }
}

/** #5/AC-1 A linha da grid, a partir da linha do contrato e do filtro que a trouxe. */
export function rowOf(row: ReadingRowDto, filter: ReplyFilterDto): SupplierRequestRow {
  const base = {
    id: String(row.id),
    invoiceNumber: row.invoiceNumber,
    supplier: supplierOf(row),
    request: texts.supplierRequests.requestTypes[row.requestType],
    amountCents: row.totalCents,
    dueOn: row.dueOn,
  };
  return { ...base, ...rowStatus(row, filter) };
}

/** #5/AC-1 As linhas do filtro que o servidor devolveu. */
export const rowsOf = (list: ReadingListDto): SupplierRequestRow[] => list.requests.map((row) => rowOf(row, list.filter));

/** #5/AC-2 As contagens dos chips, como o servidor as calculou. */
export function countsOf(list: ReadingListDto): Record<SupplierFilter, number> {
  return { waiting: list.counts.awaiting, fulfilled: list.counts.answered, needsYou: list.counts.needs_you, late: list.counts.overdue };
}

/** #5/AC-2 Nenhum pedido enviado, em nenhum dos quatro filtros: é o vazio geral da tela. */
export const isEmptyList = (list: ReadingListDto): boolean => Object.values(list.counts).every((count) => count === 0);

const BLOCK_STATUS: Record<SupplierRequestRow["status"], SupplierBlockStatus> = {
  waiting: "waiting",
  late: "late",
  fulfilledToConfirm: "fulfilledToConfirm",
  fulfilled: "fulfilled",
  partiallyFulfilled: "partiallyFulfilled",
  needsInformation: "needsYou",
  refused: "refused",
};

function readingOf(detail: SentRequestDetailDto, row: SupplierRequestRow, charged: boolean): SupplierReadingView {
  const reading = detail.reading;
  // #21 Cobrado (followUp.sent): sem próximo passo, como o estado 9 do wireframe.
  const nextStep = (step: NextStepDto): SupplierNextStep | null => (charged ? null : step);
  // #21 Sem leitura (a resposta ainda não foi lida): só o atrasado tem o que fazer, que é cobrar.
  if (reading === null) return { replyOutcome: "no_reply", summary: "", nextStep: row.status === "late" ? nextStep("follow_up") : null };
  const itemsFulfilled = reading.fulfilledAsks.join(", ");
  return {
    replyOutcome: reading.replyOutcome,
    ...(itemsFulfilled === "" ? {} : { itemsFulfilled }),
    ...(reading.supplierDocument === null ? {} : { documentCited: reading.supplierDocument }),
    summary: reading.summary,
    nextStep: nextStep(reading.nextStep),
    ...(reading.injectionFlag === null ? {} : { injectionExcerpt: reading.injectionFlag }),
  };
}

/** #5/AC-3 A conversa e a leitura do agente da gaveta, a partir do pedido que o `GET` devolveu. O contrato não traz o texto da resposta. */
export function conversationOf(row: SupplierRequestRow, detail: SentRequestDetailDto, today: string): SupplierConversationView {
  const charged = detail.followUp.sent;
  return {
    status: charged ? "waitingCharged" : BLOCK_STATUS[row.status],
    sent: {
      document: detail.returnNote.number ?? "—",
      amountCents: row.amountCents,
      ...momentOf(detail.sentAt),
      dueOn: detail.email.dueOn,
    },
    reply: null,
    asOf: today,
    reading: readingOf(detail, row, charged),
  };
}

/** #5/AC-4 O rascunho da cobrança que o servidor guarda; nulo quando não há ou já não confere com o catálogo (#36). */
export function draftOf(detail: SentRequestDetailDto, today: string): FollowUpDraftView | null {
  const draft = detail.followUp.draft;
  if (draft === null) return null;
  return {
    to: detail.email.to,
    dueOn: followUpDueOn(today),
    subject: draft.subject,
    body: draft.body,
    // #36 A cobrança sai sem anexo (o servidor manda `attachments: []`).
    attachmentName: texts.supplierRequests.draft.noAttachment,
  };
}

/**
 * #5/AC-4 O que o envio devolve à tela, pelo pedido como ficou: enviado, ou o motivo fechado da falha. O código da falha vem do servidor,
 * mas a tela só conhece "o e-mail recusou" ou "não sei": o texto de um erro de fora nunca entra (layer-exposure).
 */
export function sendResultOf(detail: SentRequestDetailDto): SendResult {
  const { sent, sentAt, failure } = detail.followUp;
  if (sent) return { ok: true, ...momentOf(sentAt) };
  return { ok: false, failure: failure === null ? "unknown" : "mailRefused" };
}
