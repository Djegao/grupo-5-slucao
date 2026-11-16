import { parseIsoDate } from './calendar.js';
import { textChecks, type FactCatalog } from './dossier.js';
import type { RequestStatus } from './supplier-request.js';

// #33: a leitura da resposta do fornecedor (#4). O Claude lê a resposta e devolve um objeto; a regra
// #33: confere esse objeto, corrige o próximo passo e diz em que filtro da lista cada pedido cai.
// #33: nada aqui lê relógio nem banco: as datas chegam como AAAA-MM-DD.

export type ReplyOutcome = 'fulfilled' | 'partially_fulfilled' | 'refused' | 'needs_information' | 'no_reply'; // #4/AC-1
export type NextStep = 'close' | 'confirm_document' | 'answer_supplier' | 'follow_up'; // #4/AC-1

const OUTCOMES: readonly ReplyOutcome[] = ['fulfilled', 'partially_fulfilled', 'refused', 'needs_information', 'no_reply'];
const NEXT_STEPS: readonly NextStep[] = ['close', 'confirm_document', 'answer_supplier', 'follow_up'];

/**
 * #4/AC-6: a leitura carrega só dados da leitura. Não há campo de decisão, de título nem de valor em
 * risco: uma ordem escondida na resposta só chega a `injectionFlag`, e o que o modelo devolver além
 * destes campos é descartado na validação.
 */
export type SupplierReading = {
  readonly replyOutcome: ReplyOutcome;
  readonly fulfilledAsks: readonly string[];
  readonly supplierDocument: string | null;
  readonly summary: string;
  readonly nextStep: NextStep;
  readonly injectionFlag: string | null;
};

/** #33: o campo do objeto cru do modelo, com o nome que ele usa (snake_case). */
export type ReadingField = 'reply_outcome' | 'fulfilled_asks' | 'supplier_document' | 'summary' | 'next_step' | 'injection_flag';

export type ReadingRejection = {
  readonly ok: false;
  readonly reason: 'invalid_shape' | 'unknown_ask' | 'number_mismatch' | 'no_reply_for_reply' | 'injection_not_in_reply' | 'document_not_in_reply';
  readonly field: ReadingField;
};

export type ReadingValidation = { readonly ok: true; readonly reading: SupplierReading } | ReadingRejection;

/** #33: contra o que a leitura é conferida: o que pedimos, o texto da resposta e o catálogo de fatos do pedido. */
export type ReadingContext = {
  /** #33: os itens do que pedimos, como o modelo os viu; `fulfilled_asks` só traz itens desta lista. */
  readonly asks: readonly string[];
  readonly replyText: string;
  readonly catalog: FactCatalog;
};

const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isOutcome = (v: unknown): v is ReplyOutcome => OUTCOMES.some((o) => o === v);
const isNextStep = (v: unknown): v is NextStep => NEXT_STEPS.some((n) => n === v);
const isTexts = (v: unknown): v is string[] => Array.isArray(v) && v.every(isText);

const rejection = (reason: ReadingRejection['reason'], field: ReadingField): ReadingRejection =>
  Object.freeze({ ok: false, reason, field });

const MARKER = /\{\{[^}]*\}\}/; // #33: marcador {{chave}}, que o summary não tem

const bareToken = (token: string): string => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

const tokensOf = (text: string): string[] => text.split(/[\s/]+/).map(bareToken).filter((t) => t !== '');

const MAX_DOCUMENT_TOKENS = 2; // #33: "NF-D 881" tem dois tokens; mais que isso já é frase

/** #33: o documento está na resposta por palavras inteiras: a sequência dele de tokens aparece seguida na da resposta. */
function documentInReply(document: string, replyText: string): boolean {
  const wanted = tokensOf(document);
  if (wanted.length === 0) return false;
  const reply = tokensOf(replyText);
  for (let i = 0; i + wanted.length <= reply.length; i++) {
    if (wanted.every((t, j) => reply[i + j] === t)) return true;
  }
  return false;
}

/**
 * #4/AC-1: o summary é texto corrido, sem {{chave}} (`validateReading` recusa o marcador, porque o
 * summary não é renderizado): ele conta o que o fornecedor disse, e o que o fornecedor disse (o número
 * do documento dele) não está no catálogo. Por isso cada número do summary tem de ser um valor de fato
 * do catálogo, um identificador do pedido ou o `supplier_document` citado, que está na resposta; o
 * `supplier_document` é só o identificador do documento (no máximo dois tokens, como "NF-D 881"), e
 * `validateReading` recusa o que passar disso, para que o campo não carregue uma frase da resposta e
 * libere os números dela;
 * `textChecks` (o mesmo contrato do texto da #2) faz a conferência, e recusa também o número por extenso.
 */
function allowedNumbers(catalog: FactCatalog, supplierDocument: string | null): ReadonlySet<string> {
  const allowed = new Set<string>(catalog.identifiers);
  const values = [...Object.values(catalog.facts).map((f) => f.value), ...(supplierDocument === null ? [] : [supplierDocument])];
  for (const value of values) {
    allowed.add(value);
    for (const token of value.split(/[\s/]+/)) allowed.add(bareToken(token));
  }
  return allowed;
}

/**
 * #4/AC-4: "atendeu" com documento citado nunca fecha sozinho: o próximo passo é `confirm_document`,
 * diga o modelo o que disser. Só `fulfilled` fecha: o que foi recusado, parcial ou pede informação
 * pede resposta nossa, nunca `close`.
 */
