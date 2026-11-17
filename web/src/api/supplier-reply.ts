/**
 * #21 O fio da lista "Pedidos ao fornecedor" (#5) e da leitura da resposta (#4): `api/src/http/supplier-requests.ts` (#36).
 * A lista vem por filtro, com as contagens dos quatro filtros calculadas pelo servidor; a gaveta lê o pedido pela chave de acesso,
 * e "Cobrar" envia pelo `POST .../send`. O erro de uma chamada vira um motivo fechado (`SupplierReplyReason`): o corpo da resposta não sai daqui.
 */
import { ApiError, apiGet, apiPost } from "./client";
import type { ReadingListDto, ReplyFilterDto, SentRequestDetailDto, SupplierRequestDetailResponseDto } from "./contract";

/** #21 O prazo do envio da cobrança, como o do envio do pedido (#17): a chamada parada termina, não fica pendurada. */
export const FOLLOW_UP_SEND_TIMEOUT_MS = 30_000;

/** #21 Os motivos fechados de uma chamada falha; é o que a tela sabe de um erro (layer-exposure). */
export type SupplierReplyReason = "unauthorized" | "not_found" | "conflict" | "unavailable" | "unknown";

/** #21 O motivo de um erro: só o status decide, nunca o texto nem o corpo da resposta. */
export function supplierReplyReason(error: unknown): SupplierReplyReason {
  if (!(error instanceof ApiError)) return "unknown";
  if (error.isUnauthorized) return "unauthorized";
  if (error.status === 404) return "not_found";
  if (error.status === 409 || error.status === 422) return "conflict";
  if (error.status === 0 || error.status === 502 || error.status === 503) return "unavailable";
  return "unknown";
}

/** #21 O pedido da gaveta tem de estar `sent`, com a leitura e a cobrança; qualquer outra forma é falha de carga. */
function sentOf(response: SupplierRequestDetailResponseDto): SentRequestDetailDto {
  const request = response.request;
  if (request === null || request === undefined || request.status !== "sent" || !("followUp" in request)) {
    throw new ApiError(0, null, "a API não devolveu o pedido enviado");
  }
  return request;
}

const pathOf = (accessKey: string, action = ""): string => `/api/supplier-requests/${encodeURIComponent(accessKey)}${action}`;

/**
 * #5/AC-4 O envio devolve o pedido como ficou. Um 409 (já enviado, envio em curso, sem rascunho; #36) não é falha desconhecida: relê o pedido
 * e devolve como o servidor o tem, e é o `followUp.sent` dele que diz se a cobrança saiu. O corpo do 409 não é lido (layer-exposure).
 */
async function sendFollowUpOf(accessKey: string): Promise<SentRequestDetailDto> {
  try {
    return sentOf(await apiPost<SupplierRequestDetailResponseDto>(pathOf(accessKey, "/send"), {}, { timeoutMs: FOLLOW_UP_SEND_TIMEOUT_MS }));
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 409) throw error;
    return sentOf(await apiGet<SupplierRequestDetailResponseDto>(pathOf(accessKey)));
  }
}

export interface SupplierReplyApi {
  /** #21 As linhas do filtro e as contagens dos quatro filtros. */
  list: (filter: ReplyFilterDto, signal: AbortSignal) => Promise<ReadingListDto>;
  /** #21 O pedido enviado da gaveta, com a leitura e o rascunho da cobrança. */
  detail: (accessKey: string, signal: AbortSignal) => Promise<SentRequestDetailDto>;
  /** #21 Envia a cobrança do rascunho que o servidor guarda; devolve o pedido como ficou (com `followUp.sent` ou `followUp.failure`). */
  sendFollowUp: (accessKey: string) => Promise<SentRequestDetailDto>;
}

export const supplierReplyApi: SupplierReplyApi = {
  list: (filter, signal) => apiGet<ReadingListDto>(`/api/supplier-requests?status=${filter}`, { signal }),
  detail: async (accessKey, signal) => sentOf(await apiGet<SupplierRequestDetailResponseDto>(pathOf(accessKey), { signal })),
  sendFollowUp: sendFollowUpOf,
};
