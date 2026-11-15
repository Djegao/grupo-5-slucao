import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Frame } from "../src/App";
import { fallbackContext, NAVIGATION } from "../src/shell/context";

/**
 * #18 Esqueleto de ponta a ponta da lista "Pedidos ao fornecedor" (história #5), escrito contra o
 * wireframe aprovado em artifacts/wireframe-pedidos-fornecedor/index.html.
 *
 * Ele está VERMELHO DE PROPÓSITO: nada implementa a tela ainda. Para o `make check` e o CI seguirem
 * verdes, cada comportamento está em `it.fails`, que passa enquanto a asserção falha. A camada de
 * contrato (#21) troca `it.fails` por `it`, ao ligar a rota, a lista e a gaveta, e o esqueleto fica
 * verde. Se uma asserção passar antes disso, o `it.fails` quebra e avisa que ele testava um
 * substituto, não o comportamento.
 *
 * O formato da API vem da #157 e da camada de contrato (#21), não daqui: a única costura de dados é
 * `SOLICITACOES`, abaixo, e o ponto de fetch que a devolve. A contrato ajusta os dois.
 */

type Solicitacao = {
  nota: string;
  fornecedor: string;
  solicitacao: string;
  valor: string;
  prazo: string;
  status: "Aguardando" | "Atrasado";
};

/** O cenário: dois pedidos atrasados (e um aguardando, para o filtro inicial). Dados fictícios. */
const SOLICITACOES: Solicitacao[] = [
  { nota: "59738", fornecedor: "F07 Limpeza", solicitacao: "Nota de devolução", valor: "R$ 263,62", prazo: "14/11", status: "Atrasado" },
  { nota: "40519", fornecedor: "F09 Embalagens", solicitacao: "Nota de devolução", valor: "R$ 1.540,90", prazo: "12/11", status: "Atrasado" },
  { nota: "51877", fornecedor: "F02 Bebidas", solicitacao: "Nota de devolução", valor: "R$ 980,00", prazo: "20/11", status: "Aguardando" },
];

describe("#18 /pedidos-fornecedor (wireframe aprovado, #5)", () => {
  // Costura de dados: qualquer GET de /api devolve a fixture; a proposta da gaveta é 404 como nos
  // outros testes de rota. A camada de contrato troca isto pelo formato real.
  const respond = async (input: RequestInfo | URL): Promise<Response> => {
    const path = String(input);
    if (path.startsWith("/api/propostas/")) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json({ items: SOLICITACOES });
  };
  beforeEach(() => vi.stubGlobal("fetch", vi.fn(respond)));
  afterEach(() => vi.unstubAllGlobals());

  function renderRoute() {
    window.history.replaceState(null, "", "/pedidos-fornecedor");
    return render(<Frame context={fallbackContext("analista@barte.com")} />);
  }

  it.fails("AC-5 o menu 'Contas a pagar' tem 'Pedidos ao fornecedor' depois dos itens existentes", () => {
    const group = NAVIGATION.find((g) => g.key === "pagar")!;
    const last = group.items[group.items.length - 1]!;
    expect(last.label).toBe("Pedidos ao fornecedor");
    expect(last.href).toBe("/pedidos-fornecedor");
    expect(group.items.map((i) => i.label).slice(0, 4)).toEqual([
      "Fila de aprovação",
      "Lista do dia",
      "Notas duplicadas",
      "Pagamento errado evitado",
    ]);
  });

  it.fails("AC-1 a rota abre com o título, os chips com contagem e o chip Aguardando ativo", async () => {
    renderRoute();
    expect(await screen.findByRole("heading", { name: "Pedidos ao fornecedor" })).toBeTruthy();
    for (const chip of [/^Aguardando/, /^Atendidos/, /^Precisam de você/, /^Atrasados/]) {
      expect(screen.getByText(chip)).toBeTruthy();
    }
    expect(screen.getByText(/^Atrasados/).textContent).toMatch(/2/);
    // Filtro inicial: Aguardando. Só a linha aguardando aparece.
    expect(screen.getByText("51877")).toBeTruthy();
    expect(screen.queryByText("59738")).toBeNull();
  });

  it.fails("cenário: filtrar 'Atrasados' mostra os dois com Nota, Fornecedor, Solicitação, Valor, Prazo e Status, por prazo crescente", async () => {
    renderRoute();
    fireEvent.click(await screen.findByText(/^Atrasados/));

    for (const header of ["Nota", "Fornecedor", "Solicitação", "Valor", "Prazo", "Status"]) {
      expect(screen.getByRole("columnheader", { name: header })).toBeTruthy();
    }
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    // Prazo crescente: o mais atrasado primeiro.
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

  it.fails("cenário: 'Cobrar' abre a gaveta no bloco 'Pedido ao fornecedor' com o rascunho da cobrança, sem enviar", async () => {
    renderRoute();
    fireEvent.click(await screen.findByText(/^Atrasados/));
    const row = (await screen.findByText("59738")).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Cobrar" }));

    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByText("Pedido ao fornecedor")).toBeTruthy();
    expect(within(drawer).getByText("Rascunho da cobrança")).toBeTruthy();
    expect(within(drawer).getByRole("button", { name: "Enviar cobrança" })).toBeTruthy();
    expect(within(drawer).getByRole("button", { name: "Descartar rascunho" })).toBeTruthy();
    // A cobrança só sai no clique em enviar: nenhum POST até lá.
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls as [unknown, RequestInit?][];
    expect(calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });
});
