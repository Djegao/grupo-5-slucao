import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Frame } from "../src/App";
import { fallbackContext } from "../src/shell/context";

// #3 O bloco "Pedido ao fornecedor" na gaveta da proposta decidida, como no wireframe
// artifacts/wireframe-pedido-ao-fornecedor/index.html. Esqueleto vermelho de ponta a ponta (#14):
// nada disso existe ainda. A API é falsa, no formato que a camada de contrato (#17) vai fixar com a #2;
// o JSON do pedido (campo `supplierRequest` do detalhe da proposta) e os caminhos das ações são provisórios.

const KEY = "35261100000000000000550010000200461000200461";
const money = (cents: number) => ({ cents, text: `R$ ${(cents / 100).toFixed(2).replace(".", ",")}` });

const MAIL_TEXT = "Na NF 20046 veio Shampoo 350 ml no lugar do Creme dental 90 g pedido.";
const draft = {
  id: "sr-1",
  status: "draft",
  returnNote: {
    number: "ND-0012",
    lines: [{ description: "Shampoo 350 ml", quantity: "40 UN", unitPrice: money(5408), total: money(216_320) }],
    total: money(216_320),
  },
  email: { to: "fiscal@higienetotal.test", dueOn: "2026-11-18", subject: "NF 20046 · devolução do item trocado", body: MAIL_TEXT },
  attachment: { name: "nota-devolucao-ND-0012.pdf", url: "/api/supplier-requests/sr-1/nota.pdf" },
};

const detail = (supplierRequest: unknown) => ({
  invoiceAccessKey: KEY,
  number: "20046",
  supplierId: "F11",
  store: "LJ-001",
  issuedOn: "2026-11-10",
  total: money(216_320),
  classification: "E2",
  exceptionCode: "E2",
  exceptionName: "Item trocado",
  level: "analista",
  line: 1,
  reason: "Item trocado (E2)",
  requiredApproverLevel: "analista",
  amountAtRisk: money(216_320),
  dockAction: { kind: "receber_parcial" },
  state: "decidida",
  canApprove: true,
  justification: "Item trocado",
  items: [],
  divergences: [],
  title: { state: "em_espera", amount: money(216_320), dueOn: "2026-11-18" },
  approval: { approver: "ana@jachegou.test", approverLevel: "analista", dockAction: { kind: "receber_parcial" }, justification: "x", decidedOn: "2026-11-15" },
  supplierRequest,
});

let current: unknown;
let calls: { method: string; path: string; body: unknown }[] = [];
let onPost: (path: string) => Response;

