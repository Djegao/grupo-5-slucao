/* #157 A leitura da resposta do fornecedor ao pedido da #156, e a cobrança de quem não respondeu.
   Regras puras: o Claude só classifica e resume; o próximo passo, o alerta de ordem escondida e o
   rascunho da cobrança são decididos aqui. Nenhuma leitura muda a decisão, o título nem o valor em
   risco (AC-6): este módulo não conhece nada disso. */
import { DomainError } from './errors.js';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** #157 O que o fornecedor fez. `no_reply` só o sistema atribui, quando o prazo passa sem resposta. */
export type ReplyOutcome = 'fulfilled' | 'partially_fulfilled' | 'refused' | 'needs_information' | 'no_reply';

/** #157 O próximo passo da pessoa. */
export type NextStep = 'close' | 'confirm_document' | 'answer_supplier' | 'follow_up';

/** #157 O rascunho da cobrança, no mesmo formato do pedido (para, assunto, texto, o que pedimos). */
export type FollowUpDraft = {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly asks: readonly string[];
};

export type SupplierReplyReading = {
  readonly outcome: ReplyOutcome;
  readonly fulfilledAsks: readonly string[];
  readonly supplierDocument: string | null;
  readonly summary: string;
  readonly nextStep: NextStep;
  readonly followUpDraft: FollowUpDraft | null;
  readonly injectionFlag: string | null;
};

/** #157 O pedido como a leitura o vê: só o que ela precisa. */
export type RequestForReading = {
  readonly to: string;
  readonly subject: string;
  readonly asks: readonly string[];
  readonly dueOn: string | null;
  readonly sentAt: string | null;
};

const MODEL_OUTCOMES = ['fulfilled', 'partially_fulfilled', 'refused', 'needs_information'] as const;
const MAX_SUMMARY = 280;
const MAX_DOCUMENT = 60;
const MAX_FLAG = 200;

/** #157 A saída estruturada que o Claude devolve ao ler a resposta. */
export const SUPPLIER_REPLY_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply_outcome', 'fulfilled_asks', 'supplier_document', 'summary', 'injection_excerpt'],
  properties: {
    reply_outcome: { type: 'string', enum: [...MODEL_OUTCOMES] },
    fulfilled_asks: { type: 'array', items: { type: 'string' } },
    supplier_document: { type: ['string', 'null'] },
    summary: { type: 'string' },
    injection_excerpt: { type: ['string', 'null'] },
  },
} as const;

/**
 * #157/AC-4 Frases que tentam dar ordem a quem lê, em vez de responder ao pedido. A lista é a rede de baixo:
 * o Claude também aponta o trecho, e vale a união dos dois.
 */
const INJECTION_PATTERNS: readonly RegExp[] = [
  /consider(e|em|ar)\s+(a|o|as|os|esta|este)\s+[^.\n]{0,40}\b(aprovad[ao]s?|liberad[ao]s?|pag[ao]s?|encerrad[ao]s?|quitad[ao]s?)/i,
  /\bliber(e|em|ar)\s+o\s+pagamento/i,
  /\b(d[eê]|deem|dar)\s+baixa\b/i,
  /\b(t[ií]tulo|nota|d[ií]vida)\s+(est[aá]\s+)?quitad[ao]/i,
  /\b(aprove|aprovem|aprovar)\b[^.\n]{0,40}\b(nota|pagamento|t[ií]tulo)/i,
  /ignore\s+(as|todas\s+as)?\s*(instru[cç][oõ]es|regras|anteriores)/i,
  /\b(cancele|cancelem)\s+a\s+devolu[cç][aã]o/i,
  /\bmarque\s+(como\s+)?(pago|aprovad[ao]|atendid[ao])/i,
  /\b(voc[eê]\s+[eé]|aja\s+como)\s+(um|uma)?\s*(assistente|agente|sistema)/i,
];

/** #157/AC-4 O trecho da resposta que tenta dar ordem, ou nulo. */
export function detectInjection(body: string): string | null {
  for (const pattern of INJECTION_PATTERNS) {
    const match = pattern.exec(body);
    if (!match) continue;
    const start = Math.max(0, body.lastIndexOf('\n', match.index) + 1);
    const endLine = body.indexOf('\n', match.index + match[0].length);
    return body.slice(start, endLine === -1 ? undefined : endLine).trim().slice(0, MAX_FLAG);
  }
  return null;
}

/**
 * #157/AC-3 O próximo passo sai da regra, não do Claude. "Atendeu" com documento citado nunca fecha sozinho:
 * a pessoa confirma o documento. Atender sem citar documento também pede a confirmação: o caso não fecha só
 * porque o fornecedor disse.
 */
export function nextStepFor(outcome: ReplyOutcome): NextStep {
  switch (outcome) {
    case 'fulfilled':
      return 'confirm_document';
    case 'needs_information':
      return 'answer_supplier';
    case 'partially_fulfilled':
    case 'refused':
    case 'no_reply':
      return 'follow_up';
  }
}

const dayMonth = (iso: string | null): string => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '');

