// #20 O estado puro da lista "Pedidos ao fornecedor" (história #5): chip ativo, contagens, ordem, gaveta e fluxo da cobrança.
// #20 Sem API nem React: a lista de linhas e o resultado do envio entram como dados; a #21 liga os dois ao contrato.
import type { FollowUpFailure, FollowUpPhaseState } from "../approval/FollowUpDraft";
import type { SupplierFilter, SupplierFilterValue, SupplierRequestRow, SupplierRowStatus } from "./supplier-request-view";

/** #5/AC-2 O chip em que cada situação cai, como o wireframe aprovado decide (Q2): cada solicitação cai em um só chip. */
const CHIP_OF_STATUS: Record<SupplierRowStatus, SupplierFilter> = {
  waiting: "waiting",
  late: "late",
  fulfilledToConfirm: "needsYou",
  fulfilled: "fulfilled",
  partiallyFulfilled: "needsYou",
  needsInformation: "needsYou",
  refused: "needsYou",
};

/** #5/AC-2 A contagem de cada chip, sobre todas as linhas. */
export function countByChip(rows: SupplierRequestRow[]): Record<SupplierFilter, number> {
  const counts: Record<SupplierFilter, number> = { waiting: 0, fulfilled: 0, needsYou: 0, late: 0 };
  for (const row of rows) counts[CHIP_OF_STATUS[row.status]] += 1;
  return counts;
}

/** #5/AC-1 As linhas do chip (todas em `all`), por prazo crescente (Q8); prazos iguais ficam na ordem recebida. */
export function visibleRows(rows: SupplierRequestRow[], filter: SupplierFilterValue): SupplierRequestRow[] {
  const chosen = filter === "all" ? rows : rows.filter((row) => CHIP_OF_STATUS[row.status] === filter);
  return [...chosen].sort((a, b) => (a.dueOn < b.dueOn ? -1 : a.dueOn > b.dueOn ? 1 : 0));
}

/** #5/AC-4 O que o envio devolve: quando saiu, ou o motivo fechado da falha; o texto de um erro de fora nunca entra (layer-exposure). */
export type SendResult = { ok: true; sentOn: string; sentTime?: string } | { ok: false; failure: FollowUpFailure };

/** #5/AC-4 Uma cobrança que saiu: o novo prazo da linha e quando foi enviada. */
export interface ChargedRequest {
  dueOn: string;
  sentOn: string;
  sentTime?: string;
}

/** #5/AC-2 A linha cobrada passa a Aguardando com o novo prazo e sai de Atrasados (Q7, estado 9 do wireframe). */
export function applyCharges(rows: SupplierRequestRow[], charged: Record<string, ChargedRequest>): SupplierRequestRow[] {
  if (Object.keys(charged).length === 0) return rows;
  return rows.map((row): SupplierRequestRow => {
    const charge = charged[row.id];
    if (!charge) return row;
    const { id, invoiceNumber, supplier, request, amountCents } = row;
    return { id, invoiceNumber, supplier, request, amountCents, dueOn: charge.dueOn, status: "waiting" };
  });
}

/** #5/AC-4 O rascunho aberto: a fase, se o texto está liberado e o texto editado (`null` enquanto vale o do rascunho). */
export interface FollowUpFlow {
  phase: FollowUpPhaseState;
  editing: boolean;
  body: string | null;
}

/** #5/AC-3 A gaveta: o pedido aberto e o bloco em que abre; todo clique abre em "Pedido ao fornecedor", com ou sem rascunho. */
export interface DrawerState {
  requestId: string;
  block: "supplierRequest";
  followUp: FollowUpFlow | null;
}

export interface ScreenState {
  filter: SupplierFilterValue;
  drawer: DrawerState | null;
  charged: Record<string, ChargedRequest>;
}

/** #5/AC-2 A lista abre com o chip Aguardando (Q3). */
export const INITIAL_STATE: ScreenState = { filter: "waiting", drawer: null, charged: {} };

