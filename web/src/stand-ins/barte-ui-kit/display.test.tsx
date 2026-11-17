import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AiSourceBadge, Block, DataList, InlineEmpty, PageTitleBar, Panel, Stat, StatGrid, StatusBadge } from "./display";

describe("#53/AC-2 display, os blocos de leitura", () => {
  it("#53/AC-2: Panel mostra o título (h2), a descrição, o aside e o conteúdo", () => {
    render(
      <Panel title="Resumo" description="Do mês" aside={<span>selo</span>}>
        corpo
      </Panel>,
    );
    expect(screen.getByRole("heading", { level: 2, name: "Resumo" })).toBeTruthy();
    expect(screen.getByText("Do mês")).toBeTruthy();
    expect(screen.getByText("selo")).toBeTruthy();
    expect(screen.getByText("corpo")).toBeTruthy();
  });

  it("#53/AC-2: Panel sem título nem aside não desenha cabeçalho", () => {
    render(<Panel>corpo</Panel>);
    expect(screen.queryByRole("heading")).toBeNull();
    expect(document.querySelector(".bk-panel__head")).toBeNull();
  });

  it("#53/AC-2: Block usa o nível de título pedido", () => {
    render(<Block title="Parte" headingLevel={4} />);
    expect(screen.getByRole("heading", { level: 4, name: "Parte" })).toBeTruthy();
  });

  it("#53/AC-2: DataList é uma lista com nome e um par de rótulo e valor por item", () => {
    render(
      <DataList
        aria-label="Dados"
        items={[
          { key: "a", label: "Fornecedor", value: "Alfa", emphasis: true },
          { label: "Chave", value: "123", mono: true },
        ]}
      />,
    );
    const list = screen.getByRole("list", { name: "Dados" });
    const [first, second] = within(list).getAllByRole("listitem");
    expect(first?.textContent).toBe("FornecedorAlfa");
    expect(first?.querySelector(".bk-datalist__value--emphasis")).not.toBeNull();
    expect(second?.querySelector(".bk-datalist__value--mono")).not.toBeNull();
  });

  it("#53/AC-2: InlineEmpty mostra o texto", () => {
    render(<InlineEmpty>Nada aqui</InlineEmpty>);
    expect(screen.getByText("Nada aqui")).toBeTruthy();
  });

  it("#53/AC-2: StatusBadge leva as classes que a tela e os testes miram", () => {
    render(<StatusBadge tone="negative" variant="solid" size="pill">Barrada</StatusBadge>);
    const badge = screen.getByText("Barrada").parentElement as HTMLElement;
    expect(badge.className).toMatch(/StatusBadge-module__negative__bk/);
    expect(badge.className).toMatch(/StatusBadge-module__solid__bk/);
    expect(badge.className).toMatch(/StatusBadge-module__pill__bk/);
  });

  it("#53/AC-2: AiSourceBadge mostra o rótulo e esconde a marca do leitor de tela", () => {
    render(<AiSourceBadge source="ai" label="Agente" />);
    expect(screen.getByText("Agente")).toBeTruthy();
    expect(document.querySelector(".bk-source__mark")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("#53/AC-2: Stat mostra legenda, valor e contexto, e o botão de informação tem nome", () => {
    render(<Stat caption="Evitado" value="R$ 10" context="no mês" info="Explica" infoLabel="Sobre o evitado" />);
    expect(screen.getByText("R$ 10")).toBeTruthy();
    expect(screen.getByText("no mês")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sobre o evitado" }).getAttribute("title")).toBe("Explica");
  });

  it("#53/AC-2: Stat sem info não desenha o botão, e o nome padrão aparece quando falta infoLabel", () => {
    const { rerender } = render(<Stat caption="Evitado" value="1" />);
    expect(screen.queryByRole("button")).toBeNull();
    rerender(<Stat caption="Evitado" value="1" info="x" />);
    expect(screen.getByRole("button", { name: "Mais informação" })).toBeTruthy();
  });

  it("#53/AC-2: StatGrid guarda os números lado a lado", () => {
    render(
      <StatGrid columns={2}>
        <Stat caption="A" value="1" />
        <Stat caption="B" value="2" />
      </StatGrid>,
    );
    expect(document.querySelector<HTMLElement>(".bk-statgrid")?.style.getPropertyValue("--stat-columns")).toBe("2");
  });

  it("#53/AC-2: PageTitleBar tem o título (h1), o subtítulo e as ações", () => {
    render(<PageTitleBar title="Fila" subtitle="Notas" actions={<button type="button">Filtrar</button>} />);
    expect(screen.getByRole("heading", { level: 1, name: "Fila" })).toBeTruthy();
    expect(screen.getByText("Notas")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Filtrar" })).toBeTruthy();
  });
});