export function guardNextStep(outcome: ReplyOutcome, supplierDocument: string | null, nextStep: NextStep): NextStep {
  if (outcome === 'fulfilled' && supplierDocument !== null) return 'confirm_document';
  if (nextStep === 'close' && outcome !== 'fulfilled') return 'answer_supplier';
  return nextStep;
}

/** #4/AC-1, #4/AC-5: confere a saída crua do modelo contra o pedido e a resposta; só os campos da leitura passam. */
export function validateReading(raw: unknown, ctx: ReadingContext): ReadingValidation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return rejection('invalid_shape', 'reply_outcome');
  const record = raw as Record<string, unknown>; // #33: só lida abaixo, campo a campo, com guarda de tipo
  const { reply_outcome, fulfilled_asks, supplier_document, summary, next_step, injection_flag } = record;
  if (!isOutcome(reply_outcome)) return rejection('invalid_shape', 'reply_outcome');
  // #4/AC-1: a resposta existe, então o modelo não pode dizer que não houve; `no_reply` é só do prazo.
  if (reply_outcome === 'no_reply') return rejection('no_reply_for_reply', 'reply_outcome');
  if (!isTexts(fulfilled_asks)) return rejection('invalid_shape', 'fulfilled_asks');
  if (!fulfilled_asks.every((a) => ctx.asks.includes(a))) return rejection('unknown_ask', 'fulfilled_asks');
  if (supplier_document !== null && !isText(supplier_document)) return rejection('invalid_shape', 'supplier_document');
  const document = supplier_document === null ? null : supplier_document.trim();
  // #33: o documento é só o identificador, no máximo dois tokens; uma frase inteira liberaria os números dela no summary.
  if (document !== null && tokensOf(document).length > MAX_DOCUMENT_TOKENS) return rejection('invalid_shape', 'supplier_document');
  // #33: o documento é palavra do modelo, e libera número no summary: tem de estar na resposta, como o injection_flag.
  if (document !== null && !documentInReply(document, ctx.replyText)) return rejection('document_not_in_reply', 'supplier_document');
  if (!isText(summary) || MARKER.test(summary)) return rejection('invalid_shape', 'summary');
  if (!textChecks(summary, ctx.catalog, allowedNumbers(ctx.catalog, document))) return rejection('number_mismatch', 'summary');
  if (!isNextStep(next_step)) return rejection('invalid_shape', 'next_step');
  if (injection_flag !== null && !isText(injection_flag)) return rejection('invalid_shape', 'injection_flag');
  // #4/AC-5: o trecho tem de estar na resposta, palavra por palavra. Um trecho que o modelo inventou
  // #4/AC-5: recusa a leitura, em vez de seguir sem o aviso: um sinal falso de segurança não vale.
  if (injection_flag !== null && !ctx.replyText.includes(injection_flag)) return rejection('injection_not_in_reply', 'injection_flag');
  return Object.freeze({
    ok: true,
    reading: Object.freeze({
      replyOutcome: reply_outcome,
      fulfilledAsks: Object.freeze([...fulfilled_asks]),
      supplierDocument: document,
      summary,
      nextStep: guardNextStep(reply_outcome, document, next_step),
      injectionFlag: injection_flag,
    }),
  });
}

/** #33: o que se precisa saber de um pedido para o prazo e o filtro. */
export type RequestDeadline = { readonly status: RequestStatus; readonly dueOn: string };

const isPastDue = (dueOn: string, today: string): boolean => parseIsoDate(today).getTime() > parseIsoDate(dueOn).getTime();

/** #4/AC-2: a leitura do pedido que passou do prazo sem resposta; sem número, para a cobrança sair do catálogo. */
const OVERDUE_READING: SupplierReading = Object.freeze({
  replyOutcome: 'no_reply',
  fulfilledAsks: Object.freeze([]),
  supplierDocument: null,
  summary: 'O fornecedor não respondeu até o prazo.',
  nextStep: 'follow_up',
  injectionFlag: null,
});

/**
 * #4/AC-2: um pedido `sent` sem leitura, com `today` depois de `dueOn`, é `no_reply` com `follow_up`.
 * No dia do prazo ainda está no prazo. Pedido com leitura ou que não foi enviado: null.
 */
export function overdueReading(request: RequestDeadline, reading: SupplierReading | null, today: string): SupplierReading | null {
  const pastDue = isPastDue(request.dueOn, today);
  return request.status === 'sent' && reading === null && pastDue ? OVERDUE_READING : null;
}

/** #4: os filtros da lista "Pedidos ao fornecedor"; o rótulo que a pessoa lê mora fora do domínio. */
export type RequestFilter = 'awaiting' | 'answered' | 'needs_you' | 'overdue';

/**
 * #33/AC-5: todo pedido enviado cai em um filtro só (o que não foi enviado, em nenhum). A ordem decide:
 * sem leitura, o prazo separa `awaiting` de `overdue`; `no_reply` é `overdue`; `fulfilled` com `close`
 * é `answered`; todo o resto (inclusive `confirm_document`) precisa de uma pessoa.
 */
export function filterOf(request: RequestDeadline, reading: SupplierReading | null, today: string): RequestFilter | null {
  if (request.status !== 'sent') return null;
  if (reading === null) return isPastDue(request.dueOn, today) ? 'overdue' : 'awaiting';
  if (reading.replyOutcome === 'no_reply') return 'overdue';
  if (reading.replyOutcome === 'fulfilled' && reading.nextStep === 'close') return 'answered';
  return 'needs_you';
}
