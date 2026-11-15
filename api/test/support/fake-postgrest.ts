// Fake do PostgREST em memória, servido por um fetch injetado (#59). Cobre o que o cliente usa:
// #59 select paginado por Range, filtros eq, insert com on_conflict e resolution, PATCH e DELETE.
import type { FetchFn } from '../../src/connectors/supabase-rest.js';

type Row = Record<string, unknown>;

export class FakePostgrest {
  readonly tables = new Map<string, Row[]>();
  readonly requests: { method: string; url: string; headers: Record<string, string> }[] = [];
  private nextId = 1;
  private readonly sequences = new Map<string, number>();
  private readonly uniques: { table: string; columns: string[]; when: (row: Row) => boolean }[] = [];
  private readonly failures: { table: string; method: string; status: number; body: unknown }[] = [];

  constructor(seed: Record<string, Row[]> = {}) {
    for (const [t, rows] of Object.entries(seed)) this.tables.set(t, rows.map((r) => ({ ...r })));
  }

  rows(table: string): Row[] {
    return this.tables.get(table) ?? [];
  }

  /** #12 Uma restrição única (parcial, se `when` filtra): o POST que a viola volta 409 com o código 23505, como o PostgREST. */
  unique(table: string, columns: string[], when: (row: Row) => boolean = () => true): void {
    this.uniques.push({ table, columns, when });
  }

  /** #12 A próxima requisição da tabela e do método falha com este status e corpo (uma vez). */
  failNext(table: string, method: string, status: number, body: unknown): void {
    this.failures.push({ table, method, status, body });
  }

  readonly fetch: FetchFn = async (input, init = {}) => {
    const url = new URL(input);
    const table = url.pathname.replace(/^\/rest\/v1\//, '');
    const headers = (init.headers ?? {}) as Record<string, string>;
    const method = init.method ?? 'GET';
    this.requests.push({ method, url: input, headers });
    const params = url.searchParams;
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    const rows = this.tables.get(table) ?? [];
    this.tables.set(table, rows);
    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
    const failureAt = this.failures.findIndex((f) => f.table === table && f.method === method);
    if (failureAt >= 0) {
      const [failure] = this.failures.splice(failureAt, 1);
      return json(failure!.status, failure!.body);
    }

    if (method === 'GET') {
      let result = rows.filter((r) => this.matches(r, params));
      const order = params.get('order');
      if (order) {
        const cols = order.split(',');
        result = [...result].sort((a, b) => {
          for (const spec of cols) {
            const [c = '', dir] = spec.split('.');
            const x = String(a[c] ?? '');
            const y = String(b[c] ?? '');
            if (x !== y) return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1);
          }
          return 0;
        });
      }
      const limit = params.get('limit');
      if (limit) result = result.slice(0, Number(limit));
      const range = headers.Range;
      if (range) {
        const [from, to] = range.split('-').map(Number) as [number, number];
        result = result.slice(from, to + 1);
      }
      const select = params.get('select');
      if (select && select !== '*') {
        const cols = select.split(',');
        result = result.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
      }
      return json(200, result);
    }
    if (method === 'POST') {
      const conflict = params.get('on_conflict')?.split(',');
      const prefer = headers.Prefer ?? '';
      const out: Row[] = [];
      for (const incoming of body as Row[]) {
        const existing = conflict ? rows.find((r) => conflict.every((c) => r[c] === incoming[c])) : undefined;
        if (existing) {
          if (prefer.includes('resolution=ignore-duplicates')) continue;
          if (prefer.includes('resolution=merge-duplicates')) {
            Object.assign(existing, incoming);
            out.push(existing);
            continue;
          }
          return json(409, { code: '23505', message: 'duplicate key' });
        }
        const row: Row = { ...this.defaults(table), ...incoming };
        const violated = this.uniques.some(
          (u) => u.table === table && u.when(row) && rows.some((r) => u.when(r) && u.columns.every((c) => r[c] === row[c])),
        );
        if (violated) return json(409, { code: '23505', message: 'duplicate key value violates unique constraint' });
        rows.push(row);
        out.push(row);
      }
      return json(201, out);
    }
    if (method === 'PATCH') {
      const hit = rows.filter((r) => this.matches(r, params));
      for (const r of hit) Object.assign(r, body as Row);
      return json(200, hit);
    }
    if (method === 'DELETE') {
      this.tables.set(table, rows.filter((r) => !this.matches(r, params)));
      return new Response(null, { status: 204 });
    }
    return json(405, {});
  };

