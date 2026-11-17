/**
 * #17 O fio do pedido ao fornecedor (`api/src/http/supplier-requests.ts`, #13): as rotas são pela chave de acesso
 * da nota de origem. É a implementação de `SupplierRequestPort`, que o estado (#16) usa sem saber de rede.
 */
import { ApiError, apiGet, apiPatch, apiPost } from "./client";
import type { SupplierRequestDto, SupplierRequestResponseDto } from "./contract";

/** #17 As chamadas que o estado precisa; cada ação devolve o pedido como ficou. */
export interface SupplierRequestPort {
  load: (accessKey: string, signal: AbortSignal) => Promise<SupplierRequestDto | null>;
  send: (accessKey: string) => Promise<SupplierRequestDto>;
  resend: (accessKey: string) => Promise<SupplierRequestDto>;
  discard: (accessKey: string) => Promise<SupplierRequestDto>;
  redo: (accessKey: string) => Promise<SupplierRequestDto>;
  /** #17/AC-6 Salva o molde do texto (com os `{{chave}}`); o servidor reconfere os números. */
  saveTemplate: (accessKey: string, template: string) => Promise<SupplierRequestDto>;
}

const pathOf = (accessKey: string, action = ""): string => `/api/supplier-requests/${encodeURIComponent(accessKey)}${action}`;

/** #17 A API garante `request` em toda escrita; faltando, a ação falha em vez de a tela supor um estado. */
function requestOf(response: SupplierRequestResponseDto): SupplierRequestDto {
  if (response.request === null || response.request === undefined) throw new ApiError(0, null, "a API não devolveu o pedido");
  return response.request;
}

const post = async (accessKey: string, action: string): Promise<SupplierRequestDto> =>
  requestOf(await apiPost<SupplierRequestResponseDto>(pathOf(accessKey, action), {}));

export const supplierRequestApi: SupplierRequestPort = {
  load: async (accessKey, signal) => {
    try {
      return (await apiGet<SupplierRequestResponseDto>(pathOf(accessKey), { signal })).request ?? null;
    } catch (reason) {
      // #17/AC-1 Nota sem pedido: é o bloco que não existe, não falha de carga.
      if (reason instanceof ApiError && reason.status === 404) return null;
      throw reason;
    }
  },
  send: (accessKey) => post(accessKey, "/send"),
  resend: (accessKey) => post(accessKey, "/resend"),
  discard: (accessKey) => post(accessKey, "/discard"),
  redo: (accessKey) => post(accessKey, "/redo"),
  saveTemplate: async (accessKey, template) => requestOf(await apiPatch<SupplierRequestResponseDto>(pathOf(accessKey), { template })),
};
