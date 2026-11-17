import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SegmentedFilter } from "./SegmentedFilter";

const OPTIONS = [
  { value: "todas", label: "Todas", count: 66 },
  { value: "abertas", label: "Abertas", count: 4 },
  { value: "fechadas", label: "Fechadas" },
] as const;

function setup(value: "todas" | "abertas" | "fechadas" = "todas") {
  const onChange = vi.fn();
  render(<SegmentedFilter options={OPTIONS} value={value} onChange={onChange} ariaLabel="Situação" />);
  return onChange;
}

describe("#53/AC-2 SegmentedFilter, o substituto do filtro em pílulas", () => {
  it("#53/AC-2: é um grupo de rádio com o nome dado e a opção marcada", () => {
    setup("abertas");
    expect(screen.getByRole("radiogroup", { name: "Situação" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /Abertas/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: /Todas/ }).getAttribute("aria-checked")).toBe("false");
  });

  it('#53/AC-2: escreve "rótulo · contagem" quando há contagem, e só o rótulo quando não há', () => {
    setup();
    expect(screen.getByText("Todas · 66")).toBeTruthy();
    expect(screen.getByText("Abertas · 4")).toBeTruthy();
    expect(screen.getByText("Fechadas")).toBeTruthy();
  });

  it("#53/AC-2: só a opção marcada entra na ordem de tabulação", () => {
    setup("abertas");
    expect(screen.getByRole("radio", { name: /Abertas/ }).tabIndex).toBe(0);
    expect(screen.getByRole("radio", { name: /Todas/ }).tabIndex).toBe(-1);
  });

  it("#53/AC-2: o clique avisa o valor da opção", () => {
    const onChange = setup();
    fireEvent.click(screen.getByRole("radio", { name: /Fechadas/ }));
    expect(onChange).toHaveBeenCalledWith("fechadas");
  });

  it("#53/AC-2: as setas movem a escolha e o foco, e dão a volta nas pontas", () => {
    const onChange = setup("todas");
    const first = screen.getByRole("radio", { name: /Todas/ });
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("abertas");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: /Abertas/ }));
    fireEvent.keyDown(first, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("fechadas");
  });

  it("#53/AC-2: outra tecla não muda nada", () => {
    const onChange = setup();
    fireEvent.keyDown(screen.getByRole("radio", { name: /Todas/ }), { key: "a" });
    expect(onChange).not.toHaveBeenCalled();
  });
});
