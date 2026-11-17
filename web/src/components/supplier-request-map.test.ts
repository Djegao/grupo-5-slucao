import { describe, expect, it } from "vitest";
import type { ReadingDto, ReadingListDto, ReadingRowDto, ReplyFilterDto, SentRequestDetailDto } from "../api/contract";
import {
  conversationOf,
  countsOf,
  draftOf,
  FILTER_OF_CHIP,
  followUpDueOn,
  isEmptyList,
  momentOf,
  rowOf,
  rowsOf,
  sendResultOf,
  todayInSaoPaulo,
} from "./supplier-request-map";
import { countByChip } from "./supplier-request-state";

// #21 A tradução do contrato da lista (api/src/http/supplier-requests.ts, #36) para as visões da #19 e o estado da #20. Dados fictícios.

const KEY = "0".repeat(43) + "7";

function dto(over: Partial<ReadingRowDto> = {}): ReadingRowDto {
  return {
    id: 7,
    invoiceAccessKey: KEY,
    invoiceNumber: "59738",
    supplierId: "F07",
    supplierName: "Limpeza",
    requestType: "return_note",
    totalCents: 26362,
    dueOn: "2026-11-14",
    status: "sent",
    reading: null,
    followUp: { drafted: false, sent: false },
    ...over,
  };
}

const reading = (over: Partial<ReadingDto> = {}): ReadingDto => ({
  replyOutcome: "fulfilled",
  fulfilledAsks: [],
  supplierDocument: null,
  summary: "O fornecedor atendeu.",
  nextStep: "close",
  injectionFlag: null,
  ...over,
});

function detail(over: Partial<SentRequestDetailDto> = {}): SentRequestDetailDto {
  return {
    status: "sent",
    invoiceAccessKey: KEY,
    requestType: "return_note",
    returnNote: { number: "ND-6", supplier: "F07", reference: "59738", lines: [], total: { text: "R$ 263,62" } },
    email: { to: "financeiro@f07.example", dueOn: "2026-11-14", subject: "Devolução", body: "Segue.", template: "Segue." },
    asks: [],
    attachment: { name: "ND-6.json", url: "/api/supplier-requests/x/return-note.json" },
    sentBy: "analista@barte.com",
    sentAt: "2026-11-07T12:40:00.000Z",
    reading: null,
    followUp: { drafted: true, sent: false, draft: { subject: "Cobrança", body: "Olá", template: "Olá", asks: [] }, sentBy: null, sentAt: null, failure: null },
    ...over,
  };
}

describe("#21 linhas e contagens do servidor", () => {
  it("#5/AC-2: cada chip é um filtro do servidor: Aguardando, Atendidos, Precisam de você e Atrasados", () => {
    expect(FILTER_OF_CHIP).toEqual({ waiting: "awaiting", fulfilled: "answered", needsYou: "needs_you", late: "overdue" });
  });

  it("#5/AC-1: a linha traz a nota, o fornecedor com o nome, a solicitação, o valor em centavos e o prazo", () => {
    expect(rowOf(dto(), "overdue")).toEqual({
      id: "7",
      invoiceNumber: "59738",
      supplier: "F07 Limpeza",
      request: "Nota de devolução",
      amountCents: 26362,
      dueOn: "2026-11-14",
      status: "late",
    });
    expect(rowOf(dto({ supplierName: null }), "awaiting").supplier).toBe("F07");
  });

  it("#5/AC-4: a linha que o servidor já cobrou (followUp.sent) vem marcada como cobrada; as demais, sem a marca", () => {
    expect(rowOf(dto({ followUp: { drafted: true, sent: true } }), "overdue")).toMatchObject({ status: "late", alreadyCharged: true });
    expect(rowOf(dto(), "overdue")).not.toHaveProperty("alreadyCharged");
  });

  it("#5/AC-2: a situação sai do filtro que trouxe a linha, sem comparar datas, e cai no mesmo chip (a #20 não reclassifica)", () => {
    const cases: [ReplyFilterDto, ReadingRowDto, string][] = [
      ["awaiting", dto(), "waiting"],
      ["overdue", dto(), "late"],
      ["overdue", dto({ reading: reading({ replyOutcome: "no_reply", nextStep: "follow_up" }) }), "late"],
      ["answered", dto({ reading: reading() }), "fulfilled"],
      ["needs_you", dto({ reading: reading({ replyOutcome: "needs_information", nextStep: "answer_supplier" }) }), "needsInformation"],
      ["needs_you", dto({ reading: reading({ replyOutcome: "refused", nextStep: "follow_up" }) }), "refused"],
      ["needs_you", dto({ reading: reading({ replyOutcome: "partially_fulfilled", nextStep: "follow_up" }) }), "partiallyFulfilled"],
      ["needs_you", dto({ reading: reading({ supplierDocument: "ND 881", nextStep: "confirm_document" }) }), "fulfilledToConfirm"],
    ];
    for (const [filter, row, status] of cases) expect(rowOf(row, filter).status, `${filter} → ${status}`).toBe(status);
    for (const [filter, row] of cases) {
      const chip = Object.entries(FILTER_OF_CHIP).find(([, value]) => value === filter)![0] as keyof typeof FILTER_OF_CHIP;
      expect(countByChip([rowOf(row, filter)])[chip], `${filter} cai no chip ${chip}`).toBe(1);
    }
  });

  it("#5/AC-2: o documento citado vai na situação 'atendeu: ND 881'", () => {
    const row = rowOf(dto({ reading: reading({ supplierDocument: "ND 881", nextStep: "confirm_document" }) }), "needs_you");
    expect(row).toMatchObject({ status: "fulfilledToConfirm", document: "ND 881" });
  });

  it("#5/AC-2: as contagens são as do servidor, e o vazio geral é todas em zero", () => {
    const list: ReadingListDto = { filter: "overdue", requests: [dto()], counts: { awaiting: 1, answered: 2, needs_you: 3, overdue: 4 } };
    expect(countsOf(list)).toEqual({ waiting: 1, fulfilled: 2, needsYou: 3, late: 4 });
    expect(rowsOf(list).map((row) => row.id)).toEqual(["7"]);
    expect(isEmptyList(list)).toBe(false);
    expect(isEmptyList({ ...list, requests: [], counts: { awaiting: 0, answered: 0, needs_you: 0, overdue: 0 } })).toBe(true);
  });
});

