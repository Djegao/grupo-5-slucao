import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import { texts } from "../texts";
import type { SupplierRequestView } from "./SupplierRequestBlock";
import { initialSupplierRequestState, supplierRequestError, supplierRequestReducer, viewOf, type SupplierRequestState } from "./supplier-request-state";

// #3 A conta pura do estado do bloco "Pedido ao fornecedor" (#16): sem rede e sem tela.

const email = { to: "fiscal@higienetotal.test", dueOn: "2026-11-18", subject: "NF 20046 · devolução", body: "Texto original" };
const draft: SupplierRequestView = { status: "draft", email };
const withRequest = (request: SupplierRequestView | null, extra: Partial<SupplierRequestState> = {}): SupplierRequestState => ({ ...initialSupplierRequestState, request, ...extra });

describe("#3 estado do pedido ao fornecedor: transições", () => {
  it("#3/AC-1: sem pedido carregado, nada é desenhado", () => {
    expect(viewOf(initialSupplierRequestState)).toBeNull();
    expect(viewOf(supplierRequestReducer(initialSupplierRequestState, { type: "loaded", request: null }))).toBeNull();
  });

  it("#3/AC-3: carregar um rascunho mostra o rascunho", () => {
    expect(viewOf(supplierRequestReducer(initialSupplierRequestState, { type: "loaded", request: draft }))).toEqual(draft);
  });

  it("#3/AC-2: a busca periódica troca escrevendo por rascunho", () => {
    const next = supplierRequestReducer(withRequest({ status: "writing" }), { type: "loaded", request: draft });
    expect(viewOf(next)?.status).toBe("draft");
  });

  it("#3/AC-6: a busca periódica não pisa numa ação em andamento nem numa edição", () => {
    const busy = withRequest({ status: "writing" }, { pending: "redo" });
    expect(supplierRequestReducer(busy, { type: "loaded", request: draft })).toBe(busy);
    const editing = withRequest(draft, { editing: true });
    expect(supplierRequestReducer(editing, { type: "loaded", request: { status: "writing" } })).toBe(editing);
  });

  it("#3/AC-4: iniciar a ação marca o pendente e limpa o erro anterior", () => {
    const next = supplierRequestReducer(withRequest(draft, { error: "antigo" }), { type: "started", pending: "send" });
    expect(next.pending).toBe("send");
    expect(next.error).toBeUndefined();
  });

  it("#3/AC-4: a ação feita guarda o pedido novo e solta o pendente", () => {
    const sent: SupplierRequestView = { status: "sent", sentBy: "ana@jachegou.test", sentAt: "2026-11-15T13:40:00Z", email };
    const next = supplierRequestReducer(withRequest(draft, { pending: "send" }), { type: "done", request: sent });
    expect(next.request).toEqual(sent);
    expect(next.pending).toBeUndefined();
  });

  it("#3/AC-4: a ação recusada volta ao estado de antes, com a mensagem", () => {
    const next = supplierRequestReducer(withRequest(draft, { pending: "send" }), { type: "failed", error: "mensagem" });
    expect(next.request).toEqual(draft);
    expect(next.pending).toBeUndefined();
    expect(next.error).toBe("mensagem");
  });

  it("#3/AC-6: editar abre a edição com o texto do e-mail; os botões do rascunho viram os da edição", () => {
    const next = supplierRequestReducer(withRequest(draft), { type: "editStarted" });
    expect(viewOf(next)?.status).toBe("editing");
    expect(next.draftText).toBe("Texto original");
  });

  it("#3/AC-6: só um rascunho se edita, e não durante uma ação", () => {
    const sent = withRequest({ status: "writing" });
    expect(supplierRequestReducer(sent, { type: "editStarted" })).toBe(sent);
    const busy = withRequest(draft, { pending: "send" });
    expect(supplierRequestReducer(busy, { type: "editStarted" })).toBe(busy);
  });

  it("#3/AC-6: cancelar a edição volta ao rascunho e esquece o erro", () => {
    const next = supplierRequestReducer(withRequest(draft, { editing: true, error: "x", draftText: "digitado" }), { type: "editCancelled" });
    expect(viewOf(next)?.status).toBe("draft");
    expect(next.error).toBeUndefined();
  });

  it("#3/AC-6: salvar com erro mantém a edição aberta com o texto digitado", () => {
    const editing = withRequest(draft, { editing: true, draftText: "digitado", pending: "save" });
    const next = supplierRequestReducer(editing, { type: "failed", error: "mensagem" });
    expect(viewOf(next)?.status).toBe("editing");
    expect(next.draftText).toBe("digitado");
  });

  it("#3/AC-6: salvar com sucesso fecha a edição e traz o texto novo", () => {
    const saved: SupplierRequestView = { status: "draft", email: { ...email, body: "Texto novo" } };
    const next = supplierRequestReducer(withRequest(draft, { editing: true, pending: "save" }), { type: "done", request: saved });
    expect(next.editing).toBe(false);
    expect(viewOf(next)).toEqual(saved);
  });

  it("#3/AC-6: digitar guarda o texto", () => {
    expect(supplierRequestReducer(withRequest(draft, { editing: true }), { type: "textChanged", text: "abc" }).draftText).toBe("abc");
  });
});

describe("#3 estado do pedido ao fornecedor: mensagem por status", () => {
  const errors = texts.supplierRequest.errors;
  it.each([
    [403, errors.forbidden],
    [409, errors.conflict],
    [422, errors.unprocessable],
    [500, errors.other],
    [0, errors.other],
  ])("#3/AC-4: o status %i vira a mensagem do texto", (status, message) => {
    expect(supplierRequestError(new ApiError(status, "detalhe_interno", "corpo cru da API"))).toBe(message);
  });

  it("#3/AC-4: um erro que não é da API vira a mensagem genérica, sem o texto do erro", () => {
    expect(supplierRequestError(new Error("stack interno"))).toBe(errors.other);
  });
});
