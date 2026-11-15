import { describe, expect, it } from 'vitest';
import { runClaudeRound } from '../../../src/claude/cron.js';
import { tasksFor } from '../../../src/claude/tasks/index.js';
import type { Db } from '../../../src/claude/db.js';
import { SUPPLIER_DRAFT_TASK, type SupplierDraftInput } from '../../../src/supplier/draft-task.js';
import { GOOD_TEXT, SUPPLIER_EMAIL, fakeAsk } from '../../supplier/doubles.js';
import { harness, invoiceRow, queueRow, supplierRow } from '../../supplier/supabase-support.js';

// #12: o registro das tarefas do Claude leva a tarefa do rascunho do pedido ao fornecedor (#2).

const db: Db = { select: async () => [], upsert: async () => [] };
const seed = () => ({ outbox_return_notes: [queueRow()], invoices: [invoiceRow()], kit_fornecedores: [supplierRow()] });

describe('#12/AC-6 a tarefa do rascunho entra no registro das tarefas do Claude', () => {
  it('o registro tem a tarefa do pedido ao fornecedor', () => {
    const { rest } = harness();
    expect(tasksFor(rest).map((t) => t.name)).toContain(SUPPLIER_DRAFT_TASK);
  });

  it('a tarefa lista a devolução pendente e grava o rascunho no banco, para o e-mail do fornecedor, feito pelo agente', async () => {
    const { fake, rest } = harness(seed());
    const task = tasksFor(rest).find((t) => t.name === SUPPLIER_DRAFT_TASK);
    const { requests } = await task!.pending(db);
    expect(requests.map((r) => r.key)).toEqual(['return_note:7']);
    const output = await task!.run(requests[0]!.input as SupplierDraftInput, fakeAsk(GOOD_TEXT));
    expect(output).toEqual({ requestId: 1, status: 'draft' });
    const [row] = fake.rows('outbox_supplier_emails');
    expect(row).toMatchObject({ status: 'draft', recipient: SUPPLIER_EMAIL, queue_id: 7, supplier_id: 'F02' });
    expect((row?.history as { by: string }[])[0]?.by).toBe('agente');
  });

  it('com o rascunho feito, a devolução não volta à lista da tarefa; o rascunho nunca emite nota nem envia', async () => {
    const { fake, rest } = harness(seed());
    const task = tasksFor(rest).find((t) => t.name === SUPPLIER_DRAFT_TASK)!;
    await task.run({ queueId: 7 }, fakeAsk(GOOD_TEXT));
    expect((await task.pending(db)).requests).toEqual([]);
    expect(fake.rows('issued_return_notes')).toEqual([]);
    expect(fake.rows('outbox_return_notes')[0]?.status).toBe('pendente');
  });

  it('a rodada do Cron sem credencial do Claude não faz nenhum pedido ao banco e não grava rascunho', async () => {
    const { fake, rest } = harness(seed());
    const lines: string[] = [];
    const round = await runClaudeRound(rest, {}, { log: (l) => lines.push(l) });
    expect(round.ran).toBe(false);
    expect(fake.requests).toEqual([]);
    expect(fake.rows('outbox_supplier_emails')).toEqual([]);
  });
});
