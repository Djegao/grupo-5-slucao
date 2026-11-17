import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Frame } from "../src/App";
import { fallbackContext, NAVIGATION } from "../src/shell/context";

/**
 * #18 Esqueleto de ponta a ponta da lista "Pedidos ao fornecedor" (história #5), escrito contra o
 * wireframe aprovado em artifacts/wireframe-pedidos-fornecedor/index.html.
 *
 * Em skip (#18, #21): as dependências do web não instalam (#25), então os `it.fails` não se verificam, e um
 * teste que falha por defeito de ambiente ainda ficaria verde. A #21 (camada de contrato) tira o skip e troca `it.fails` por `it` (#18, #21).
 *
 * Ele está VERMELHO DE PROPÓSITO: nada implementa a tela ainda. Para o `make check` e o CI seguirem
 * verdes, cada comportamento está em `it.fails`, que passa enquanto o teste inteiro falha, por
 * qualquer motivo, inclusive um erro de consulta lançado. A camada de contrato (#21) troca `it.fails`
 * por `it`, ao ligar a rota, a lista e a gaveta, e o esqueleto fica verde. O `it.fails` só quebra
 * quando o teste inteiro passa, e então avisa que ele testava um substituto, não o comportamento.
 *
 * O formato da API vem da #157 e da camada de contrato (#21), não daqui: a única costura de dados é
 * `SUPPLIER_REQUESTS`, abaixo, e o ponto de fetch que a devolve. A contrato ajusta os dois.
 */

type SupplierRequest = {
  invoice: string;
  supplier: string;
  request: string;
  amount: string;
  dueDate: string;
  status: "Aguardando" | "Atrasado";
};

/** #5 O cenário "cobrar um atrasado": dois pedidos atrasados e um aguardando (filtro inicial). Dados fictícios. */
const SUPPLIER_REQUESTS: SupplierRequest[] = [
  { invoice: "59738", supplier: "F07 Limpeza", request: "Nota de devolução", amount: "R$ 263,62", dueDate: "14/11", status: "Atrasado" },
  { invoice: "40519", supplier: "F09 Embalagens", request: "Nota de devolução", amount: "R$ 1.540,90", dueDate: "12/11", status: "Atrasado" },
  { invoice: "51877", supplier: "F02 Bebidas", request: "Nota de devolução", amount: "R$ 980,00", dueDate: "20/11", status: "Aguardando" },
];