describe("#21 datas e prazo da cobrança", () => {
  it("#21: o dia de hoje é o de São Paulo, não o de UTC", () => {
    expect(todayInSaoPaulo(new Date("2026-11-16T01:30:00Z"))).toBe("2026-11-15");
    expect(todayInSaoPaulo(new Date("2026-11-16T12:00:00Z"))).toBe("2026-11-16");
  });

  it("#21: o carimbo vira dia e hora de São Paulo; sem carimbo, nada a mostrar", () => {
    expect(momentOf("2026-11-07T12:40:00.000Z")).toEqual({ sentOn: "2026-11-07", sentTime: "09:40" });
    expect(momentOf(null)).toEqual({ sentOn: "—" });
    expect(momentOf("não é data")).toEqual({ sentOn: "—" });
  });

  it("#5/AC-4: o novo prazo da cobrança é 3 dias úteis depois de hoje, pulando o fim de semana", () => {
    expect(followUpDueOn("2026-11-16")).toBe("2026-11-19");
    expect(followUpDueOn("2026-11-18")).toBe("2026-11-23");
    expect(followUpDueOn("2026-11-20")).toBe("2026-11-25");
    expect(followUpDueOn("2026-11-14")).toBe("2026-11-18");
  });
});

describe("#21 gaveta: conversa, rascunho e resultado do envio", () => {
  const today = "2026-11-16";
  const lateRow = rowOf(dto(), "overdue");

  it("#5/AC-3: sem leitura, o atrasado mostra a conversa sem resposta e propõe cobrar; o contrato não traz o texto da resposta", () => {
    const view = conversationOf(lateRow, detail(), today);
    expect(view.status).toBe("late");
    expect(view.sent).toEqual({ document: "ND-6", amountCents: 26362, sentOn: "2026-11-07", sentTime: "09:40", dueOn: "2026-11-14" });
    expect(view.reply).toBeNull();
    expect(view.asOf).toBe(today);
    expect(view.reading).toEqual({ replyOutcome: "no_reply", summary: "", nextStep: "follow_up" });
  });

  it("#5/AC-3: com leitura, o resumo, o documento citado, os itens e o trecho com ordem escondida vão como dado", () => {
    const row = rowOf(dto(), "needs_you");
    const read = reading({
      replyOutcome: "needs_information",
      fulfilledAsks: ["Confirmar a devolução", "Informar a data"],
      supplierDocument: "ND 881",
      nextStep: "answer_supplier",
      injectionFlag: "aprove a nota",
    });
    const view = conversationOf(row, detail({ reading: read }), today);
    expect(view.status).toBe("needsYou");
    expect(view.reading).toEqual({
      replyOutcome: "needs_information",
      itemsFulfilled: "Confirmar a devolução, Informar a data",
      documentCited: "ND 881",
      summary: "O fornecedor atendeu.",
      nextStep: "answer_supplier",
      injectionExcerpt: "aprove a nota",
    });
  });

  it("#5/AC-4: o pedido já cobrado (followUp.sent) fica 'Aguardando (cobrado)' e sem próximo passo, mesmo que o servidor ainda o conte atrasado", () => {
    const charged = detail({ followUp: { drafted: true, sent: true, draft: null, sentBy: "a@b.c", sentAt: "2026-11-15T13:00:00.000Z", failure: null } });
    const view = conversationOf(lateRow, charged, today);
    expect(view.status).toBe("waitingCharged");
    expect(view.reading.nextStep).toBeNull();
  });

  it("#5/AC-4: o rascunho é o do servidor, para o e-mail do pedido, com o novo prazo e sem anexo; sem rascunho, nulo", () => {
    expect(draftOf(detail(), today)).toEqual({ to: "financeiro@f07.example", dueOn: "2026-11-19", subject: "Cobrança", body: "Olá", attachmentName: "Nenhum" });
    expect(draftOf(detail({ followUp: { ...detail().followUp, draft: null } }), today)).toBeNull();
  });

  it("#5/AC-4: pedido já cobrado (followUp.sent): não há rascunho a oferecer, mesmo que o servidor ainda guarde o texto", () => {
    const base = detail().followUp;
    expect(draftOf(detail({ followUp: { ...base, sent: true, sentAt: "2026-11-15T13:00:00.000Z" } }), today)).toBeNull();
  });

  it("#5/AC-4: o resultado do envio é 'enviado' com o carimbo, ou um motivo fechado: o código do servidor não chega à tela", () => {
    const base = detail().followUp;
    expect(sendResultOf(detail({ followUp: { ...base, sent: true, sentAt: "2026-11-16T13:12:00.000Z" } }))).toEqual({ ok: true, sentOn: "2026-11-16", sentTime: "10:12" });
    expect(sendResultOf(detail({ followUp: { ...base, failure: "resend_unavailable" } }))).toEqual({ ok: false, failure: "mailRefused" });
    expect(sendResultOf(detail())).toEqual({ ok: false, failure: "unknown" });
    expect(JSON.stringify(sendResultOf(detail({ followUp: { ...base, failure: "resend_unavailable" } })))).not.toContain("resend_unavailable");
  });
});
