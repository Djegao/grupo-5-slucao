import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Frame } from "../src/App";
import type { ReadingRowDto, ReplyFilterDto, SentRequestDetailDto } from "../src/api/contract";
import { fallbackContext, NAVIGATION } from "../src/shell/context";

/**
 * #18 Esqueleto de ponta a ponta da lista "Pedidos ao fornecedor" (história #5), escrito contra o
 * wireframe aprovado em artifacts/wireframe-pedidos-fornecedor/index.html.
 *
 * #21 Ele nasceu vermelho de propósito, em `describe.skip` com `it.fails` (#18): as dependências do web não instalam (#25).
 * #21 Agora a rota, a lista e a gaveta estão ligadas ao contrato (api/src/http/supplier-requests.ts, #36), e cada comportamento é um `it`.
 *
 * #21 A API é falsa e fala o contrato de verdade: `GET /api/supplier-requests?status=` devolve `{ filter, requests, counts }` com as
 * #21 contagens dos quatro filtros, `GET /api/supplier-requests/{chave}` devolve o pedido enviado com a leitura e o rascunho da
 * #21 cobrança, e `POST .../send` envia a cobrança. A tela não conta nem filtra por conta própria: o que ela mostra é o que o servidor disse.
 */

/** #21 Um pedido da API falsa e o filtro em que o servidor o põe. */
interface Fixture {
  row: ReadingRowDto;
  filter: ReplyFilterDto;
}

const keyOf = (id: number): string => String(id).padStart(44, "0");

const fixture = (id: number, invoiceNumber: string, supplierId: string, supplierName: string, totalCents: number, dueOn: string, filter: ReplyFilterDto): Fixture => ({
  row: {
    id,
    invoiceAccessKey: keyOf(id),
    invoiceNumber,
    supplierId,
    supplierName,
    requestType: "return_note",
    totalCents,
    dueOn,
    status: "sent",
    reading: null,
    followUp: { drafted: filter === "overdue", sent: false },
  },
  filter,
});

/** #5 O cenário "cobrar um atrasado": dois pedidos atrasados e um aguardando (filtro inicial). Dados fictícios. */
const SUPPLIER_REQUESTS: Fixture[] = [
  fixture(1, "59738", "F07", "Limpeza", 26362, "2026-11-14", "overdue"),
  fixture(2, "40519", "F09", "Embalagens", 154090, "2026-11-12", "overdue"),
  fixture(3, "51877", "F02", "Bebidas", 98000, "2026-11-20", "awaiting"),
];

/** #21 O pedido enviado que o `GET /api/supplier-requests/{chave}` devolve: sem leitura (atrasado) e com o rascunho da cobrança. */
function sentView(row: ReadingRowDto): SentRequestDetailDto {
  return {
    status: "sent",
    invoiceAccessKey: row.invoiceAccessKey,
    requestType: "return_note",
    returnNote: { number: "ND-6", supplier: row.supplierId, reference: row.invoiceNumber, lines: [], total: { text: "R$ 263,62" } },
    email: { to: "financeiro@f07-limpeza.example", dueOn: row.dueOn, subject: "Devolução", body: "Segue a devolução.", template: "Segue a devolução." },
    asks: [],
    sentBy: "analista@barte.com",
    sentAt: "2026-11-07T12:40:00.000Z",
    reading: null,
    followUp: {
      drafted: true,
      sent: row.followUp.sent,
      draft: {
        subject: `Cobrança: nota de devolução da NF ${row.invoiceNumber}`,
        body: "Olá, não recebemos retorno. Pode nos responder até 20/11?",
        template: "Olá, não recebemos retorno. Pode nos responder até 20/11?",
        asks: [],
      },
      sentBy: row.followUp.sent ? "analista@barte.com" : null,
      sentAt: row.followUp.sent ? "2026-11-16T13:12:00.000Z" : null,
      failure: null,
    },
  };
}

