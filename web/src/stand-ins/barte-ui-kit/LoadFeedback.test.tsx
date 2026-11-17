import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LoadFeedback } from "./LoadFeedback";

describe("#53/AC-2 LoadFeedback, o substituto do carregando, erro, vazio e pronto", () => {
  it("#53/AC-2: carregando é um status; em bloco, escreve o texto", () => {
    render(<LoadFeedback state="loading" size="inline" loadingLabel="Carregando notas" />);
    expect(screen.getAllByRole("status")[0]?.textContent).toContain("Carregando notas");
  });

  it("#53/AC-2: erro é um alerta com título, descrição e o 'tentar de novo' que chama onRetry", () => {
    const onRetry = vi.fn();
    render(<LoadFeedback state="error" errorTitle="Falhou" errorDescription="Tente de novo" retryLabel="Tentar de novo" onRetry={onRetry} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Falhou");
    expect(alert.textContent).toContain("Tente de novo");
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("#53/AC-2: erro sem onRetry não desenha o botão", () => {
    render(<LoadFeedback state="error" errorTitle="Falhou" retryLabel="Tentar de novo" />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("#53/AC-2: vazio mostra o texto de vazio", () => {
    render(<LoadFeedback state="empty" emptyLabel="Nada por aqui" />);
    expect(screen.getByText("Nada por aqui")).toBeTruthy();
  });

  it("#53/AC-2: pronto mostra os filhos; a função só roda então", () => {
    const children = vi.fn(() => <p>Conteúdo</p>);
    const { rerender } = render(<LoadFeedback state="loading">{children}</LoadFeedback>);
    expect(children).not.toHaveBeenCalled();
    rerender(<LoadFeedback state="ready">{children}</LoadFeedback>);
    expect(screen.getByText("Conteúdo")).toBeTruthy();
  });

  it("#53/AC-2: pronto com filhos que não são função também os mostra", () => {
    render(<LoadFeedback state="ready">pronto</LoadFeedback>);
    expect(screen.getByText("pronto")).toBeTruthy();
  });
});
