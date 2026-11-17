import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DecisionForm, type DecisionOption } from "./DecisionForm";

type Choice = "aprovar" | "devolver";

const OPTIONS: readonly DecisionOption<Choice>[] = [
  { value: "aprovar", label: "Aprovar", tone: "positive", submitLabel: "Aprovar nota" },
  { value: "devolver", label: "Devolver", tone: "negative", noteRequired: true },
];

const radio = (name: RegExp) => screen.getByRole("radio", { name });
const note = (): HTMLTextAreaElement => document.querySelector("textarea") as HTMLTextAreaElement;

describe("#53/AC-2 DecisionForm, o substituto do formulário de decisão", () => {
  it("#53/AC-2: sem defaultValue, nenhuma opção vem marcada e registrar pede uma escolha", () => {
    const onSubmit = vi.fn();
    render(<DecisionForm options={OPTIONS} onSubmit={onSubmit} />);
    expect(radio(/Aprovar/).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Registrar" }));
    expect(screen.getByRole("alert").textContent).toBe("Escolha uma opção.");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("#53/AC-2: não controlado, guarda a escolha, parte do defaultValue e avisa onValueChange", () => {
    const onValueChange = vi.fn();
    render(<DecisionForm options={OPTIONS} onSubmit={vi.fn()} defaultValue="aprovar" onValueChange={onValueChange} />);
    expect(radio(/Aprovar/).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(radio(/Devolver/));
    expect(radio(/Devolver/).getAttribute("aria-checked")).toBe("true");
    expect(onValueChange).toHaveBeenCalledWith("devolver");
  });

  it("#53/AC-2: controlado, a opção é a do value, e o clique só avisa", () => {
    const onValueChange = vi.fn();
    render(<DecisionForm options={OPTIONS} onSubmit={vi.fn()} value="aprovar" onValueChange={onValueChange} />);
    fireEvent.click(radio(/Devolver/));
    expect(onValueChange).toHaveBeenCalledWith("devolver");
    expect(radio(/Aprovar/).getAttribute("aria-checked")).toBe("true");
    expect(radio(/Devolver/).getAttribute("aria-checked")).toBe("false");
  });

  it("#53/AC-2: as setas trocam a opção", () => {
    const onValueChange = vi.fn();
    render(<DecisionForm options={OPTIONS} onSubmit={vi.fn()} defaultValue="aprovar" onValueChange={onValueChange} />);
    fireEvent.keyDown(radio(/Aprovar/), { key: "ArrowRight" });
    expect(onValueChange).toHaveBeenLastCalledWith("devolver");
    expect(document.activeElement).toBe(radio(/Devolver/));
  });

  it("#53/AC-2: o botão leva o submitLabel da opção marcada e submitDisabled o desabilita", () => {
    const { rerender } = render(<DecisionForm options={OPTIONS} onSubmit={vi.fn()} defaultValue="aprovar" />);
    expect((screen.getByRole("button", { name: "Aprovar nota" }) as HTMLButtonElement).disabled).toBe(false);
    rerender(<DecisionForm options={OPTIONS} onSubmit={vi.fn()} defaultValue="aprovar" submitDisabled />);
    expect((screen.getByRole("button", { name: "Aprovar nota" }) as HTMLButtonElement).disabled).toBe(true);
    expect(radio(/Devolver/).hasAttribute("disabled")).toBe(false);
  });

  it("#53/AC-2: os filhos ficam entre as opções e a observação", () => {
    render(
      <DecisionForm options={OPTIONS} onSubmit={vi.fn()} defaultValue="aprovar">
        <p data-testid="filho">Depende da opção</p>
      </DecisionForm>,
    );
    const filho = screen.getByTestId("filho");
    const group = screen.getByRole("radiogroup");
    expect(group.compareDocumentPosition(filho) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(filho.compareDocumentPosition(note()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("#53/AC-2: a mensagem de erro vem antes dos filhos, que vêm antes da observação", () => {
    render(
      <DecisionForm options={OPTIONS} onSubmit={vi.fn()} error="Falhou">
        <p data-testid="filho">Depende da opção</p>
      </DecisionForm>,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Falhou");
    expect(alert.compareDocumentPosition(screen.getByTestId("filho")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId("filho").compareDocumentPosition(note()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("#53/AC-2: a opção que pede justificativa recusa a observação vazia e aceita a escrita", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<DecisionForm options={OPTIONS} onSubmit={onSubmit} defaultValue="devolver" />);
    fireEvent.click(screen.getByRole("button", { name: "Registrar" }));
    expect(screen.getByRole("alert").textContent).toBe("Explique a decisão para registrá-la.");
    fireEvent.change(note(), { target: { value: "  valor errado  " } });
    fireEvent.click(screen.getByRole("button", { name: "Registrar" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ value: "devolver", note: "valor errado" }));
    expect((await screen.findByRole("status")).textContent).toBe("Decisão registrada.");
  });

  it("#53/AC-2: done nulo esconde o 'registrada'", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<DecisionForm options={OPTIONS} onSubmit={onSubmit} defaultValue="aprovar" texts={{ done: null }} />);
    fireEvent.click(screen.getByRole("button", { name: "Aprovar nota" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("#53/AC-2: se o envio falha, mostra a mensagem do erro, ou a padrão quando ele não tem", async () => {
    const onSubmit = vi.fn().mockRejectedValueOnce(new Error("Sem rede")).mockRejectedValueOnce("coisa");
    render(<DecisionForm options={OPTIONS} onSubmit={onSubmit} defaultValue="aprovar" />);
    fireEvent.click(screen.getByRole("button", { name: "Aprovar nota" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Sem rede");
    fireEvent.click(screen.getByRole("button", { name: "Aprovar nota" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Não foi possível registrar a decisão. Tente de novo."));
  });

  it("#53/AC-2: enquanto disabled, as opções ficam travadas", () => {
    render(<DecisionForm options={OPTIONS} onSubmit={vi.fn()} disabled />);
    expect(radio(/Aprovar/).hasAttribute("disabled")).toBe(true);
  });
});
