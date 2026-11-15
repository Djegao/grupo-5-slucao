import { describe, expect, it } from 'vitest';
import { supplierDeps } from '../../src/supplier/supabase-deps.js';
import { createSupplierUseCases } from '../../src/supplier/use-cases.js';
import { NOW, fakeAsk } from './doubles.js';
import { draftRequest } from '../../src/supplier/draft.js';
import { harness, invoiceRow, queueRow, supplierRow } from './supabase-support.js';

// #12: as portas do pedido ao fornecedor ligadas ao Supabase, do rascunho ao envio, sobre o PostgREST falso.

const seed = () => ({ outbox_return_notes: [queueRow()], invoices: [invoiceRow()], kit_fornecedores: [supplierRow()] });

describe('#12/AC-5 do rascunho ao envio pela caixa de saída mock', () => {
  it('rascunha, emite a nota uma vez, move a fila e envia pelo mock: o pedido guarda o canal e o envio', async () => {
    const { fake, rest } = harness(seed());
    const deps = supplierDeps(rest, { clock: { now: () => NOW } });
    const drafted = await draftRequest(deps, 7, fakeAsk());
    expect(drafted.kind).toBe('ok');
    const result = await createSupplierUseCases(deps).send(1, 'ana@jachegou.example');
    expect(result.kind).toBe('ok');
    expect(fake.rows('issued_return_notes')).toHaveLength(1);
    expect(fake.rows('outbox_return_notes')[0]).toMatchObject({ status: 'emitida', nfe_number: '1', emitted_by: 'ana@jachegou.example' });
    expect(fake.rows('outbox_supplier_emails')[0]).toMatchObject({
      status: 'sent',
      channel: 'mock',
      sent_by: 'ana@jachegou.example',
      issued_return_note_id: 1,
      send_claim: null,
    });
    expect(String(fake.rows('outbox_supplier_emails')[0]?.provider_message_id)).toMatch(/^mock-/);
    expect(fake.rows('outbox_supplier_emails')[0]?.attachments).toEqual([
      { filename: 'ND-1.json', content_type: 'application/json', issued_return_note_id: 1 },
    ]);
  });

  it('o mock não grava na tabela do pedido: o único escritor da linha do pedido é o adaptador do pedido', async () => {
    const { fake, rest } = harness(seed());
    const deps = supplierDeps(rest, { clock: { now: () => NOW } });
    await draftRequest(deps, 7, fakeAsk());
    const before = fake.requests.length;
    await deps.mailer.send({
      invoiceAccessKey: 'k',
      supplierId: 'F02',
      requestType: 'return_note',
      to: 'a@b.test',
      subject: 's',
      body: 'b',
      asks: [],
      attachments: [],
      dueOn: '2026-11-17',
      idempotencyKey: 'x',
    });
    expect(fake.requests.length).toBe(before);
  });

  it('enviar duas vezes seguidas não manda dois e-mails nem emite outra nota', async () => {
    const { fake, rest } = harness(seed());
    const deps = supplierDeps(rest, { clock: { now: () => NOW } });
    await draftRequest(deps, 7, fakeAsk());
    const useCases = createSupplierUseCases(deps);
    await useCases.send(1, 'ana@jachegou.example');
    expect(await useCases.send(1, 'ana@jachegou.example')).toEqual({ kind: 'conflict', reason: 'not_sendable' });
    expect(fake.rows('issued_return_notes')).toHaveLength(1);
  });
});
