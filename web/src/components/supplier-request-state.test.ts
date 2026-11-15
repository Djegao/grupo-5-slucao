import { describe, expect, it } from "vitest";
import {
  applyCharges,
  countByChip,
  INITIAL_STATE,
  screenReducer,
  visibleRows,
  type ScreenAction,
  type ScreenState,
} from "./supplier-request-state";
import type { SupplierRequestRow, SupplierRowStatus } from "./supplier-request-view";

// #20 O estado puro da lista "Pedidos ao fornecedor" (história #5): chips, contagens, ordem, gaveta e fluxo da cobrança. Dados fictícios.

function row(id: string, status: SupplierRowStatus, dueOn: string): SupplierRequestRow {
  const base = { id, invoiceNumber: id, supplier: "F07 Limpeza", request: "Nota de devolução", amountCents: 1000, dueOn };
  return status === "fulfilledToConfirm" ? { ...base, status, document: "ND 881" } : { ...base, status };
}

const ALL_STATUSES: SupplierRowStatus[] = ["waiting", "late", "fulfilledToConfirm", "fulfilled", "partiallyFulfilled", "needsInformation", "refused"];
const rows = ALL_STATUSES.map((status, index) => row(`r-${status}`, status, `2026-11-${String(20 - index).padStart(2, "0")}`));

function run(actions: ScreenAction[], from: ScreenState = INITIAL_STATE): ScreenState {
  return actions.reduce(screenReducer, from);
}

describe("#20 chips, contagens e linhas", () => {
  it("#5/AC-2: o estado começa no chip Aguardando, sem gaveta e sem cobrança feita (Q3)", () => {
    expect(INITIAL_STATE).toEqual({ filter: "waiting", drawer: null, charged: {} });
  });

  it("#5/AC-2: a contagem de cada chip segue o mapa de situação para chip (Q2): precisam de você junta confirmar, parcial, informação e recusa", () => {
    expect(countByChip(rows)).toEqual({ waiting: 1, late: 1, fulfilled: 1, needsYou: 4 });
  });

  it("#5/AC-2: cada solicitação cai em um só chip: a soma das contagens é o total", () => {
    const counts = countByChip(rows);
    expect(counts.waiting + counts.late + counts.fulfilled + counts.needsYou).toBe(rows.length);
  });

  it("#5/AC-2: sem linhas, as quatro contagens são zero", () => {
    expect(countByChip([])).toEqual({ waiting: 0, late: 0, fulfilled: 0, needsYou: 0 });
  });

  it("#5/AC-1: o chip filtra pelas situações dele e 'all' devolve todas, sempre por prazo crescente (Q8)", () => {
    expect(visibleRows(rows, "needsYou").map((r) => r.id)).toEqual(["r-refused", "r-needsInformation", "r-partiallyFulfilled", "r-fulfilledToConfirm"]);
    expect(visibleRows(rows, "all").map((r) => r.dueOn)).toEqual([...rows.map((r) => r.dueOn)].sort());
  });

  it("#5/AC-1: prazos iguais mantêm a ordem recebida, e a lista de entrada não é alterada", () => {
    const input = [row("b", "late", "2026-11-14"), row("a", "late", "2026-11-14"), row("c", "late", "2026-11-12")];
    expect(visibleRows(input, "late").map((r) => r.id)).toEqual(["c", "b", "a"]);
    expect(input.map((r) => r.id)).toEqual(["b", "a", "c"]);
  });

  it("#5/AC-2: escolher um chip e 'Ver todos' mudam só o filtro", () => {
    expect(run([{ type: "filter", filter: "late" }]).filter).toBe("late");
    expect(run([{ type: "filter", filter: "late" }, { type: "filter", filter: "all" }])).toEqual({ ...INITIAL_STATE, filter: "all" });
  });
});

describe("#20 gaveta", () => {
  it("#5/AC-3: clicar na linha abre a gaveta daquele pedido, no bloco do pedido, sem rascunho", () => {
    expect(run([{ type: "openRow", id: "r-late" }]).drawer).toEqual({ requestId: "r-late", block: "supplierRequest", followUp: null });
  });

  it("#5/AC-4: 'Cobrar' abre a gaveta no mesmo bloco com o rascunho para revisar, sem editar e sem enviar", () => {
    expect(run([{ type: "openFollowUp", id: "r-late" }]).drawer).toEqual({
      requestId: "r-late",
      block: "supplierRequest",
      followUp: { phase: { phase: "review" }, editing: false, body: null },
    });
  });

  it("#5/AC-3: clicar de novo na linha aberta mantém o rascunho; clicar em outra troca o pedido e o descarta", () => {
    const open = run([{ type: "openFollowUp", id: "r-late" }, { type: "edit" }, { type: "changeBody", body: "novo" }]);
    expect(run([{ type: "openRow", id: "r-late" }], open)).toEqual(open);
    expect(run([{ type: "openRow", id: "other" }], open).drawer).toEqual({ requestId: "other", block: "supplierRequest", followUp: null });
  });

  it("#5/AC-3: fechar a gaveta a deixa sem pedido", () => {
    expect(run([{ type: "openRow", id: "r-late" }, { type: "close" }]).drawer).toBeNull();
  });
});

