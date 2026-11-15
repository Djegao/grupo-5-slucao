import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ISSUER_CNPJ, supplierRequestOptionsFromEnv } from '../../src/supplier-requests/config.js';
import { buildWorld, decide, fakeAsk, goodBody, E2_NUMBER, E3_NUMBER, ENV, ANALYST } from './http-world.js';

// #156 O que vem do Env (a chave do Resend e o CNPJ do emitente) e os tetos da rodada do Cron.

afterEach(() => vi.restoreAllMocks());

type View = { id: string; status: string; channel: string; sentBy: string | null };
type Note = { emitente: string };

async function draftedWith(env = ENV) {
  const w = await buildWorld();
  const { key, item } = decide(w.fake, 'E2', E2_NUMBER, 40);
  await w.cron(fakeAsk(goodBody(String(item.supplierCode))), env);
  const list = (await (await w.call(`/api/pedidos-fornecedor?nota=${key}`, 'GET', undefined, env)).json()) as { requests: View[] };
  return { w, request: list.requests[0] as View };
}

describe('#156 Env do pedido ao fornecedor', () => {
  it('#156/AC-5 com RESEND_API_KEY e sem adaptador do Resend o e-mail sai pela caixa mock e a chave não vai ao log', async () => {
    const env = { ...ENV, RESEND_API_KEY: 're_fake_SEGREDO' };
    const lines: string[] = [];
    for (const method of ['log', 'error', 'warn'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void lines.push(args.map((a) => JSON.stringify(a)).join(' ')));
    }
    const { w, request } = await draftedWith(env);
    const res = await w.call(`/api/pedidos-fornecedor/${request.id}/emitir-e-enviar`, 'POST', undefined, env);
    const body = (await res.json()) as { status: string; request: View };
    expect(res.status).toBe(200);
    expect(body.request).toMatchObject({ status: 'sent', channel: 'mock', sentBy: ANALYST });
    expect(w.fake.rows('outbox_supplier_emails')).toHaveLength(1);
    expect(lines.join('\n')).not.toContain('re_fake_SEGREDO');
    expect(supplierRequestOptionsFromEnv(env, () => {}).secrets).toContain('re_fake_SEGREDO');
  });

  it('ISSUER_CNPJ vira o emitente da nota emitida', async () => {
    const env = { ...ENV, ISSUER_CNPJ: '11.222.333/0001-81' };
    const { w, request } = await draftedWith(env);
    const res = await w.call(`/api/pedidos-fornecedor/${request.id}/emitir-e-enviar`, 'POST', undefined, env);
    const body = (await res.json()) as { note: Note };
    expect(body.note.emitente).toBe('11.222.333/0001-81');
  });

  it('ISSUER_CNPJ sem 14 dígitos cai no padrão e avisa no log, sem o valor', () => {
    const lines: string[] = [];
    const options = supplierRequestOptionsFromEnv({ ...ENV, ISSUER_CNPJ: '123-XYZ' }, (line) => lines.push(line));
    expect(options.issuerCnpj).toBe(DEFAULT_ISSUER_CNPJ);
    expect(lines.join('\n')).toContain('ISSUER_CNPJ inválido');
    expect(lines.join('\n')).not.toContain('123-XYZ');
    expect(supplierRequestOptionsFromEnv(ENV, () => {}).issuerCnpj).toBe(DEFAULT_ISSUER_CNPJ);
  });
});

describe('#156 tetos da rodada do Cron', () => {
  it('abre e escreve no máximo um pedido por rodada; o outro sai na rodada seguinte', async () => {
    const w = await buildWorld();
    const e2 = decide(w.fake, 'E2', E2_NUMBER, 40);
    const e3 = decide(w.fake, 'E3', E3_NUMBER, 1);
    const ask = fakeAsk((prompt) => goodBody(String(prompt.includes(String(e3.item.supplierCode)) ? e3.item.supplierCode : e2.item.supplierCode)));
    const first = await w.cron(ask);
    expect(first).toMatchObject({ opened: 1, drafted: 1 });
    expect(w.fake.rows('supplier_requests')).toHaveLength(1);
    const second = await w.cron(ask);
    expect(second.opened).toBe(1);
    expect(w.fake.rows('supplier_requests')).toHaveLength(2);
  });

  it('uma falha ao abrir um caso não impede a escrita do pedido que já espera', async () => {
    const w = await buildWorld();
    const e2 = decide(w.fake, 'E2', E2_NUMBER, 40);
    await w.cron(); // sem Claude: abre só o E2
    expect(w.fake.rows('supplier_requests')).toMatchObject([{ status: 'writing' }]);
    decide(w.fake, 'E3', E3_NUMBER, 1);
    w.broken.add('supplier_contacts'); // a abertura do E3 lança ao ler o e-mail do fornecedor
    const round = await w.cron(fakeAsk(goodBody(String(e2.item.supplierCode))));
    w.broken.clear();
    expect(round).toMatchObject({ opened: 0, drafted: 1, failed: 1 });
    expect(w.fake.rows('supplier_requests')).toMatchObject([{ status: 'draft' }]);
  });
});