/** #157/AC-2 O rascunho da cobrança: texto da regra, sem número que não venha do pedido. */
export function followUpDraftFor(request: RequestForReading, outcome: ReplyOutcome, fulfilledAsks: readonly string[] = []): FollowUpDraft {
  // #157 Na resposta parcial, a cobrança pede só o que falta.
  const open = request.asks.filter((a) => !fulfilledAsks.includes(a));
  const pending = open.length > 0 ? open : request.asks;
  const lead =
    outcome === 'no_reply'
      ? `Não recebemos resposta ao pedido enviado em ${dayMonth(request.sentAt)}, com prazo até ${dayMonth(request.dueOn)}.`
      : outcome === 'refused'
        ? 'Recebemos a sua resposta, mas o pedido segue em aberto do nosso lado.'
        : 'Recebemos a sua resposta; parte do pedido segue em aberto.';
  const body = [
    'Olá.',
    '',
    lead,
    'Pedimos, por favor:',
    ...pending.map((a) => `- ${a}`),
    '',
    'A nota de devolução segue anexa ao pedido original. Ficamos no aguardo.',
    '',
    'Obrigado,',
    'Contas a pagar · Já Chegou',
  ].join('\n');
  return { to: request.to, subject: `Lembrete: ${request.subject}`, body, asks: [...pending] };
}

/**
 * #157/AC-1, AC-3, AC-4 Aceita a leitura do Claude: confere o formato, guarda só os "o que pedimos" que existem
 * no pedido, decide o próximo passo pela regra e junta o alerta de ordem escondida (o do Claude só vale se o
 * trecho está mesmo na resposta). Formato errado lança `DomainError`: a mensagem fica para a próxima rodada.
 */
export function acceptReplyReading(raw: unknown, request: RequestForReading, replyBody: string): SupplierReplyReading {
  if (!isRecord(raw)) throw new DomainError('leitura sem formato');
  const outcome = MODEL_OUTCOMES.find((o) => o === raw.reply_outcome);
  if (outcome === undefined) throw new DomainError('reply_outcome inválido');
  const claimed = raw.fulfilled_asks;
  if (!isStringArray(claimed)) throw new DomainError('fulfilled_asks inválido');
  const summary = raw.summary;
  if (typeof summary !== 'string' || summary.trim() === '') throw new DomainError('summary vazio');
  // #157/AC-3 O documento só vale se está escrito na resposta: a pessoa não confirma um número inventado.
  const rawDocument = typeof raw.supplier_document === 'string' ? raw.supplier_document.trim() : '';
  const document = rawDocument !== '' && replyBody.includes(rawDocument) ? rawDocument.slice(0, MAX_DOCUMENT) : null;
  const fulfilledAsks = request.asks.filter((ask) => claimed.some((f) => f.trim() === ask));
  const excerpt = typeof raw.injection_excerpt === 'string' ? raw.injection_excerpt.trim() : '';
  const modelFlag = excerpt !== '' && replyBody.includes(excerpt) ? excerpt.slice(0, MAX_FLAG) : null;
  const nextStep = nextStepFor(outcome);
  return {
    outcome,
    fulfilledAsks,
    supplierDocument: document,
    summary: summary.trim().slice(0, MAX_SUMMARY),
    nextStep,
    followUpDraft: nextStep === 'follow_up' ? followUpDraftFor(request, outcome, fulfilledAsks) : null,
    injectionFlag: detectInjection(replyBody) ?? modelFlag,
  };
}

/** #157/AC-2 O pedido enviado passou do prazo? O prazo vale o dia inteiro: atrasa no dia seguinte. */
export const isOverdue = (dueOn: string | null, today: string): boolean => dueOn !== null && dueOn < today;

/** #157/AC-2 A leitura do sistema para quem não respondeu no prazo, com a cobrança. */
export function noReplyReading(request: RequestForReading): SupplierReplyReading {
  return {
    outcome: 'no_reply',
    fulfilledAsks: [],
    supplierDocument: null,
    summary: `Sem resposta até ${dayMonth(request.dueOn)}.`,
    nextStep: 'follow_up',
    followUpDraft: followUpDraftFor(request, 'no_reply'),
    injectionFlag: null,
  };
}

/** #157/AC-5 Em que aba da lista o pedido aparece. */
export type ReplyBucket = 'aguardando' | 'atendidos' | 'precisam' | 'atrasados';

export function bucketOf(state: {
  readonly latest: { readonly outcome: ReplyOutcome; readonly nextStep: NextStep } | null;
  readonly documentConfirmed: boolean;
  /** #157 A pessoa já mandou a cobrança ou a resposta da última leitura. */
  readonly followUpSent: boolean;
  /** #157 A pessoa encerrou o caso. */
  readonly closed?: boolean;
}): ReplyBucket {
  const { latest } = state;
  if (state.closed) return 'atendidos';
  if (latest === null) return 'aguardando';
  if (state.documentConfirmed || latest.nextStep === 'close') return 'atendidos';
  if (latest.outcome === 'no_reply') return state.followUpSent ? 'aguardando' : 'atrasados';
  if ((latest.nextStep === 'follow_up' || latest.nextStep === 'answer_supplier') && state.followUpSent) return 'aguardando';
  return 'precisam';
}

/** #157 O texto que a pessoa escreve ou edita (cobrança, resposta): não vazio e com teto. */
export const MAX_OUTBOUND_TEXT = 5000;
export function outboundText(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  return trimmed === '' || trimmed.length > MAX_OUTBOUND_TEXT ? null : trimmed;
}
