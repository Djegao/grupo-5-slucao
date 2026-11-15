import { describe, expect, it } from 'vitest';
import { returnNotePdf, returnNotePdfBase64 } from '../../src/supplier-requests/return-note-pdf.js';
import { buildWorld, decide, fakeAsk, goodBody, E2_NUMBER } from './http-world.js';

// #156/AC-5 A nota de devolução vai anexa ao e-mail em JSON e num PDF simples.

const NOTE = {
  nota_id: 'ND-0012',
  chave: '35261100000000000000550010000000121000000125',
  numero: 12,
  serie: 1,
  emitente: '00.000.000/0000-00',
  fornecedor_id: 'F11',
  destino: 'LJ-004',
  data_emissao: '2026-11-16',
  nota_referenciada: '35261112345678000190550010000200461000200468',
  natureza: 'devolucao',
  itens: [
    { codigo_fornecedor: 'F11-007', sku: 'SKU-2207', descricao: 'Shampoo (350 ml) ação', quantidade: 40, unidade: 'UN', preco_unitario: 54.08, valor: 2163.2 },
  ],
  valor_total: 2163.2,
} as Parameters<typeof returnNotePdf>[0];

describe('#156/AC-5 PDF da nota de devolução', () => {
  it('é um PDF de uma página com a nota, os itens e o total, e o xref aponta para os objetos', () => {
    const pdf = returnNotePdf(NOTE);
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(pdf).toContain('(Nota de devolu\\347\\343o ND-0012)');
    expect(pdf).toContain('Shampoo \\(350 ml\\) a\\347\\343o');
    expect(pdf).toContain('R$ 2.163,20');
    const startxref = Number(pdf.match(/startxref\n(\d+)/)?.[1]);
    expect(pdf.slice(startxref, startxref + 4)).toBe('xref');
    const offsets = [...pdf.matchAll(/(\d{10}) 00000 n /g)].map((m) => Number(m[1]));
    expect(offsets).toHaveLength(5);
    offsets.forEach((offset, i) => expect(pdf.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
    expect(atob(returnNotePdfBase64(NOTE))).toBe(pdf);
  });

  it('o e-mail enviado leva o JSON e o PDF da nota emitida', async () => {
    const w = await buildWorld();
    const { key, item } = decide(w.fake, 'E2', E2_NUMBER, 40);
    await w.cron(fakeAsk(goodBody(String(item.supplierCode))));
    const list = (await (await w.call(`/api/pedidos-fornecedor?nota=${key}`)).json()) as { requests: { id: string }[] };
    await w.call(`/api/pedidos-fornecedor/${list.requests[0]?.id}/emitir-e-enviar`, 'POST');
    const [mail] = w.fake.rows('outbox_supplier_emails');
    const files = mail?.attachments as { filename: string; contentType: string; content: string; encoding?: string }[];
    expect(files.map((f) => f.contentType)).toEqual(['application/json', 'application/pdf']);
    const pdf = files[1]!;
    expect(pdf).toMatchObject({ filename: expect.stringMatching(/^nota-devolucao-ND-.*\.pdf$/), encoding: 'base64' });
    expect(atob(pdf.content).startsWith('%PDF-1.4')).toBe(true);
  });
});
