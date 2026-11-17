import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SupplierRequests, type SupplierRequestsProps } from "./SupplierRequests";
import type { SendResult } from "./supplier-request-state";
import type { FollowUpDraftView, SupplierConversationView, SupplierRequestRow } from "./supplier-request-view";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("../router", () => ({ navigate }));

// #20 O estado que liga a lista, a gaveta e o rascunho da cobrança (história #5), com o usuário guiando os componentes de verdade.
// #20 Sem API: as linhas, a leitura e o `send` entram por props. Dados fictícios, só aqui.

const late: SupplierRequestRow = { id: "sr-1", invoiceNumber: "59738", supplier: "F07 Limpeza", request: "Nota de devolução", amountCents: 26362, dueOn: "2026-11-14", status: "late" };
const lateOlder: SupplierRequestRow = { ...late, id: "sr-2", invoiceNumber: "40519", supplier: "F09 Embalagens", amountCents: 154090, dueOn: "2026-11-12" };
const waiting: SupplierRequestRow = { ...late, id: "sr-3", invoiceNumber: "51877", supplier: "F02 Bebidas", amountCents: 98000, dueOn: "2026-11-20", status: "waiting" };
const refused: SupplierRequestRow = { ...late, id: "sr-4", invoiceNumber: "30011", supplier: "F03 Mercearia", dueOn: "2026-11-16", status: "refused" };
const ROWS = [late, lateOlder, waiting, refused];

function conversationOf(row: SupplierRequestRow): SupplierConversationView {
  return {
    status: row.status === "late" ? "late" : "waiting",
    sent: { document: "ND 6", amountCents: row.amountCents, sentOn: "2026-11-07", sentTime: "09:40", dueOn: row.dueOn },
    reply: null,
    asOf: "2026-11-15",
    reading: { replyOutcome: "no_reply", summary: `Sem resposta da nota ${row.invoiceNumber}.`, nextStep: "follow_up" },
  };
}

function draftOf(row: SupplierRequestRow): FollowUpDraftView {
  return {
    to: "financeiro@f07-limpeza.example",
    dueOn: "2026-11-20",
    subject: `Cobrança: nota de devolução da nota ${row.invoiceNumber}`,
    body: "Olá, não recebemos retorno. Pode nos responder até 20/11?",
    attachmentName: "pedido original (nota de devolução ND 6)",
  };
}

