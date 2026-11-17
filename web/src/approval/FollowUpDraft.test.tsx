import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FollowUpDraftView } from "../components/supplier-request-view";
import { FollowUpDraft, type FollowUpPhaseState } from "./FollowUpDraft";

// #19 O rascunho da cobrança do bloco "Pedido ao fornecedor" (história #5), um teste por estado 8, 9 e 10 do wireframe (#18).
// #19 Sem axe em web/ (#25): a consulta por papel e nome acessível faz o papel da checagem de acessibilidade. Dados fictícios.

const draft: FollowUpDraftView = {
  to: "financeiro@f07-limpeza.example",
  dueOn: "2026-11-20",
  subject: "Cobrança: nota de devolução da nota 59738",
  body: "Olá, enviamos em 07/11 o pedido da nota de devolução de R$ 263,62 e não recebemos retorno até 14/11. Pode nos responder até 20/11?",
  attachmentName: "pedido original (nota de devolução ND 6)",
};

function renderDraft(state: FollowUpPhaseState = { phase: "review" }, editing = false) {
  const handlers = { onEdit: vi.fn(), onBodyChange: vi.fn(), onSend: vi.fn(), onDiscard: vi.fn(), onRetry: vi.fn() };
  render(<FollowUpDraft draft={draft} editing={editing} {...handlers} {...state} />);
  return handlers;
}

describe("#19 FollowUpDraft", () => {
  it("#5/AC-4: mostra o rascunho para revisar: para, novo prazo, assunto, texto e anexo, e diz que ainda não foi enviado", () => {
    renderDraft();
    expect(screen.getByRole("heading", { name: "Rascunho da cobrança" })).toBeTruthy();
    expect(screen.getByText("preparado pelo Claude, ainda não enviado")).toBeTruthy();
    expect(screen.getByText("financeiro@f07-limpeza.example")).toBeTruthy();
    expect(screen.getByText("20/11")).toBeTruthy();
    expect(screen.getByText("Cobrança: nota de devolução da nota 59738")).toBeTruthy();
    expect(screen.getByText(/Olá, enviamos em 07\/11/)).toBeTruthy();
    expect(screen.getByText("pedido original (nota de devolução ND 6)")).toBeTruthy();
  });

  it("#5/AC-4: 'Enviar cobrança' e 'Descartar rascunho' chamam o que a tela ligou, e nada sai antes do clique", () => {
    const { onSend, onDiscard } = renderDraft();
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Enviar cobrança" }));
    expect(onSend).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Descartar rascunho" }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it("#5/AC-4: 'Editar' libera só o texto; para, assunto, prazo e anexo seguem como texto", () => {
    const { onEdit } = renderDraft();
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it("#5/AC-4: editando, o texto vira um campo com o rótulo 'Texto' e cada mudança é avisada; o resto continua travado", () => {
    const { onBodyChange } = renderDraft({ phase: "review" }, true);
    const field = screen.getByRole("textbox", { name: "Texto" });
    expect((field as HTMLTextAreaElement).value).toBe(draft.body);
    fireEvent.change(field, { target: { value: "Pode responder até 20/11?" } });
    expect(onBodyChange).toHaveBeenCalledWith("Pode responder até 20/11?");
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
  });

  it("#18: enviando, os botões ficam desligados e a tela diz que está enviando", () => {
    renderDraft({ phase: "sending" });
    expect(screen.getByText("Enviando a cobrança…")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Enviar cobrança" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Descartar rascunho" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("#5/AC-4: enviada, mostra quem enviou e até quando se espera a resposta, sem o rascunho", () => {
    renderDraft({ phase: "sent", sentOn: "2026-11-15", sentTime: "10:12" });
    expect(screen.getByText("Cobrança enviada por você em 15/11 às 10:12 · aguardando resposta até 20/11.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Enviar cobrança" })).toBeNull();
    expect(screen.queryByText("Rascunho da cobrança")).toBeNull();
  });

  it("#5/AC-4: envio falho mantém o rascunho, avisa com o motivo desenhado e oferece 'Tentar enviar de novo' e 'Editar'", () => {
    const { onRetry, onEdit } = renderDraft({ phase: "failed", failure: "mailRefused" });
    expect(screen.getByRole("alert").textContent).toContain("A cobrança não saiu: o servidor de e-mail recusou o envio.");
    expect(screen.getByText("O rascunho fica como está e nada é duplicado.")).toBeTruthy();
    expect(screen.getByText(/Olá, enviamos em 07\/11/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Tentar enviar de novo" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it("#5/AC-4: envio falho por motivo desconhecido mostra só a mensagem genérica, nunca o texto de um erro de fora", () => {
    // #19 layer-exposure: a falha é um código fechado; o texto do servidor de e-mail ou da API não tem por onde chegar à tela.
    renderDraft({ phase: "failed", failure: "unknown" });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("A cobrança não saiu. Tente de novo em um minuto.");
    expect(alert.textContent).not.toMatch(/smtp|550|stack|undefined|\[object/i);
  });

  it("#21: sem `onEdit` o texto não se edita: o botão 'Editar' não existe, e enviar e descartar seguem", () => {
    const handlers = { onBodyChange: vi.fn(), onSend: vi.fn(), onDiscard: vi.fn(), onRetry: vi.fn() };
    render(<FollowUpDraft draft={draft} editing={false} {...handlers} phase="review" />);
    expect(screen.queryByRole("button", { name: "Editar" })).toBeNull();
    expect(screen.getByRole("button", { name: "Enviar cobrança" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Descartar rascunho" })).toBeTruthy();
  });
});