describe.skip("#18: /pedidos-fornecedor (wireframe aprovado, #5) … até #21", () => {
  // #21 Costura de dados: o GET devolve `items`, a proposta da gaveta é 404, e o contrato troca pelo real.
  let items: SupplierRequest[] = SUPPLIER_REQUESTS;
  let failList = false;
  const respond = async (input: RequestInfo | URL): Promise<Response> => {
    const path = String(input);
    if (path.startsWith("/api/propostas/")) return Response.json({ error: "not_found" }, { status: 404 });
    if (failList) throw new TypeError("network");
    return Response.json({ items });
  };
  beforeEach(() => {
    items = SUPPLIER_REQUESTS;
    failList = false;
    vi.stubGlobal("fetch", vi.fn(respond));
  });
  afterEach(() => vi.unstubAllGlobals());

  function renderRoute() {
    window.history.replaceState(null, "", "/pedidos-fornecedor"); // ADR-004
    return render(<Frame context={fallbackContext("analista@barte.com")} />);
  }

  it.fails("#5/AC-5: o menu 'Contas a pagar' tem 'Pedidos ao fornecedor' depois dos itens existentes", () => {
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

  it.fails("#5/AC-1 #5/AC-2: a rota abre com o título, os chips com contagem e o chip Aguardando ativo", async () => {
    renderRoute();
    expect(await screen.findByRole("heading", { name: "Pedidos ao fornecedor" })).toBeTruthy();
    // #5 Os chips são radios do filtro de situação (como em devolucoes.test.tsx), não texto solto.
    // #5 A célula de Status "Aguardando" da linha também casaria com getByText.
    const waitingChip = await screen.findByRole("radio", { name: /^Aguardando/ });
    for (const chip of [/^Atendidos/, /^Precisam de você/, /^Atrasados/]) {
      expect(screen.getByRole("radio", { name: chip })).toBeTruthy();
    }
    expect(screen.getByRole("radio", { name: /^Atrasados/ }).textContent).toMatch(/2/);
    // #5 Q3 (wireframe): o filtro inicial é Aguardando. Só a linha aguardando aparece.
    expect(waitingChip.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("51877")).toBeTruthy();
    expect(screen.queryByText("59738")).toBeNull();
  });

  it.fails("#5/AC-1: cenário: filtrar 'Atrasados' mostra os dois com Nota, Fornecedor, Solicitação, Valor, Prazo e Status, por prazo crescente", async () => {
    renderRoute();
    fireEvent.click(await screen.findByRole("radio", { name: /^Atrasados/ }));

    for (const header of ["Nota", "Fornecedor", "Solicitação", "Valor", "Prazo", "Status"]) {
      expect(screen.getByRole("columnheader", { name: header })).toBeTruthy();
    }
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    // #5 Prazo crescente: o mais atrasado primeiro.
    const first = within(rows[0]!);
    expect(first.getByText("40519")).toBeTruthy();
    expect(first.getByText("F09 Embalagens")).toBeTruthy();
    expect(first.getByText("Nota de devolução")).toBeTruthy();
    expect(first.getByText(/R\$\s*1\.540,90/)).toBeTruthy();
    expect(first.getByText("12/11")).toBeTruthy();
    expect(first.getByText(/Atrasado/)).toBeTruthy();
    const second = within(rows[1]!);
    expect(second.getByText("59738")).toBeTruthy();
    expect(second.getByText("F07 Limpeza")).toBeTruthy();
    expect(second.getByText(/R\$\s*263,62/)).toBeTruthy();
    expect(second.getByText("14/11")).toBeTruthy();
    expect(second.getByRole("button", { name: "Cobrar" })).toBeTruthy();
  });

  it.fails("#5/AC-3: clicar na linha abre a gaveta no bloco 'Pedido ao fornecedor' com a conversa e a leitura do agente", async () => {
    renderRoute();
    fireEvent.click(await screen.findByRole("radio", { name: /^Atrasados/ }));
    const row = (await screen.findByText("59738")).closest("tr")!;
    fireEvent.click(row);

    // #5 A gaveta do kit é achada pelo título, como em approval.test.tsx, não por role="dialog".
    expect(await screen.findByRole("heading", { name: /Proposta da nota/ })).toBeTruthy();
    expect(await screen.findByText("Pedido ao fornecedor")).toBeTruthy();
    // #5 Estado 7 do wireframe: pedido enviado, resposta do fornecedor e leitura do agente.
    expect(screen.getByText(/Pedido enviado/)).toBeTruthy();
    expect(screen.getByText(/Resposta do fornecedor/)).toBeTruthy();
    expect(screen.getByText(/Leitura do agente/)).toBeTruthy();
  });

  it.fails("#5/AC-4: cenário: 'Cobrar' abre a gaveta no bloco 'Pedido ao fornecedor' com o rascunho da cobrança, sem enviar", async () => {
    renderRoute();
    fireEvent.click(await screen.findByRole("radio", { name: /^Atrasados/ }));
    const row = (await screen.findByText("59738")).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Cobrar" }));

    expect(await screen.findByRole("heading", { name: /Proposta da nota/ })).toBeTruthy();
    expect(screen.getByText("Pedido ao fornecedor")).toBeTruthy();
    expect(screen.getByText("Rascunho da cobrança")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Enviar cobrança" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Descartar rascunho" })).toBeTruthy();
    // #5 A cobrança só sai no clique em enviar: nenhum POST até lá.
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls as [unknown, RequestInit?][];
    expect(calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  // #18 Estados desenhados no wireframe: erro, vazio e chip com contagem 0.
  it.fails("#18: estado de erro: a lista falha, mostra 'Tentar de novo' e, ao tentar, volta a carregar a lista", async () => {
    failList = true;
    renderRoute();
    expect(await screen.findByText("Não consegui carregar os pedidos ao fornecedor.")).toBeTruthy();
    failList = false;
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(await screen.findByText("51877")).toBeTruthy();
  });

  it.fails("#18: estado vazio: sem solicitações, diz o que fazer e oferece ir à Fila de aprovação", async () => {
    items = [];
    renderRoute();
    expect(await screen.findByText("Nenhum pedido ao fornecedor ainda.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ir para a Fila de aprovação" })).toBeTruthy();
  });

  it.fails("#5/AC-2: chip com contagem 0: 'Atrasados 0' mostra 'Nenhum pedido atrasado' e a ação 'Ver todos'", async () => {
    items = SUPPLIER_REQUESTS.filter((r) => r.status === "Aguardando");
    renderRoute();
    const lateChip = await screen.findByRole("radio", { name: /^Atrasados/ });
    expect(lateChip.textContent).toMatch(/0/);
    fireEvent.click(lateChip);
    expect(await screen.findByText(/Nenhum pedido atrasado/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ver todos" })).toBeTruthy();
  });
});