beforeEach(() => {
  calls = [];
  onPost = () => Response.json({}, { status: 200 });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const path = String(input);
      calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (method === "POST") return onPost(path);
      return Response.json(detail(current));
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

async function openDrawer() {
  window.history.replaceState(null, "", `/pagar/fila/${KEY}`);
  render(<Frame context={fallbackContext("ana@jachegou.test")} />);
  await screen.findByText("Decisão registrada");
}
const posted = (suffix: string) => calls.some((c) => c.method === "POST" && c.path.endsWith(suffix));

describe("#3 bloco Pedido ao fornecedor na gaveta", () => {
  it("#3/AC-1: a proposta decidida com pedido mostra o bloco com o selo do Claude", async () => {
    current = draft;
    await openDrawer();
    expect(await screen.findByText("Pedido ao fornecedor")).toBeTruthy();
    expect(screen.getAllByText("Claude").length).toBeGreaterThan(0);
  });

  it("#3/AC-1: sem pedido, o bloco não existe, nem o título", async () => {
    current = null;
    await openDrawer();
    expect(screen.queryByText("Pedido ao fornecedor")).toBeNull();
  });

  it("#3/AC-2: escrevendo mostra que o Claude está preparando, sem botões do pedido", async () => {
    current = { id: "sr-1", status: "writing" };
    await openDrawer();
    expect(await screen.findByText("O Claude está preparando o pedido…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Emitir e enviar" })).toBeNull();
  });

  it("#3/AC-3: o rascunho mostra a nota (itens, valores, total) e o e-mail (para, prazo, assunto, texto, anexo)", async () => {
    current = draft;
    await openDrawer();
    expect(await screen.findByText(/Shampoo 350 ml/)).toBeTruthy();
    expect(screen.getAllByText(/R\$ 2163,20/).length).toBeGreaterThan(0);
    expect(screen.getByText(/fiscal@higienetotal\.test/)).toBeTruthy();
    expect(screen.getByText(/NF 20046 · devolução do item trocado/)).toBeTruthy();
    expect(screen.getByText(MAIL_TEXT, { exact: false })).toBeTruthy();
    expect(screen.getByText(/nota-devolucao-ND-0012\.pdf/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Emitir e enviar" })).toBeTruthy();
  });

  it("#3/AC-4: Emitir e enviar chama a rota de envio, sem confirmação, e mostra emitida e enviada", async () => {
    current = draft;
    onPost = () => {
      current = { ...draft, status: "sent", sentBy: "ana@jachegou.test", sentAt: "2026-11-15T13:40:00Z" };
      return Response.json({ status: "sent" });
    };
    await openDrawer();
    fireEvent.click(await screen.findByRole("button", { name: "Emitir e enviar" }));
    expect(await screen.findByText(/Nota de devolução ND-0012 emitida e enviada por você às .* · aguardando resposta até 18\/11/)).toBeTruthy();
    expect(posted("/api/supplier-requests/sr-1/send")).toBe(true);
    expect(screen.queryByRole("button", { name: "Emitir e enviar" })).toBeNull();
    expect(screen.getByRole("link", { name: /nota-devolucao-ND-0012\.pdf/ })).toBeTruthy();
  });

  it("#3/AC-5: com o envio falho mostra o motivo e Tentar enviar de novo, sem Descartar nem Editar", async () => {
    current = { ...draft, status: "send_failed", failure: "caixa do fornecedor indisponível" };
    await openDrawer();
    expect(await screen.findByText("A nota ND-0012 foi emitida, mas o e-mail não saiu: caixa do fornecedor indisponível.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Descartar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Editar" })).toBeNull();
    onPost = () => {
      current = { ...draft, status: "sent", sentBy: "ana@jachegou.test", sentAt: "2026-11-15T13:45:00Z" };
      return Response.json({ status: "sent" });
    };
    fireEvent.click(screen.getByRole("button", { name: "Tentar enviar de novo" }));
    await waitFor(() => expect(posted("/api/supplier-requests/sr-1/send")).toBe(true));
    expect(await screen.findByText(/emitida e enviada por você/)).toBeTruthy();
  });

  it("#3/AC-6: Editar libera só o texto do e-mail; os números e os itens ficam travados", async () => {
    current = draft;
    await openDrawer();
    fireEvent.click(await screen.findByRole("button", { name: "Editar" }));
    const box = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    expect(box.value).toContain(MAIL_TEXT);
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect((screen.getByRole("button", { name: "Emitir e enviar" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Descartar" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box, { target: { value: "Texto novo da analista." } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar texto" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && JSON.stringify(c.body).includes("Texto novo da analista."))).toBe(true));
    fireEvent.click(await screen.findByRole("button", { name: "Editar" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancelar edição" }));
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("#3/AC-7: Descartar, sem confirmação, leva ao descartado, e Refazer volta a escrevendo", async () => {
    current = draft;
    onPost = (path) => {
      current = path.endsWith("/discard") ? { id: "sr-1", status: "discarded", discardedAt: "2026-11-15T13:41:00Z" } : { id: "sr-1", status: "writing" };
      return Response.json({});
    };
    await openDrawer();
    fireEvent.click(await screen.findByRole("button", { name: "Descartar" }));
    expect(await screen.findByText(/Pedido descartado por você às/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refazer" }));
    expect(await screen.findByText("O Claude está preparando o pedido…")).toBeTruthy();
    expect(posted("/api/supplier-requests/sr-1/discard")).toBe(true);
    expect(posted("/api/supplier-requests/sr-1/redo")).toBe(true);
  });

  it("#3/AC-8: sem rascunho por falha ou número fora do catálogo, mostra o motivo e Refazer", async () => {
    current = { id: "sr-1", status: "failed", failure: "o texto citou um número fora do catálogo" };
    await openDrawer();
    expect(await screen.findByText("Não foi possível preparar o pedido: o texto citou um número fora do catálogo")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Emitir e enviar" })).toBeNull();
    onPost = () => {
      current = { id: "sr-1", status: "writing" };
      return Response.json({});
    };
    fireEvent.click(screen.getByRole("button", { name: "Refazer" }));
    expect(await screen.findByText("O Claude está preparando o pedido…")).toBeTruthy();
    expect(posted("/api/supplier-requests/sr-1/redo")).toBe(true);
  });
});