describe("#20 fluxo da cobrança", () => {
  const review = run([{ type: "openFollowUp", id: "r-late" }]);

  it("#5/AC-4: editar libera só o texto: troca o corpo e deixa a fase e o resto como estão", () => {
    const edited = run([{ type: "edit" }, { type: "changeBody", body: "Texto novo" }], review);
    expect(edited.drawer?.followUp).toEqual({ phase: { phase: "review" }, editing: true, body: "Texto novo" });
    expect(edited.charged).toEqual({});
    expect(edited.filter).toBe("waiting");
  });

  it("#5/AC-4: o texto só muda depois de 'Editar'", () => {
    expect(run([{ type: "changeBody", body: "x" }], review)).toEqual(review);
  });

  it("#5/AC-4: enviar vai de revisar a enviando, e um segundo envio durante o envio não muda nada", () => {
    const sending = run([{ type: "sendStarted" }], review);
    expect(sending.drawer?.followUp?.phase).toEqual({ phase: "sending" });
    expect(run([{ type: "sendStarted" }], sending)).toEqual(sending);
  });

  it("#5/AC-4: enviando trava a edição e o descarte", () => {
    const sending = run([{ type: "edit" }, { type: "sendStarted" }], review);
    expect(run([{ type: "changeBody", body: "x" }, { type: "discard" }, { type: "edit" }], sending)).toEqual(sending);
  });

  it("#5/AC-4: envio feito vai a enviado e a linha muda de situação com o novo prazo (estado 9 do wireframe)", () => {
    const sent = run([{ type: "sendStarted" }, { type: "sendSucceeded", id: "r-late", dueOn: "2026-11-20", sentOn: "2026-11-15", sentTime: "10:12" }], review);
    expect(sent.drawer?.followUp?.phase).toEqual({ phase: "sent", sentOn: "2026-11-15", sentTime: "10:12" });
    expect(sent.charged).toEqual({ "r-late": { dueOn: "2026-11-20", sentOn: "2026-11-15", sentTime: "10:12" } });
  });

  it("#5/AC-4: envio feito sem horário não inventa um", () => {
    const sent = run([{ type: "sendStarted" }, { type: "sendSucceeded", id: "r-late", dueOn: "2026-11-20", sentOn: "2026-11-15" }], review);
    expect(sent.drawer?.followUp?.phase).toEqual({ phase: "sent", sentOn: "2026-11-15" });
  });

  it("#5/AC-4: se a gaveta já tinha sido fechada, o envio que termina ainda marca a cobrança e não abre nada", () => {
    const sent = run([{ type: "sendStarted" }, { type: "close" }, { type: "sendSucceeded", id: "r-late", dueOn: "2026-11-20", sentOn: "2026-11-15" }], review);
    expect(sent.drawer).toBeNull();
    expect(Object.keys(sent.charged)).toEqual(["r-late"]);
  });

  it("#5/AC-4: envio falho guarda o motivo, mantém o rascunho e a situação, e tentar de novo volta a enviando", () => {
    const failed = run([{ type: "edit" }, { type: "changeBody", body: "Texto" }, { type: "sendStarted" }, { type: "sendFailed", id: "r-late", failure: "mailRefused" }], review);
    expect(failed.drawer?.followUp).toEqual({ phase: { phase: "failed", failure: "mailRefused" }, editing: true, body: "Texto" });
    expect(failed.charged).toEqual({});
    expect(run([{ type: "sendStarted" }], failed).drawer?.followUp?.phase).toEqual({ phase: "sending" });
  });

  it("#5/AC-4: o resultado de um envio de outro pedido não mexe na fase do que está aberto", () => {
    const sending = run([{ type: "sendStarted" }], review);
    expect(run([{ type: "sendFailed", id: "other", failure: "unknown" }], sending)).toEqual(sending);
  });

  it("#5/AC-4: descartar fecha o rascunho e mantém a gaveta no bloco do pedido", () => {
    expect(run([{ type: "edit" }, { type: "discard" }], review).drawer).toEqual({ requestId: "r-late", block: "supplierRequest", followUp: null });
  });

  it("#5/AC-4: 'Cobrar' de novo com o envio em curso não reinicia o rascunho", () => {
    const sending = run([{ type: "sendStarted" }], review);
    expect(run([{ type: "openFollowUp", id: "r-late" }], sending)).toEqual(sending);
  });
});

describe("#20 a linha depois da cobrança", () => {
  it("#5/AC-4: um pedido já cobrado não abre o rascunho de novo na sessão", () => {
    const sent = run([{ type: "openFollowUp", id: "r-late" }, { type: "sendStarted" }, { type: "sendSucceeded", id: "r-late", dueOn: "2026-11-20", sentOn: "2026-11-15" }]);
    const closed = run([{ type: "close" }], sent);
    expect(run([{ type: "openFollowUp", id: "r-late" }], closed)).toEqual(closed);
  });

  it("#5/AC-2: a atrasada cobrada passa a Aguardando com o novo prazo e sai de Atrasados: 2 viram 1, Aguardando 1 vira 2 (Q7)", () => {
    const input = [row("a", "late", "2026-11-12"), row("b", "late", "2026-11-14"), row("c", "waiting", "2026-11-20")];
    const after = applyCharges(input, { a: { dueOn: "2026-11-20", sentOn: "2026-11-15" } });
    expect(after[0]).toEqual({ id: "a", invoiceNumber: "a", supplier: "F07 Limpeza", request: "Nota de devolução", amountCents: 1000, dueOn: "2026-11-20", status: "waiting" });
    expect(countByChip(after)).toEqual({ waiting: 2, late: 1, fulfilled: 0, needsYou: 0 });
    expect(after[1]).toBe(input[1]);
  });

  it("#5/AC-2: sem cobrança feita a lista volta como veio", () => {
    expect(applyCharges(rows, {})).toBe(rows);
  });
});
