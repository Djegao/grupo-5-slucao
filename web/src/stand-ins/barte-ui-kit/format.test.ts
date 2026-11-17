import { describe, expect, it } from "vitest";
import { formatCurrency, formatIsoDate } from "./format";

describe("#53/AC-2 format, o substituto dos formatadores do ui-kit", () => {
  it("#53/AC-2: formatCurrency escreve reais em pt-BR", () => {
    expect(formatCurrency(1234.5).replace(/\s/g, " ")).toBe("R$ 1.234,50");
    expect(formatCurrency(0).replace(/\s/g, " ")).toBe("R$ 0,00");
  });

  it("#53/AC-2: formatIsoDate vira dia/mês/ano, com ou sem hora, sem passar por fuso", () => {
    expect(formatIsoDate("2026-11-10")).toBe("10/11/2026");
    expect(formatIsoDate("2026-11-10T23:59:59-03:00")).toBe("10/11/2026");
  });

  it("#53/AC-2: formatIsoDate devolve como veio o texto que não é data", () => {
    expect(formatIsoDate("")).toBe("");
    expect(formatIsoDate("ontem")).toBe("ontem");
    expect(formatIsoDate("10/11/2026")).toBe("10/11/2026");
  });
});