const SENT: SendResult = { ok: true, sentOn: "2026-11-15", sentTime: "10:12" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Send = SupplierRequestsProps["send"];

function renderScreen(props: Partial<SupplierRequestsProps> = {}) {
  // #20 O `send` sempre sai como mock, para os testes lerem `send.mock.calls` mesmo quando a tela recebeu o seu.
  const send = vi.fn<Send>(props.send ?? (async () => SENT));
  const onRetry = vi.fn();
  render(<SupplierRequests state="ready" rows={ROWS} onRetry={onRetry} conversationOf={conversationOf} draftOf={draftOf} {...props} send={send} />);
  return { send, onRetry };
}

const chip = (name: RegExp) => screen.getByRole("radio", { name });
const bodyRows = () => screen.getAllByRole("row").slice(1);

function chooseLate() {
  fireEvent.click(chip(/^Atrasados/));
}

/** #20 A linha da nota na grid: o número aparece como "NF 59738" na célula Nota. */
const rowOf = (invoice: string): HTMLElement => screen.getByText(`NF ${invoice}`).closest("tr")!;

function clickCobrar(invoice: string) {
  fireEvent.click(within(rowOf(invoice)).getByRole("button", { name: "Cobrar" }));
}

describe("#20 SupplierRequests: chips e linhas", () => {
  it("#5/AC-2: abre com o chip Aguardando ativo, as quatro contagens e só a linha aguardando (Q3)", () => {
    renderScreen();
    expect(chip(/^Aguardando/).getAttribute("aria-checked")).toBe("true");
    expect(chip(/^Aguardando/).textContent).toMatch(/1/);
    expect(chip(/^Atendidos/).textContent).toMatch(/0/);
    expect(chip(/^Precisam de você/).textContent).toMatch(/1/);
    expect(chip(/^Atrasados/).textContent).toMatch(/2/);
    expect(bodyRows()).toHaveLength(1);
    expect(screen.getByText("NF 51877")).toBeTruthy();
    expect(screen.queryByText("NF 59738")).toBeNull();
  });

  it("#5/AC-1: cenário: filtrar 'Atrasados' mostra os dois com os campos e por prazo crescente, o mais atrasado primeiro (Q8)", () => {
    renderScreen();
    chooseLate();
    expect(chip(/^Atrasados/).getAttribute("aria-checked")).toBe("true");
    const rows = bodyRows();
    expect(rows).toHaveLength(2);
    const first = within(rows[0]!);
    expect(first.getByText("NF 40519")).toBeTruthy();
    expect(first.getByText("F09 Embalagens")).toBeTruthy();
    expect(first.getByText("Nota de devolução")).toBeTruthy();
    expect(first.getByText(/R\$\s*1\.540,90/)).toBeTruthy();
    expect(first.getByText("12/11")).toBeTruthy();
    expect(first.getByText("Atrasado")).toBeTruthy();
    const second = within(rows[1]!);
    expect(second.getByText("NF 59738")).toBeTruthy();
    expect(second.getByText("14/11")).toBeTruthy();
    expect(second.getByRole("button", { name: "Cobrar" })).toBeTruthy();
  });

  it("#5/AC-2: um chip com 0 mostra o vazio dele e 'Ver todos' mostra todas as linhas por prazo", () => {
    renderScreen();
    fireEvent.click(chip(/^Atendidos/));
    expect(screen.getByText("Nenhum pedido atendido.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ver todos" }));
    expect(chip(/^Atendidos/).getAttribute("aria-checked")).toBe("false");
    const invoices = bodyRows().map((r) => ["40519", "59738", "30011", "51877"].find((n) => within(r).queryByText(`NF ${n}`) !== null));
    expect(invoices).toEqual(["40519", "59738", "30011", "51877"]);
  });

  it("#5/AC-2: o erro da carga chama o 'Tentar de novo' da tela", () => {
    const { onRetry } = renderScreen({ state: "error" });
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe("#20 SupplierRequests: gaveta", () => {
  it("#5/AC-3: clicar na linha abre a gaveta no bloco 'Pedido ao fornecedor' com a conversa e a leitura, sem rascunho", () => {
    renderScreen();
    chooseLate();
    fireEvent.click(rowOf("59738"));
    expect(screen.getByRole("heading", { name: /^Pedido ao fornecedor/ })).toBeTruthy();
    expect(screen.getByText("Pedido enviado")).toBeTruthy();
    expect(screen.getByText("Resposta do fornecedor")).toBeTruthy();
    expect(screen.getByText("Leitura do agente")).toBeTruthy();
    expect(screen.getByText(/Sem resposta da nota 59738/)).toBeTruthy();
    expect(screen.queryByText("Rascunho da cobrança")).toBeNull();
  });

  it("#5/AC-3: clicar em outra linha troca o pedido da gaveta", () => {
    renderScreen();
    chooseLate();
    fireEvent.click(rowOf("59738"));
    fireEvent.click(rowOf("40519"));
    expect(screen.getByText(/Sem resposta da nota 40519/)).toBeTruthy();
    expect(screen.queryByText(/Sem resposta da nota 59738/)).toBeNull();
  });

  it("#5/AC-4: 'Cobrar' na linha abre a gaveta no mesmo bloco com o rascunho para revisar, e não envia", () => {
    const { send } = renderScreen();
    chooseLate();
    clickCobrar("59738");
    expect(screen.getByRole("heading", { name: /^Pedido ao fornecedor/ })).toBeTruthy();
    expect(screen.getByText("Rascunho da cobrança")).toBeTruthy();
    expect(screen.getByText("Cobrança: nota de devolução da nota 59738")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Enviar cobrança" })).toBeTruthy();
    expect(screen.queryByText(/Cobrança enviada/)).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it("#5/AC-4: 'Cobrar' não passa pelo clique da linha: abre o rascunho e não só a conversa", () => {
    renderScreen();
    chooseLate();
    clickCobrar("40519");
    expect(screen.getByText("Cobrança: nota de devolução da nota 40519")).toBeTruthy();
  });

  it("#5/AC-4: o próximo passo 'Cobrar' do bloco abre o rascunho do pedido aberto", () => {
    renderScreen();
    chooseLate();
    fireEvent.click(rowOf("59738"));
    const block = screen.getByRole("region", { name: "Conversa e leitura do pedido" });
    fireEvent.click(within(block).getByRole("button", { name: "Cobrar" }));
    expect(screen.getByText("Rascunho da cobrança")).toBeTruthy();
  });

  it("#5/AC-3: os outros próximos passos vão para quem a tela recebeu, com o pedido e o passo", () => {
    const onNextStep = vi.fn();
    renderScreen({
      onNextStep,
      conversationOf: (row) => ({ ...conversationOf(row), reading: { replyOutcome: "refused", summary: "Recusou.", nextStep: "close" } }),
    });
    fireEvent.click(rowOf("51877"));
    fireEvent.click(screen.getByRole("button", { name: "Encerrar" }));
    expect(onNextStep).toHaveBeenCalledWith(waiting, "close");
  });
});

describe("#20 SupplierRequests: cobrar", () => {
  it("#5/AC-4: cenário: escolhe Atrasados, vê dois, cobra, edita o texto, envia e vê a cobrança enviada; a linha segue em Atrasados como 'Atrasado (cobrado)' (#5/AC-2)", async () => {
    const pending = deferred<SendResult>();
    const { send } = renderScreen({ send: vi.fn<Send>(() => pending.promise) });
    chooseLate();
    expect(bodyRows()).toHaveLength(2);
    clickCobrar("59738");

    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    fireEvent.change(screen.getByLabelText("Texto"), { target: { value: "Texto revisado pela analista." } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar cobrança" }));

    expect(screen.getByText("Enviando a cobrança…")).toBeTruthy();
    expect(send).toHaveBeenCalledTimes(1);
    const [sentRow, sentDraft] = send.mock.calls[0]!;
    expect(sentRow.id).toBe("sr-1");
    expect(sentDraft.body).toBe("Texto revisado pela analista.");
    expect(sentDraft.subject).toBe("Cobrança: nota de devolução da nota 59738");
    expect(sentDraft.to).toBe("financeiro@f07-limpeza.example");
    expect(sentDraft.dueOn).toBe("2026-11-20");

    pending.resolve(SENT);
    expect(await screen.findByText("Cobrança enviada por você em 15/11 às 10:12 · aguardando resposta até 20/11.")).toBeTruthy();
    // #5/AC-2 A linha cobrada vale como a que o servidor já cobrou: segue em Atrasados, com o prazo que veio, sem "Cobrar" (#21).
    expect(within(rowOf("59738")).getByText("Atrasado (cobrado)")).toBeTruthy();
    expect(within(rowOf("59738")).queryByRole("button", { name: "Cobrar" })).toBeNull();
    expect(within(rowOf("59738")).getByText("14/11")).toBeTruthy();
    expect(chip(/^Atrasados/).textContent).toMatch(/2/);
    expect(chip(/^Aguardando/).textContent).toMatch(/1/);
  });

  it("#5/AC-4: editar mexe só no texto: para, assunto, prazo e anexo não viram campo", () => {
    renderScreen();
    chooseLate();
    clickCobrar("59738");
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(screen.getByText("financeiro@f07-limpeza.example")).toBeTruthy();
    expect(screen.getByText("20/11")).toBeTruthy();
  });

  it("#5/AC-4: fechar a gaveta com o envio em curso e cobrar de novo na linha não abre outro rascunho nem envia outra vez", () => {
    const { send } = renderScreen({ send: vi.fn<Send>(() => deferred<SendResult>().promise) });
    chooseLate();
    clickCobrar("59738");
    fireEvent.click(screen.getByRole("button", { name: "Enviar cobrança" }));
    fireEvent.click(screen.getByRole("button", { name: /fechar|close/i }));
    clickCobrar("59738");
    expect(screen.queryByRole("button", { name: "Enviar cobrança" })).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("#5/AC-4: descartar fecha o rascunho, mantém a gaveta no bloco e a linha segue Atrasado", () => {
    const { send } = renderScreen();
    chooseLate();
    clickCobrar("59738");
    fireEvent.click(screen.getByRole("button", { name: "Descartar rascunho" }));
    expect(screen.queryByText("Rascunho da cobrança")).toBeNull();
    expect(screen.getByRole("heading", { name: /^Pedido ao fornecedor/ })).toBeTruthy();
    expect(chip(/^Atrasados/).textContent).toMatch(/2/);
    expect(send).not.toHaveBeenCalled();
  });

  it("#5/AC-4: envio falho mostra o motivo desenhado e 'Tentar enviar de novo'; a linha segue Atrasado e o rascunho não muda; tentar de novo envia", async () => {
    const send = vi
      .fn<Send>()
      .mockResolvedValueOnce({ ok: false, failure: "mailRefused" })
      .mockResolvedValueOnce(SENT);
    renderScreen({ send });
    chooseLate();
    clickCobrar("59738");
    fireEvent.click(screen.getByRole("button", { name: "Enviar cobrança" }));

    expect(await screen.findByText("A cobrança não saiu: o servidor de e-mail recusou o envio.")).toBeTruthy();
    expect(screen.getByText("O rascunho fica como está e nada é duplicado.")).toBeTruthy();
    expect(chip(/^Atrasados/).textContent).toMatch(/2/);

    fireEvent.click(screen.getByRole("button", { name: "Tentar enviar de novo" }));
    expect(await screen.findByText(/Cobrança enviada por você em 15\/11/)).toBeTruthy();
    expect(send).toHaveBeenCalledTimes(2);
    // #5/AC-2 A linha cobrada segue em Atrasados (#49): a contagem não muda com a cobrança.
    expect(chip(/^Atrasados/).textContent).toMatch(/2/);
  });

  it("#5/AC-4: um envio que rejeita mostra a mensagem genérica, nunca o texto do erro, e a linha segue Atrasado", async () => {
    const leak = "smtp.interno.example:587 recusou: credencial inválida";
    renderScreen({ send: vi.fn<Send>(() => Promise.reject(new Error(leak))) });
    chooseLate();
    clickCobrar("59738");
    fireEvent.click(screen.getByRole("button", { name: "Enviar cobrança" }));

    expect(await screen.findByText("A cobrança não saiu. Tente de novo em um minuto.")).toBeTruthy();
    expect(document.body.textContent).not.toContain(leak);
    expect(document.body.textContent).not.toContain("smtp");
    expect(chip(/^Atrasados/).textContent).toMatch(/2/);
  });

  it("#5/AC-4: reabrir a linha cobrada mostra o bloco como 'Atrasado (cobrado)' (#5/AC-2), sem novo rascunho", async () => {
    renderScreen();
    chooseLate();
    clickCobrar("59738");
    fireEvent.click(screen.getByRole("button", { name: "Enviar cobrança" }));
    await screen.findByText(/Cobrança enviada por você/);
    // #5/AC-4 Fecha a gaveta antes: `openRow` no id que já está aberto devolve o estado como está, e não reabriria nada.
    fireEvent.click(screen.getByRole("button", { name: /fechar|close/i }));
    expect(screen.queryByRole("region", { name: "Conversa e leitura do pedido" })).toBeNull();
    fireEvent.click(rowOf("59738"));
    const region = screen.getByRole("region", { name: "Conversa e leitura do pedido" });
    expect(within(region).getByText("Atrasado (cobrado)")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Enviar cobrança" })).toBeNull();
  });

  it("#5/AC-4: depois de cobrar, o bloco reaberto não tem 'Próximo passo:' nem 'Cobrar', e a linha também não", async () => {
    renderScreen();
    chooseLate();
    clickCobrar("59738");
    fireEvent.click(screen.getByRole("button", { name: "Enviar cobrança" }));
    await screen.findByText(/Cobrança enviada por você/);
    // #5/AC-4 Fecha antes de reabrir, como no teste de reabrir a linha cobrada (#20).
    fireEvent.click(screen.getByRole("button", { name: /fechar|close/i }));
    fireEvent.click(rowOf("59738"));

    const block = screen.getByRole("region", { name: "Conversa e leitura do pedido" });
    expect(within(block).queryByText(/Próximo passo:/)).toBeNull();
    expect(within(block).queryByRole("button", { name: "Cobrar" })).toBeNull();
    expect(within(rowOf("59738")).queryByRole("button", { name: "Cobrar" })).toBeNull();
  });
});

// #21 A tela ligada ao contrato: contagens e filtro do servidor, gaveta que espera o pedido, rascunho que pode faltar e texto que não se edita.
describe("#21 SupplierRequests: contagens e filtro do servidor, gaveta lida da API", () => {
  const SERVER_COUNTS = { waiting: 7, fulfilled: 3, needsYou: 5, late: 9 };

  it("#5/AC-2: com contagens do servidor, os chips mostram as dele e a tela não conta as linhas", () => {
    renderScreen({ counts: SERVER_COUNTS });
    expect(chip(/^Aguardando/).textContent).toMatch(/7/);
    expect(chip(/^Atendidos/).textContent).toMatch(/3/);
    expect(chip(/^Precisam de você/).textContent).toMatch(/5/);
    expect(chip(/^Atrasados/).textContent).toMatch(/9/);
  });

  it("#5/AC-2: trocar o chip, ou 'Ver todos', avisa a rota, que pede ao servidor as linhas do filtro", () => {
    const onFilterChange = vi.fn();
    renderScreen({ counts: SERVER_COUNTS, onFilterChange });
    chooseLate();
    expect(onFilterChange).toHaveBeenLastCalledWith("late");
    fireEvent.click(chip(/^Atendidos/));
    fireEvent.click(screen.getByRole("button", { name: "Ver todos" }));
    expect(onFilterChange).toHaveBeenLastCalledWith("all");
  });

  it("#5/AC-4: depois de cobrar, as contagens são as do servidor, sem acerto da sessão: Atrasados 9 e Aguardando 7 (#5/AC-2)", async () => {
    renderScreen({ counts: SERVER_COUNTS });
    chooseLate();
    clickCobrar("59738");
    fireEvent.click(await screen.findByRole("button", { name: "Enviar cobrança" }));
    await screen.findByText(/Cobrança enviada por você/);
    expect(chip(/^Atrasados/).textContent).toMatch(/9/);
    expect(chip(/^Aguardando/).textContent).toMatch(/7/);
  });

  it("#21: a gaveta avisa qual linha abriu e, ao fechar, nenhuma", () => {
    const onDrawerChange = vi.fn();
    renderScreen({ onDrawerChange });
    expect(onDrawerChange).toHaveBeenLastCalledWith(null);
    chooseLate();
    fireEvent.click(rowOf("59738"));
    expect(onDrawerChange).toHaveBeenLastCalledWith("sr-1");
    fireEvent.click(screen.getByRole("button", { name: /fechar|close/i }));
    expect(onDrawerChange).toHaveBeenLastCalledWith(null);
  });

  it("#21: enquanto o pedido da gaveta não chegou, a gaveta diz que carrega e não desenha a conversa", () => {
    renderScreen({ drawerState: "loading" });
    chooseLate();
    fireEvent.click(rowOf("59738"));
    expect(screen.getByText("Carregando o pedido ao fornecedor…")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Conversa e leitura do pedido" })).toBeNull();
  });

  it("#21: a leitura que falhou mostra só a mensagem fechada e 'Tentar de novo', que chama a rota", () => {
    const onDrawerRetry = vi.fn();
    renderScreen({ drawerState: "error", drawerError: "Não consegui falar com o servidor agora.", onDrawerRetry });
    chooseLate();
    fireEvent.click(rowOf("59738"));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Não consegui falar com o servidor agora.");
    fireEvent.click(within(alert).getByRole("button", { name: "Tentar de novo" }));
    expect(onDrawerRetry).toHaveBeenCalledTimes(1);
  });

  it("#21: sem rascunho (o servidor o traz nulo), 'Cobrar' diz que o rascunho não está disponível e nada se envia", () => {
    const { send } = renderScreen({ draftOf: () => null });
    chooseLate();
    clickCobrar("59738");
    expect(screen.getByText("O rascunho da cobrança não está disponível agora.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Enviar cobrança" })).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it("#21: com `editableDraft` falso, o rascunho não tem 'Editar': o texto que o servidor guarda é o que sai", () => {
    renderScreen({ editableDraft: false });
    chooseLate();
    clickCobrar("59738");
    expect(screen.getByRole("button", { name: "Enviar cobrança" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Editar" })).toBeNull();
  });
});

// #21 O que o servidor já cobrou fica no chip e na contagem dele; quem enviou e o 409 sem rascunho chegam à gaveta.
describe("#21 SupplierRequests: cobrança já feita pelo servidor, quem enviou e o 409", () => {
  const SERVER_COUNTS = { waiting: 7, fulfilled: 3, needsYou: 5, late: 9 };
  const lateCharged: SupplierRequestRow = { ...late, alreadyCharged: true };

  it("#5/AC-4: a linha atrasada que o servidor já cobrou segue em Atrasados como 'Atrasado (cobrado)', sem 'Cobrar', e as contagens são as do servidor", () => {
    renderScreen({ rows: [lateCharged, lateOlder, waiting], counts: SERVER_COUNTS });
    expect(chip(/^Atrasados/).textContent).toMatch(/9/);
    expect(chip(/^Aguardando/).textContent).toMatch(/7/);
    chooseLate();
    expect(within(rowOf("59738")).getByText("Atrasado (cobrado)")).toBeTruthy();
    expect(within(rowOf("59738")).queryByRole("button", { name: "Cobrar" })).toBeNull();
    expect(within(rowOf("40519")).getByRole("button", { name: "Cobrar" })).toBeTruthy();
    expect(chip(/^Atrasados/).textContent).toMatch(/9/);
  });

  it("#5/AC-4: a cobrança enviada por outra pessoa diz o nome dela na gaveta, e não 'por você'", async () => {
    renderScreen({ send: vi.fn<Send>(async () => ({ ...SENT, sentBy: "beto@example.test" })) });
    chooseLate();
    clickCobrar("59738");
    fireEvent.click(screen.getByRole("button", { name: "Enviar cobrança" }));
    expect(await screen.findByText(/Cobrança enviada por beto@example.test em 15\/11/)).toBeTruthy();
    // #5/AC-4 A cobrança não diz "por você". O único "por você" que sobra é o da nota de devolução do pedido (texts.supplierRequests.conversation.sent, #19), emitida por quem olha a tela.
    expect(screen.queryByText(/Cobrança enviada por você/)).toBeNull();
    expect(screen.getAllByText(/por você/).map((node) => node.textContent)).toEqual([expect.stringMatching(/^Nota de devolução ND 6 .* emitida e enviada por você em 07\/11/)]);
  });

  it("#5/AC-4: o 409 que não saiu e deixou a gaveta sem rascunho mostra a falha fechada, nunca o texto do servidor", async () => {
    let drafted = true;
    const send = vi.fn<Send>(async () => {
      drafted = false;
      return { ok: false, failure: "unknown" };
    });
    renderScreen({ send, draftOf: (row) => (drafted ? draftOf(row) : null) });
    chooseLate();
    clickCobrar("59738");
    fireEvent.click(screen.getByRole("button", { name: "Enviar cobrança" }));
    const message = await screen.findByText("A cobrança não saiu. Tente de novo em um minuto.");
    expect(message.closest('[role="alert"]')).not.toBeNull();
    expect(screen.getByText("O rascunho da cobrança não está disponível agora.")).toBeTruthy();
  });
});
