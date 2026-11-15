import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { texts } from "../texts";
import type { SupplierRequestView } from "./SupplierRequestBlock";
import type { SupplierRequestPort } from "./supplier-request-state";
import { useSupplierRequest } from "./useSupplierRequest";

// #3 O gancho do bloco "Pedido ao fornecedor" (#16): o que ele entrega ao bloco, sem desenhar nada.
// #16 O caminho pela tela inteira está em SupplierRequestSection.test.tsx.

const KEY = "35261100000000000000550010000080001000080001";
const email = { to: "fiscal@higienetotal.test", dueOn: "2026-11-18", subject: "NF 80", body: "Texto" };
const draft: SupplierRequestView = { status: "draft", email };

const port = (over: Partial<SupplierRequestPort> = {}): SupplierRequestPort => ({
  load: vi.fn(async () => draft),
  send: vi.fn(async () => ({ status: "sent", sentBy: "ana", sentAt: "2026-11-15T13:40:00Z", email }) as SupplierRequestView),
  resend: vi.fn(),
  discard: vi.fn(),
  redo: vi.fn(),
  saveText: vi.fn(),
  ...over,
});

describe("#3 gancho useSupplierRequest", () => {
  it("#3/AC-1: antes de carregar, o pedido é nulo e o bloco não existe", () => {
    const { result } = renderHook(() => useSupplierRequest(port({ load: vi.fn(() => new Promise<null>(() => undefined)) }), KEY));
    expect(result.current.request).toBeNull();
  });

  it("#3/AC-3: carregado, entrega o rascunho", async () => {
    const { result } = renderHook(() => useSupplierRequest(port(), KEY));
    await waitFor(() => expect(result.current.request?.status).toBe("draft"));
  });

  it("#3/AC-4: onSend passa pelo pendente e termina em enviada", async () => {
    const p = port();
    const { result } = renderHook(() => useSupplierRequest(p, KEY));
    await waitFor(() => expect(result.current.request?.status).toBe("draft"));
    act(() => result.current.onSend());
    expect(result.current.pending).toBe("send");
    await waitFor(() => expect(result.current.request?.status).toBe("sent"));
    expect(result.current.pending).toBeUndefined();
    expect(p.send).toHaveBeenCalledWith(KEY);
  });

  it("#3/AC-4: a ação recusada entrega a mensagem do status, nunca o texto do erro", async () => {
    const p = port({ send: vi.fn(async () => Promise.reject(new ApiError(409, "interno", "corpo cru"))) });
    const { result } = renderHook(() => useSupplierRequest(p, KEY));
    await waitFor(() => expect(result.current.request?.status).toBe("draft"));
    act(() => result.current.onSend());
    await waitFor(() => expect(result.current.error).toBe(texts.supplierRequest.errors.conflict));
    expect(result.current.request?.status).toBe("draft");
  });

  it("#3/AC-6: onEdit entrega o estado editing e onCancelEdit devolve o rascunho", async () => {
    const { result } = renderHook(() => useSupplierRequest(port(), KEY));
    await waitFor(() => expect(result.current.request?.status).toBe("draft"));
    act(() => result.current.onEdit());
    expect(result.current.request?.status).toBe("editing");
    expect(result.current.draftText).toBe("Texto");
    act(() => result.current.onCancelEdit());
    expect(result.current.request?.status).toBe("draft");
  });

  it("#3/AC-2: o intervalo da consulta é o que a gaveta passa", async () => {
    const load = vi.fn<SupplierRequestPort["load"]>().mockResolvedValueOnce({ status: "writing" }).mockResolvedValue(draft);
    const { result } = renderHook(() => useSupplierRequest(port({ load }), KEY, 10));
    await waitFor(() => expect(result.current.request?.status).toBe("draft"));
    expect(load).toHaveBeenCalledTimes(2);
  });
});
