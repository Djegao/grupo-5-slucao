import {
  SupplierRequest,
  type ReturnNote,
  type SupplierRequestSnapshot,
  type SupplierRequestStatus,
} from '../../src/domain/index.js';
import type {
  DecidedCase,
  DecidedProposalSource,
  QueueRow,
  ReturnNoteEmissions,
  ReturnNoteWorkQueue,
  SendResult,
  SupplierDirectory,
  SupplierEmail,
  SupplierEmailSender,
  SupplierRequestRepository,
  SupplierRequestDeps,
} from '../../src/supplier-requests/index.js';
import { emptyContext } from '../domain/fixtures.js';
import { decided, originInvoice, partialReturn } from '../domain/supplier-request-fixtures.js';

// #156: os doubles das portas dos casos de uso: tudo em memória, sem banco, sem rede, sem o Claude.

/** #156: o envio em memória: guarda o que "enviou" e é idempotente pelo `requestId`, como a porta exige. */
export class InMemorySupplierEmailSender implements SupplierEmailSender {
  readonly sent: SupplierEmail[] = [];
  private readonly providerIds = new Map<string, string>();
  private failure: string | null = null;

  /** #156: a próxima chamada falha com este motivo. */
  failNextWith(reason: string): void {
    this.failure = reason;
  }

  async send(email: SupplierEmail): Promise<SendResult> {
    const already = this.providerIds.get(email.requestId);
    if (already !== undefined) return { ok: true, providerMessageId: already, channel: 'mock' };
    if (this.failure !== null) {
      const reason = this.failure;
      this.failure = null;
      return { ok: false, reason };
    }
    this.sent.push(email);
    const providerMessageId = `mock-${this.sent.length}`;
    this.providerIds.set(email.requestId, providerMessageId);
    return { ok: true, providerMessageId, channel: 'mock' };
  }
}

export class FakeRequests implements SupplierRequestRepository {
  readonly rows = new Map<string, SupplierRequestSnapshot>();
  async findById(id: string) {
    const s = this.rows.get(id);
    return s ? SupplierRequest.restore(s) : null;
  }
  async listByInvoice(key: string) {
    return [...this.rows.values()].filter((s) => s.invoiceAccessKey === key).map((s) => SupplierRequest.restore(s));
  }
  listByInvoicesCalls = 0;
  async listByInvoices(keys: readonly string[]) {
    this.listByInvoicesCalls += 1;
    return [...this.rows.values()].filter((s) => keys.includes(s.invoiceAccessKey)).map((s) => SupplierRequest.restore(s));
  }
  async listByStatus(status: SupplierRequestStatus) {
    return [...this.rows.values()].filter((s) => s.status === status).map((s) => SupplierRequest.restore(s));
  }
  private findOpen(key: string, type: SupplierRequestSnapshot['requestType']) {
    const hit = [...this.rows.values()].find(
      (s) => s.invoiceAccessKey === key && s.requestType === type && ['writing', 'draft', 'send_failed'].includes(s.status),
    );
    return hit ? SupplierRequest.restore(hit) : null;
  }
  async add(request: SupplierRequest) {
    if (this.findOpen(request.invoiceAccessKey, request.requestType)) return 'duplicate_open' as const;
    this.rows.set(request.id, request.snapshot());
    return 'saved' as const;
  }
  async save(request: SupplierRequest, expectedUpdatedAt: string) {
    const current = this.rows.get(request.id);
    if (!current || current.updatedAt !== expectedUpdatedAt) return 'stale' as const;
    this.rows.set(request.id, request.snapshot());
    return 'saved' as const;
  }
}

