import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReconciliationDiff, type ComparisonField } from "./ReconciliationDiff";

const FIELDS: ComparisonField[] = [
  { key: "valor", label: "Valor", a: "R$ 10,00", b: "R$ 12,00", state: "divergent", note: "Diferença de R$ 2,00" },
  { key: "data", label: "Data", a: "10/11/2026", b: "10/11/2026", state: "match" },
  { key: "cnpj", label: "CNPJ", a: "123", b: null, state: "missing" },
  { label: "Obs", a: "", b: "x" },
];

describe("#53/AC-2 ReconciliationDiff, o substituto da comparação campo a campo", () => {
  it("#53/AC-2: é uma tabela com nome, cabeçalhos dos dois lados e uma linha por campo", () => {
    render(<ReconciliationDiff columns={["Nota", "Pedido"]} fields={FIELDS} ariaLabel="Comparação" />);
    const table = screen.getByRole("table", { name: "Comparação" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Campo", "Nota", "Pedido", "Situação"]);
    expect(within(table).getAllByRole("row")).toHaveLength(FIELDS.length + 1);
    expect(within(table).getAllByRole("rowheader").map((h) => h.textContent)).toEqual(["Valor", "Data", "CNPJ", "Obs"]);
  });

  it("#53/AC-2: diz a situação por escrito e mostra a nota ao lado", () => {
    render(<ReconciliationDiff columns={["Nota", "Pedido"]} fields={FIELDS} />);
    expect(screen.getByText("divergente")).toBeTruthy();
    expect(screen.getByText("confere")).toBeTruthy();
    expect(screen.getByText("Diferença de R$ 2,00")).toBeTruthy();
  });

  it('#53/AC-2: valor nulo ou vazio aparece como "ausente"', () => {
    render(<ReconciliationDiff columns={["Nota", "Pedido"]} fields={FIELDS} />);
    const absent = document.querySelectorAll(".bk-diff__absent");
    expect([...absent].map((e) => e.textContent)).toEqual(["ausente", "ausente"]);
  });

  it("#53/AC-2: o resumo conta divergências e conferências, no singular e no plural", () => {
    const { rerender } = render(<ReconciliationDiff columns={["Nota", "Pedido"]} fields={FIELDS} showSummary />);
    expect(screen.getByText("1 campo diverge · 1 confere")).toBeTruthy();
    rerender(<ReconciliationDiff columns={["Nota", "Pedido"]} fields={[]} showSummary />);
    expect(screen.getByText("0 campos divergem · 0 conferem")).toBeTruthy();
  });

  it("#53/AC-2: sem showSummary, não há resumo", () => {
    render(<ReconciliationDiff columns={["Nota", "Pedido"]} fields={FIELDS} />);
    expect(document.querySelector(".bk-diff__summary")).toBeNull();
  });
});