  private defaults(table: string): Row {
    const now = new Date().toISOString();
    // #140 A fila de devolução: o estado inicial e as colunas que a migração deixa nulas.
    if (table === 'outbox_return_notes') {
      return {
        id: this.nextId++,
        published_at: now,
        status: 'pendente',
        nfe_number: null,
        emitted_by: null,
        emitted_at: null,
        cancel_justification: null,
        cancelled_by: null,
        cancelled_at: null,
      };
    }
    // #12 O pedido ao fornecedor e a nota emitida: identidade por tabela e as colunas que a migração deixa nulas.
    if (table === 'outbox_supplier_emails') {
      return {
        id: this.sequence(table),
        status: 'draft',
        discard_reason: null,
        send_failure_reason: null,
        issued_return_note_id: null,
        channel: null,
        provider_message_id: null,
        sent_by: null,
        sent_at: null,
        discarded_by: null,
        discarded_at: null,
        send_claim: null,
        send_claimed_at: null,
        attachments: [],
        version: 1,
        history: [],
        created_at: now,
        updated_at: now,
      };
    }
    if (table === 'issued_return_notes') return { id: this.sequence(table), created_at: now };
    if (table.startsWith('outbox_')) return { id: this.nextId++, published_at: now };
    if (table === 'invoices') return { captured_at: now, classification: null, checked_at: null };
    // #63 As colunas com default da migração do domínio e da aprovação.
    if (table === 'proposals') return { id: this.nextId++, state: 'registrada', regua_line: null, created_at: now };
    if (table === 'approvals') return { id: this.nextId++, dock_action: null, decided_on: null, approved_at: now };
    if (table === 'titles') return { state: 'lancado', updated_at: now };
    return {};
  }

  private sequence(table: string): number {
    const next = (this.sequences.get(table) ?? 0) + 1;
    this.sequences.set(table, next);
    return next;
  }

  private matches(row: Row, params: URLSearchParams): boolean {
    for (const [col, expr] of params) {
      if (['select', 'order', 'on_conflict', 'limit'].includes(col)) continue;
      // #12 or=(a.is.null,b.lt.X): cada termo é `coluna.operador.valor`; o valor pode ter pontos.
      if (col === 'or') {
        const terms = /^\((.*)\)$/.exec(expr)?.[1]?.split(',') ?? [];
        if (!terms.some((term) => this.term(row, term))) return false;
        continue;
      }
      if (!this.test(row, col, expr)) return false;
    }
    return true;
  }

  private term(row: Row, term: string): boolean {
    const [col = '', ...rest] = term.split('.');
    return this.test(row, col, rest.join('.'));
  }

  private test(row: Row, col: string, expr: string): boolean {
    // #71 e #63: in.(a,"b") do PostgREST, valores separados por vírgula, aspas opcionais.
    const inList = /^in\.\((.*)\)$/.exec(expr);
    if (inList) {
      const values = (inList[1] ?? '').split(',').map((v) => v.replace(/^"(.*)"$/, '$1'));
      return values.includes(String(row[col]));
    }
    // #56 not.is.null: o filtro que pega todas as linhas de uma coluna not null.
    if (expr === 'not.is.null') return row[col] !== null && row[col] !== undefined;
    // #12 is.null: a coluna sem valor.
    if (expr === 'is.null') return row[col] === null || row[col] === undefined;
    if (expr.startsWith('gte.')) return !(Date.parse(String(row[col])) < Date.parse(expr.slice(4)));
    // #12 lt.: menor que, em instantes (a coluna sem valor nunca é menor).
    if (expr.startsWith('lt.')) return row[col] !== null && row[col] !== undefined && Date.parse(String(row[col])) < Date.parse(expr.slice(3));
    if (!expr.startsWith('eq.')) throw new Error(`fake: filtro não suportado ${col}=${expr}`);
    return String(row[col]) === expr.slice(3);
  }
}