export type ScreenAction =
  | { type: "filter"; filter: SupplierFilterValue }
  | { type: "openRow"; id: string }
  | { type: "openFollowUp"; id: string }
  | { type: "close" }
  | { type: "edit" }
  | { type: "changeBody"; body: string }
  | { type: "discard" }
  | { type: "sendStarted" }
  | { type: "sendSucceeded"; id: string; dueOn: string; sentOn: string; sentTime?: string }
  | { type: "sendFailed"; id: string; failure: FollowUpFailure };

/** #5/AC-4 O texto e o descarte só mudam em revisão ou depois de uma falha: enviando e enviado ficam como estão. */
function isOpenForChange(flow: FollowUpFlow | null): flow is FollowUpFlow {
  return flow !== null && (flow.phase.phase === "review" || flow.phase.phase === "failed");
}

function withFlow(state: ScreenState, flow: FollowUpFlow): ScreenState {
  return state.drawer ? { ...state, drawer: { ...state.drawer, followUp: flow } } : state;
}

/** #5/AC-4 Uma cobrança só sai uma vez por sessão e com uma pessoa: o id já cobrado não abre rascunho de novo (estado 9 do wireframe). */
function openFollowUp(state: ScreenState, id: string): ScreenState {
  if (id in state.charged) return state;
  const flow = state.drawer?.requestId === id ? state.drawer.followUp : null;
  if (flow && (flow.phase.phase === "sending" || flow.phase.phase === "sent")) return state;
  return { ...state, drawer: { requestId: id, block: "supplierRequest", followUp: { phase: { phase: "review" }, editing: false, body: null } } };
}

function sendSucceeded(state: ScreenState, action: Extract<ScreenAction, { type: "sendSucceeded" }>): ScreenState {
  const { id, dueOn, sentOn, sentTime } = action;
  const time = sentTime === undefined ? {} : { sentTime };
  const charged = { ...state.charged, [id]: { dueOn, sentOn, ...time } };
  const flow = state.drawer?.requestId === id ? state.drawer.followUp : null;
  if (!state.drawer || !flow) return { ...state, charged };
  return { ...state, charged, drawer: { ...state.drawer, followUp: { ...flow, phase: { phase: "sent", sentOn, ...time } } } };
}

function sendFailed(state: ScreenState, id: string, failure: FollowUpFailure): ScreenState {
  const flow = state.drawer?.requestId === id ? state.drawer.followUp : null;
  if (!flow || flow.phase.phase !== "sending") return state;
  return withFlow(state, { ...flow, phase: { phase: "failed", failure } });
}

/** #5/AC-4 A edição do rascunho toca só o texto; enviar vai de revisar a enviando e então a enviado ou falho, sem pular fase. */
export function screenReducer(state: ScreenState, action: ScreenAction): ScreenState {
  const flow = state.drawer?.followUp ?? null;
  switch (action.type) {
    case "filter":
      return { ...state, filter: action.filter };
    case "openRow":
      if (state.drawer?.requestId === action.id) return state;
      return { ...state, drawer: { requestId: action.id, block: "supplierRequest", followUp: null } };
    case "openFollowUp":
      return openFollowUp(state, action.id);
    case "close":
      return { ...state, drawer: null };
    case "edit":
      return isOpenForChange(flow) && !flow.editing ? withFlow(state, { ...flow, editing: true }) : state;
    case "changeBody":
      return isOpenForChange(flow) && flow.editing ? withFlow(state, { ...flow, body: action.body }) : state;
    case "discard":
      return state.drawer && flow && flow.phase.phase !== "sending" ? { ...state, drawer: { ...state.drawer, followUp: null } } : state;
    case "sendStarted":
      return isOpenForChange(flow) ? withFlow(state, { ...flow, phase: { phase: "sending" } }) : state;
    case "sendSucceeded":
      return sendSucceeded(state, action);
    case "sendFailed":
      return sendFailed(state, action.id, action.failure);
  }
}