describe("#18: /pedidos-fornecedor (wireframe aprovado, #5)", () => { // ADR-004
  // #21 A API falsa: o servidor decide o filtro e as contagens; a proposta da gaveta é 404 (a gaveta da nota mostra só o bloco desta tela).
  let requests: Fixture[] = SUPPLIER_REQUESTS;
  let failList = false;
  let failDetail = false;
  let calls: { method: string; path: string }[] = [];
  const counts = () => ({
    awaiting: requests.filter((r) => r.filter === "awaiting").length,
    answered: requests.filter((r) => r.filter === "answered").length,
    needs_you: requests.filter((r) => r.filter === "needs_you").length,
    overdue: requests.filter((r) => r.filter === "overdue").length,
  });
  const respond = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const path = String(input);
    calls.push({ method: init.method ?? "GET", path });
    if (path.startsWith("/api/propostas/")) return Response.json({ error: "not_found" }, { status: 404 });
    if (path.startsWith("/api/supplier-requests?status=")) {
      if (failList) throw new TypeError("network");
      const filter = path.slice("/api/supplier-requests?status=".length) as ReplyFilterDto;
      return Response.json({ filter, requests: requests.filter((r) => r.filter === filter).map((r) => r.row), counts: counts() });
    }
    if (path.startsWith("/api/supplier-requests/")) {
      const key = path.slice("/api/supplier-requests/".length).replace("/send", "");
      if (failDetail) return Response.json({ error: "internal_error", detail: "SQLSTATE 42P01 relation supplier_requests" }, { status: 500 });
      const found = requests.find((r) => r.row.invoiceAccessKey === key);
      if (!found) return Response.json({ error: "not_found" }, { status: 404 });
      const view = sentView(found.row);
      if (path.endsWith("/send")) {
        return Response.json({ request: { ...view, followUp: { ...view.followUp, sent: true, sentBy: "analista@barte.com", sentAt: "2026-11-16T13:12:00.000Z" } } });
      }
      return Response.json({ request: view });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };
  beforeEach(() => {
    requests = SUPPLIER_REQUESTS;
    failList = false;
    failDetail = false;
    calls = [];
    vi.stubGlobal("fetch", vi.fn(respond));
  });
  afterEach(() => vi.unstubAllGlobals());

  function renderRoute() {
    window.history.replaceState(null, "", "/pedidos-fornecedor"); // ADR-004
    return render(<Frame context={fallbackContext("analista@barte.com")} />);
  }

  it("#5/AC-5: o menu 'Contas a pagar' tem 'Pedidos ao fornecedor' depois dos itens existentes", () => {
    const group = NAVIGATION.find((g) => g.key === "pagar")!;
    const last = group.items[group.items.length - 1]!;
    expect(last.label).toBe("Pedidos ao fornecedor");
    expect(last.href).toBe("/pedidos-fornecedor"); // ADR-004
    expect(group.items.map((i) => i.label).slice(0, 4)).toEqual([
      "Fila de aprovação",
      "Lista do dia",
      "Notas duplicadas",
      "Pagamento errado evitado",
    ]);
  });

  it("#5/AC-1 #5/AC-2: a rota abre com o título, os chips com contagem e o chip Aguardando ativo", async () => {
    renderRoute();
    expect(await screen.findByRole("heading", { name: "Pedidos ao fornecedor" })).toBeTruthy();
    // #21 As contagens e a linha só vêm com a lista pronta: a espera é pela linha aguardando.
    expect(await screen.findByText("NF 51877")).toBeTruthy();
    // #5 Os chips são radios do filtro de situação (como em devolucoes.test.tsx), não texto solto.
    // #5 A célula de Status "Aguardando" da linha também casaria com getByText.
    const waitingChip = await screen.findByRole("radio", { name: /^Aguardando/ });
    for (const chip of [/^Atendidos/, /^Precisam de você/, /^Atrasados/]) {
      expect(screen.getByRole("radio", { name: chip })).toBeTruthy();
    }
    expect(screen.getByRole("radio", { name: /^Atrasados/ }).textContent).toMatch(/2/);
    // #5 Q3 (wireframe): o filtro inicial é Aguardando. Só a linha aguardando aparece.
    expect(waitingChip.getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText("NF 59738")).toBeNull();
    // #21 Só o filtro Aguardando foi pedido ao servidor, que também trouxe as contagens dos outros três.
    expect(calls.filter((c) => c.path.startsWith("/api/supplier-requests?")).map((c) => c.path)).toEqual(["/api/supplier-requests?status=awaiting"]);
  });

  it("#5/AC-1: cenário: filtrar 'Atrasados' mostra os dois com Nota, Fornecedor, Solicitação, Valor, Prazo e Status, por prazo crescente", async () => {
    renderRoute();
    fireEvent.click(await screen.findByRole("radio", { name: /^Atrasados/ }));
    // #21 O chip pede o filtro ao servidor: a grid some enquanto carrega e volta com as linhas do filtro.
    await screen.findByText("NF 40519");

    for (const header of ["Nota", "Fornecedor", "Solicitação", "Valor", "Prazo", "Status"]) {
      expect(screen.getByRole("columnheader", { name: header })).toBeTruthy();
    }
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    // #5 Prazo crescente: o mais atrasado primeiro.
    const first = within(rows[0]!);
    expect(first.getByText("NF 40519")).toBeTruthy();
    expect(first.getByText("F09 Embalagens")).toBeTruthy();
    expect(first.getByText("Nota de devolução")).toBeTruthy();
    expect(first.getByText(/R\$\s*1\.540,90/)).toBeTruthy();
    expect(first.getByText("12/11")).toBeTruthy();
    expect(first.getByText(/Atrasado/)).toBeTruthy();
    const second = within(rows[1]!);
    expect(second.getByText("NF 59738")).toBeTruthy();
    expect(second.getByText("F07 Limpeza")).toBeTruthy();
    expect(second.getByText(/R\$\s*263,62/)).toBeTruthy();
    expect(second.getByText("14/11")).toBeTruthy();
    expect(second.getByRole("button", { name: "Cobrar" })).toBeTruthy();
  });

  it("#5/AC-3: clicar na linha abre a gaveta no bloco 'Pedido ao fornecedor' com a conversa e a leitura do agente", async () => {
    renderRoute();
    fireEvent.click(await screen.findByRole("radio", { name: /^Atrasados/ }));
    const row = (await screen.findByText("NF 59738")).closest("tr")!;
    fireEvent.click(row);

    // #5 A gaveta do kit é achada pelo título, como em approval.test.tsx, não por role="dialog".
    expect(await screen.findByRole("heading", { name: /Proposta da NF/ })).toBeTruthy();
    // #21 Dentro da região desta tela: a gaveta da nota (#3) também escreve "Pedido ao fornecedor".
    const region = await screen.findByRole("region", { name: "Conversa e leitura do pedido" });
    expect(within(region).getAllByText("Pedido ao fornecedor")).toHaveLength(1);
    // #5 Estado 7 do wireframe: pedido enviado, resposta do fornecedor e leitura do agente.
    expect(screen.getByText(/Pedido enviado/)).toBeTruthy();
    expect(screen.getByText(/Resposta do fornecedor/)).toBeTruthy();
    expect(screen.getByText(/Leitura do agente/)).toBeTruthy();
  });

  it("#5/AC-4: cenário: 'Cobrar' abre a gaveta no bloco 'Pedido ao fornecedor' com o rascunho da cobrança, sem enviar", async () => {
    renderRoute();
    fireEvent.click(await screen.findByRole("radio", { name: /^Atrasados/ }));
    const row = (await screen.findByText("NF 59738")).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Cobrar" }));

    expect(await screen.findByRole("heading", { name: /Proposta da NF/ })).toBeTruthy();
    // #21 O pedido da gaveta vem do servidor, depois do título: o bloco e o rascunho esperam por ele.
    const region = await screen.findByRole("region", { name: "Conversa e leitura do pedido" });
    expect(within(region).getAllByText("Pedido ao fornecedor")).toHaveLength(1);
    expect(await screen.findByText("Rascunho da cobrança")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Enviar cobrança" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Descartar rascunho" })).toBeTruthy();
    // #5 A cobrança só sai no clique em enviar: nenhum POST até lá.
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("#5/AC-4: 'Enviar cobrança' faz um POST em .../send, sem texto, e a linha cobrada passa a Aguardando com as contagens acertadas", async () => {
    renderRoute();
    fireEvent.click(await screen.findByRole("radio", { name: /^Atrasados/ }));
    const row = (await screen.findByText("NF 59738")).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Cobrar" }));
    fireEvent.click(await screen.findByRole("button", { name: "Enviar cobrança" }));

    expect(await screen.findByText(/Cobrança enviada por você/)).toBeTruthy();
    const posts = calls.filter((call) => call.method === "POST");
    expect(posts).toEqual([{ method: "POST", path: `/api/supplier-requests/${keyOf(1)}/send` }]);
    expect(screen.getByRole("radio", { name: /^Atrasados/ }).textContent).toMatch(/1/);
    expect(screen.getByRole("radio", { name: /^Aguardando/ }).textContent).toMatch(/2/);
  });

  it("#5/AC-4: a linha que o servidor já cobrou (followUp.sent) segue em Atrasados como 'Atrasado (cobrado)', sem 'Cobrar', e a gaveta não oferece cobrar de novo", async () => {
    requests = [{ ...SUPPLIER_REQUESTS[0]!, row: { ...SUPPLIER_REQUESTS[0]!.row, followUp: { drafted: true, sent: true } } }];
    renderRoute();
    fireEvent.click(await screen.findByRole("radio", { name: /^Atrasados/ }));
    const row = (await screen.findByText("NF 59738")).closest("tr")!;
    expect(within(row).queryByRole("button", { name: "Cobrar" })).toBeNull();
    expect(within(row).getByText("Atrasado (cobrado)")).toBeTruthy();
    fireEvent.click(row);
    const region = await screen.findByRole("region", { name: "Conversa e leitura do pedido" });
    expect(within(region).queryByRole("button", { name: /Cobrar/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Enviar cobrança" })).toBeNull();
  });

  it("#21: a leitura da gaveta que falha mostra a mensagem fechada, nunca o corpo da resposta da API", async () => {
    failDetail = true;
    renderRoute();
    fireEvent.click(await screen.findByRole("radio", { name: /^Atrasados/ }));
    const row = (await screen.findByText("NF 59738")).closest("tr")!;
    fireEvent.click(row);

    expect(await screen.findByText("Não consegui carregar o pedido ao fornecedor.")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/SQLSTATE|supplier_requests|internal_error/);
  });

  // #18 Estados desenhados no wireframe: erro, vazio e chip com contagem 0.
  it("#18: estado de erro: a lista falha, mostra 'Tentar de novo' e, ao tentar, volta a carregar a lista", async () => {
    failList = true;
    renderRoute();
    expect(await screen.findByText("Não consegui carregar os pedidos ao fornecedor.")).toBeTruthy();
    failList = false;
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(await screen.findByText("NF 51877")).toBeTruthy();
  });

  it("#18: estado vazio: sem solicitações, diz o que fazer e oferece ir à Fila de aprovação", async () => {
    requests = [];
    renderRoute();
    expect(await screen.findByText("Nenhum pedido ao fornecedor ainda.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ir para a Fila de aprovação" })).toBeTruthy();
  });

  it("#5/AC-2: chip com contagem 0: 'Atrasados 0' mostra 'Nenhum pedido atrasado' e a ação 'Ver todos'", async () => {
    requests = SUPPLIER_REQUESTS.filter((r) => r.filter === "awaiting");
    renderRoute();
    const lateChip = await screen.findByRole("radio", { name: /^Atrasados/ });
    expect(lateChip.textContent).toMatch(/0/);
    fireEvent.click(lateChip);
    expect(await screen.findByText(/Nenhum pedido atrasado/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ver todos" })).toBeTruthy();
  });
});