export class FakeQueue implements ReturnNoteWorkQueue {
  readonly rows = new Map<number, QueueRow & { invoiceAccessKey: string; status: 'pendente' | 'emitida' | 'cancelada'; number: string | null }>();
  publishes = 0;
  constructor(private readonly valueOverrideCents: number | null = null) {}
  async ensureRow(input: Parameters<ReturnNoteWorkQueue['ensureRow']>[0]) {
    const found = [...this.rows.values()].find((r) => r.invoiceAccessKey === input.invoiceAccessKey);
    if (found) return { id: found.id, valueCents: found.valueCents };
    this.publishes += 1;
    const id = 140 + this.rows.size;
    const valueCents =
      this.valueOverrideCents ??
      input.lines.reduce((sum, l) => {
        const item = originInvoice().items.find((i) => i.supplierCode === l.supplierCode);
        return sum + (item ? item.unitPrice.cents * l.quantity.amount : 0);
      }, 0);
    this.rows.set(id, { id, valueCents, invoiceAccessKey: input.invoiceAccessKey, status: 'pendente', number: null });
    return { id, valueCents };
  }
  async markEmitted(id: number, number: string) {
    const row = this.rows.get(id);
    if (!row) return 'not_found' as const;
    if (row.status === 'pendente') {
      row.status = 'emitida';
      row.number = number;
      return 'ok' as const;
    }
    return row.status === 'emitida' && row.number === number ? ('ok' as const) : ('conflict' as const);
  }
}

export class FakeEmissions implements ReturnNoteEmissions {
  readonly notes = new Map<number, ReturnNote>();
  sequence = 11;
  async findByQueueRow(id: number) {
    return this.notes.get(id) ?? null;
  }
  async findByNoteId(noteId: string) {
    return [...this.notes.values()].find((n) => n.nota_id === noteId) ?? null;
  }
  async nextSequence() {
    this.sequence += 1;
    return this.sequence;
  }
  async save(id: number, note: ReturnNote) {
    const winner = this.notes.get(id) ?? note;
    this.notes.set(id, winner);
    return winner;
  }
}

export const E2_CASE = (): DecidedCase => ({
  proposal: decided('E2', partialReturn()),
  invoice: originInvoice(),
  goodsEntered: false,
  context: emptyContext(),
  decidedBy: 'ana@jachegou.test',
});

export class FakeSource implements DecidedProposalSource {
  readonly cases = new Map<string, DecidedCase>();
  constructor(...cases: DecidedCase[]) {
    for (const c of cases) this.cases.set(c.invoice.accessKey, c);
  }
  async listDecided() {
    return [...this.cases.values()];
  }
  async find(key: string) {
    return this.cases.get(key) ?? null;
  }
}

export const GOOD_BODY =
  'Olá. Na NF {{nota.numero}} veio {{devolucao.item[F11-001].descricao}} ({{devolucao.item[F11-001].quantidade}}, {{devolucao.valor_total}}) no lugar do item pedido. Pedimos a retirada até {{pedido.prazo}}.';

export type World = {
  deps: SupplierRequestDeps;
  requests: FakeRequests;
  queue: FakeQueue;
  emissions: FakeEmissions;
  sender: InMemorySupplierEmailSender;
  source: FakeSource;
  clock: { current: Date };
  logs: string[];
};

export function world(options: { cases?: DecidedCase[]; queueValueCents?: number; email?: string | null } = {}): World {
  const requests = new FakeRequests();
  const queue = new FakeQueue(options.queueValueCents ?? null);
  const emissions = new FakeEmissions();
  const sender = new InMemorySupplierEmailSender();
  const source = new FakeSource(...(options.cases ?? [E2_CASE()]));
  const clock = { current: new Date('2026-11-16T12:00:00.000Z') };
  const logs: string[] = [];
  let n = 0;
  const email = options.email === undefined ? 'fiscal@higienetotal.test' : options.email;
  const directory: SupplierDirectory = { emailOf: async (id) => (id === 'F11' ? email : null) };
  const deps: SupplierRequestDeps = {
    requests,
    emissions,
    queue,
    sender,
    directory,
    source,
    clock: { now: () => clock.current },
    ids: { next: () => `req-${++n}` },
    log: (line) => logs.push(line),
    config: { issuerCnpj: '12.345.678/0001-95', channel: 'mock' },
  };
  return { deps, requests, queue, emissions, sender, source, clock, logs };
}
