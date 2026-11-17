import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LineChart, ProgressBar, RankingBars, Timeline } from "./charts";

describe("#53/AC-2 charts, os gráficos sem biblioteca", () => {
  it("#53/AC-2: ProgressBar é uma barra de progresso com valor, limite e texto do valor", () => {
    render(
      <ProgressBar
        max={100}
        valueText="R$ 42 de R$ 100"
        showLegend
        segments={[
          { value: 30, tone: "positive", label: "Evitado" },
          { value: 12, tone: "waiting", label: "Em decisão" },
        ]}
      />,
    );
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("42");
    expect(bar.getAttribute("aria-valuemax")).toBe("100");
    expect(bar.getAttribute("aria-valuetext")).toBe("R$ 42 de R$ 100");
    expect(screen.getByText("Evitado")).toBeTruthy();
    expect(screen.getByText("Em decisão")).toBeTruthy();
  });

  it("#53/AC-2: ProgressBar não passa do limite nem divide por zero", () => {
    render(<ProgressBar max={0} segments={[{ value: 5, label: "A" }]} />);
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("0");
    expect((bar.firstElementChild as HTMLElement).style.width).toBe("0%");
  });

  it("#53/AC-2: LineChart é uma imagem com nome, os rótulos do eixo e a legenda das séries", () => {
    render(
      <LineChart
        ariaLabel="Evitado por dia"
        xKey="dia"
        series={[
          { key: "a", label: "Evitado" },
          { key: "b", label: "Previsto", dashed: true },
        ]}
        data={[
          { dia: "01", a: 1, b: 2 },
          { dia: "02", a: 3, b: 4 },
        ]}
      />,
    );
    const chart = screen.getByRole("img", { name: "Evitado por dia" });
    expect(within(chart as unknown as HTMLElement).getByText("01")).toBeTruthy();
    expect(chart.querySelectorAll("polyline")).toHaveLength(2);
    expect(screen.getByText("Evitado")).toBeTruthy();
    expect(screen.getByText("Previsto")).toBeTruthy();
  });

  it("#53/AC-2: LineChart com uma ponto só ou sem dados não quebra", () => {
    render(<LineChart ariaLabel="Vazio" xKey="dia" series={[{ key: "a", label: "A" }]} data={[{ dia: "01", a: 1 }]} />);
    expect(screen.getByRole("img", { name: "Vazio" })).toBeTruthy();
  });

  it("#53/AC-2: RankingBars lista do maior para o menor, com valor formatado e a meta", () => {
    render(
      <RankingBars
        formatValue={(v) => `R$ ${v}`}
        items={[
          { key: "b", label: "Beta", value: 5, meta: "2 notas" },
          { key: "a", label: "Alfa", value: 10 },
        ]}
      />,
    );
    const rows = screen.getAllByRole("listitem");
    expect(rows[0]?.textContent).toContain("Alfa");
    expect(rows[0]?.textContent).toContain("R$ 10");
    expect(rows[1]?.textContent).toContain("2 notas");
    expect((rows[1]?.querySelector(".bk-ranking__bar") as HTMLElement).style.width).toBe("50%");
  });

  it("#53/AC-2: Timeline é uma lista com nome, com hora, título e selo de cada passo", () => {
    render(
      <Timeline
        ariaLabel="Histórico"
        items={[
          { kind: "event", id: "1", title: "Proposta criada", time: "10:00", badge: <span>Regra</span>, byAgent: true },
          { kind: "event", id: "2", title: "Aprovada" },
        ]}
      />,
    );
    const list = screen.getByRole("list", { name: "Histórico" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getByText("10:00")).toBeTruthy();
    expect(within(list).getByText("Regra")).toBeTruthy();
    expect(list.querySelector(".bk-timeline__item--agent")?.textContent).toContain("Proposta criada");
  });
});
