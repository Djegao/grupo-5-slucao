import type { Ask } from '../../src/claude/client.js';
import {
  SupplierRequest,
  issueReturnNote,
  type IssuedReturnNote,
  type RequestStatus,
  type ReturnNoteDraft,
} from '../../src/domain/index.js';
import type { ReturnNoteQueue, ReturnNoteStatus, ReturnNoteView, TransitionResult } from '../../src/returns/return-notes.js';
import type {
  CreateResult,
  MailMessage,
  MailResult,
  NewRequest,
  RequestChange,
  RequestRecord,
  SupplierDeps,
} from '../../src/supplier/ports.js';
import { SOURCE_KEY, sourceInvoice } from '../domain/supplier-request-fixtures.js';

// #11: dublês das portas do pedido ao fornecedor; nenhum banco, nenhuma rede.

export const NOW = new Date('2026-11-12T15:00:00Z');
export const SUPPLIER_EMAIL = 'compras@bebidas-rio-claro.example';

/** #11: o texto que o Claude falso devolve; todo número é {{chave}} do catálogo. */
export const GOOD_TEXT = {
  subject: 'Devolução da nota {{nota.numero}}',
  body: 'Devolvemos {{devolucao.item[F02-002].quantidade}} de F02-002, no valor de {{devolucao.item[F02-002].valor}}. Total {{devolucao.total}}, retorno até {{prazo}}.',
  asks: ['Confirmar o recebimento da nota de devolução', 'Creditar {{devolucao.total}} até {{prazo}}'],
};

export type FakeAsk = Ask & { calls: unknown[] };

export const fakeAsk = (answer: unknown = GOOD_TEXT): FakeAsk => {
  const calls: unknown[] = [];
  const ask = (async (options: unknown) => {
    calls.push(options);
    if (answer instanceof Error) throw answer;
    return answer;
  }) as FakeAsk;
  ask.calls = calls;
  return ask;
};

export const queueView = (id: number, overrides: Partial<ReturnNoteView> = {}): ReturnNoteView => ({
  id,
  status: 'pendente',
  invoiceAccessKey: SOURCE_KEY,
  invoiceNumber: '43894',
  supplierId: 'F02',
  reason: 'item trocado',
  lines: [
    { supplierCode: 'F02-002', description: 'Refrigerante cola 2 L', quantity: { amount: 7, unit: 'UN' }, valueCents: 5943 },
    { supplierCode: 'F02-005', description: 'Arroz 5 kg', quantity: { amount: 5, unit: 'CX' }, valueCents: 50000 },
  ],
  valueCents: 55943,
  publishedAt: '2026-11-12T10:00:00Z',
  pendingSeconds: 0,
  emitted: null,
  cancelled: null,
  ...overrides,
});

export type FakeQueue = ReturnNoteQueue & { views: ReturnNoteView[]; emitCalls: unknown[][] };

export const fakeQueue = (views: ReturnNoteView[]): FakeQueue => {
  const queue: FakeQueue = {
    views,
    emitCalls: [],
    list: async (status: ReturnNoteStatus) => queue.views.filter((v) => v.status === status),
    emit: async (id, number, by, now): Promise<TransitionResult> => {
      queue.emitCalls.push([id, number, by, now]);
      const view = queue.views.find((v) => v.id === id);
      if (view === undefined) return { kind: 'not_found' };
      if (view.status !== 'pendente') return { kind: 'conflict' };
      view.status = 'emitida';
      view.emitted = { number, by, at: now.toISOString() };
      return { kind: 'ok', note: view };
    },
    cancel: async () => ({ kind: 'conflict' }),
  };
  return queue;
};

type Stored = RequestRecord & { stamps: RequestChange[] };

export type FakeRequests = SupplierDeps['requests'] & { rows: Stored[]; saves: number };

export const fakeRequests = (): FakeRequests => {
  const rows: Stored[] = [];
  const store: FakeRequests = {
    rows,
    saves: 0,
    findOpen: async (key, type) =>
      rows.find((r) => r.request.invoiceAccessKey === key && r.request.requestType === type && r.request.isOpen) ?? null,
    get: async (id) => rows.find((r) => r.request.id === id) ?? null,
    create: async (input: NewRequest): Promise<CreateResult> => {
      const opens = input.outcome.kind === 'draft';
      if (opens && rows.some((r) => r.request.invoiceAccessKey === input.invoiceAccessKey && r.request.isOpen)) {
        return { kind: 'conflict' };
      }
      const base = { id: rows.length + 41, invoiceAccessKey: input.invoiceAccessKey, note: input.note, draftedOn: input.draftedOn };
      const request =
        input.outcome.kind === 'draft'
          ? SupplierRequest.draft({ ...base, text: input.outcome.text })
          : SupplierRequest.rejected({ ...base, rejection: input.outcome.rejection });
      const row: Stored = { request, queueId: input.queueId, to: input.to, stamps: [] };
      rows.push(row);
      return { kind: 'ok', record: row };
    },
    save: async (request, change) => {
      store.saves += 1;
      const row = rows.find((r) => r.request === request);
      if (row !== undefined && change !== undefined) row.stamps.push(change);
    },
  };
  return store;
};

export type FakeNotes = SupplierDeps['notes'] & { issuedCount: number };

export const fakeNotes = (): FakeNotes => {
  const byQueue = new Map<number, IssuedReturnNote>();
  const notes: FakeNotes = {
    issuedCount: 0,
    issue: async (queueId: number, draft: ReturnNoteDraft, issuedOn: string) => {
      const known = byQueue.get(queueId);
      if (known !== undefined) return known;
      notes.issuedCount += 1;
      const issued = issueReturnNote(draft, { sequence: 100 + notes.issuedCount, issuedOn });
      byQueue.set(queueId, issued);
      return issued;
    },
  };
  return notes;
};

export type FakeMailer = SupplierDeps['mailer'] & { sent: MailMessage[]; outcomes: Array<MailResult | Error> };

/** #11: cada envio consome o próximo resultado programado; sem nenhum, o envio dá certo pelo mock. */
export const fakeMailer = (...outcomes: Array<MailResult | Error>): FakeMailer => {
  const mailer: FakeMailer = {
    sent: [],
    outcomes,
    send: async (message) => {
      mailer.sent.push(message);
      const next = mailer.outcomes.shift() ?? { ok: true, channel: 'mock', providerMessageId: `mock-${mailer.sent.length}` };
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return mailer;
};

export type World = {
  deps: SupplierDeps;
  queue: FakeQueue;
  requests: FakeRequests;
  notes: FakeNotes;
  mailer: FakeMailer;
};

export const world = (mailer: FakeMailer = fakeMailer(), views: ReturnNoteView[] = [queueView(7)]): World => {
  const queue = fakeQueue(views);
  const requests = fakeRequests();
  const notes = fakeNotes();
  const deps: SupplierDeps = {
    queue,
    requests,
    notes,
    mailer,
    source: { find: async (key) => (key === SOURCE_KEY ? { invoice: sourceInvoice(), supplierEmail: SUPPLIER_EMAIL } : null) },
    clock: { now: () => NOW },
  };
  return { deps, queue, requests, notes, mailer };
};

export const statusOf = (w: World, id: number): RequestStatus | undefined =>
  w.requests.rows.find((r) => r.request.id === id)?.request.status;
