// Fake do PostgREST em memória, servido por um fetch injetado (#59). Cobre o que o cliente usa:
// #59 select paginado por Range, filtros eq, insert com on_conflict e resolution, PATCH e DELETE.
import type { FetchFn } from '../../src/connectors/supabase-rest.js';

type Row = Record<string, unknown>;

/** #156 Uma restrição única do banco que o fake imita, inclusive a parcial (`where`). */
export type FakeUnique = {
  readonly table: string;
  readonly name: string;
  readonly columns: readonly string[];
  readonly where?: (row: Row) => boolean;
};

export class FakePostgrest {
  readonly tables = new Map<string, Row[]>();
  /** #156 As restrições únicas declaradas: a violação vira 409 com o código 23505 e o nome da restrição. */
  readonly uniques: FakeUnique[] = [];
  /** #156 O último valor da sequência `return_note_number_seq`, que a rota rpc incrementa. */
  sequence = 0;
  readonly requests: { method: string; url: string; headers: Record<string, string> }[] = [];
  private nextId = 1;

  constructor(seed: Record<string, Row[]> = {}) {
    for (const [t, rows] of Object.entries(seed)) this.tables.set(t, rows.map((r) => ({ ...r })));
  }

  rows(table: string): Row[] {
    return this.tables.get(table) ?? [];
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

    // #156 rpc/<função>: a sequência do sequencial da nota de devolução. O POST devolve o escalar, como o PostgREST.
    if (method === 'POST' && table === 'rpc/next_return_note_number') return json(200, ++this.sequence);

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
          return json(409, { message: 'duplicate key' });
        }
        const row: Row = { ...this.defaults(table), ...incoming };
        const violated = this.uniques.find((u) => u.table === table && this.collides(rows, row, u));
        if (violated) {
          return json(409, {
            code: '23505',
            message: `duplicate key value violates unique constraint "${violated.name}"`,
          });
        }
        rows.push(row);
        this.recordHistory(table, row);
        out.push(row);
      }
      return json(201, out);
    }
    if (method === 'PATCH') {
      const hit = rows.filter((r) => this.matches(r, params));
      for (const r of hit) {
        Object.assign(r, body as Row);
        // #156 O trigger BEFORE UPDATE sobe a versão; o AFTER grava o histórico.
        if (table === 'supplier_requests') r.version = Number(r.version) + 1;
        this.recordHistory(table, r);
      }
      return json(200, hit);
    }
    if (method === 'DELETE') {
      this.tables.set(table, rows.filter((r) => !this.matches(r, params)));
      return new Response(null, { status: 204 });
    }
    return json(405, {});
  };

  private collides(rows: Row[], row: Row, unique: FakeUnique): boolean {
    if (unique.where && !unique.where(row)) return false;
    return rows.some((r) => (!unique.where || unique.where(r)) && unique.columns.every((c) => r[c] === row[c]));
  }

  /** #156 O trigger AFTER INSERT OR UPDATE de supplier_requests: uma linha de histórico por versão. */
  private recordHistory(table: string, row: Row): void {
    if (table !== 'supplier_requests') return;
    const history = this.tables.get('supplier_request_history') ?? [];
    this.tables.set('supplier_request_history', history);
    history.push({ request_id: row.id, version: row.version, at: row.updated_at, by: row.updated_by, state: { ...row } });
  }

  private defaults(table: string): Row {
    const now = new Date().toISOString();
    if (table === 'supplier_requests') return { version: 1 };
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
    if (table.startsWith('outbox_')) return { id: this.nextId++, published_at: now };
    if (table === 'invoices') return { captured_at: now, classification: null, checked_at: null };
    // #63 As colunas com default da migração do domínio e da aprovação.
    if (table === 'proposals') return { id: this.nextId++, state: 'registrada', regua_line: null, created_at: now };
    if (table === 'approvals') return { id: this.nextId++, dock_action: null, decided_on: null, approved_at: now };
    if (table === 'titles') return { state: 'lancado', updated_at: now };
    return {};
  }

  private matches(row: Row, params: URLSearchParams): boolean {
    for (const [col, expr] of params) {
      if (['select', 'order', 'on_conflict', 'limit'].includes(col)) continue;
      // #71 e #63: in.(a,"b") do PostgREST, valores separados por vírgula, aspas opcionais.
      const inList = /^in\.\((.*)\)$/.exec(expr);
      if (inList) {
        const values = (inList[1] ?? '').split(',').map((v) => v.replace(/^"(.*)"$/, '$1'));
        if (!values.includes(String(row[col]))) return false;
        continue;
      }
      // #56 not.is.null: o filtro que pega todas as linhas de uma coluna not null.
      if (expr === 'not.is.null') {
        if (row[col] === null || row[col] === undefined) return false;
        continue;
      }
      if (expr.startsWith('gte.')) {
        if (Date.parse(String(row[col])) < Date.parse(expr.slice(4))) return false;
        continue;
      }
      if (!expr.startsWith('eq.')) throw new Error(`fake: filtro não suportado ${col}=${expr}`);
      if (String(row[col]) !== expr.slice(3)) return false;
    }
    return true;
  }
}
