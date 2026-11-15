// #156 O tick abre os pedidos ao fornecedor depois dos passos existentes e o Claude os escreve.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tick } from '../../src/cron/tick.js';
import { buildWorld, decide, goodBody, E2_NUMBER, ENV } from '../supplier-requests/http-world.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Sent = { tools?: { input_schema?: { required?: string[] } }[] };

/** O fetch do Worker no teste: o PostgREST falso e, para o pedido ao fornecedor, o Claude falso; qualquer outra tarefa do Claude falha. */
function stubFetch(world: Awaited<ReturnType<typeof buildWorld>>, code: string, claudeCalls: { n: number }) {
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    if (input.startsWith('https://api.anthropic.com')) {
      claudeCalls.n += 1;
      const sent = JSON.parse(String(init?.body)) as Sent;
      const writes = sent.tools?.some((t) => t.input_schema?.required?.includes('body'));
      if (!writes) return new Response('{}', { status: 500 });
      return Response.json({ content: [{ type: 'tool_use', id: 'tu', name: 'responder', input: { body: goodBody(code) } }] });
    }
    return world.fake.fetch(input, init);
  });
}

describe('#156 tick: pedido ao fornecedor', () => {
  it('abre e escreve os pedidos das propostas decididas, depois dos passos existentes', async () => {
    const world = await buildWorld();
    const { item } = decide(world.fake, 'E2', E2_NUMBER, 40);
    const claude = { n: 0 };
    stubFetch(world, String(item.supplierCode), claude);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await tick({ cron: '*/15 * * * *' }, { ...ENV, BARTE_ACADEMY_CLAUDE_CODE_OAUTH_TOKEN: 'tok_fake' });
    expect(world.fake.rows('supplier_requests')).toMatchObject([{ status: 'draft', request_type: 'return_note' }]);
  });

  it('sem credencial do Claude só abre: o pedido segue escrevendo e nenhuma chamada sai', async () => {
    const world = await buildWorld();
    const { item } = decide(world.fake, 'E2', E2_NUMBER, 40);
    const claude = { n: 0 };
    stubFetch(world, String(item.supplierCode), claude);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await tick({ cron: '*/15 * * * *' }, ENV);
    expect(world.fake.rows('supplier_requests')).toMatchObject([{ status: 'writing' }]);
    expect(claude.n).toBe(0);
  });

  it('um erro no passo do pedido não derruba a rodada: o log não leva o texto do erro nem o segredo', async () => {
    const world = await buildWorld();
    decide(world.fake, 'E2', E2_NUMBER, 40);
    vi.stubGlobal('fetch', (input: string, init?: RequestInit) =>
      input.includes('/rest/v1/supplier_requests') ? Promise.resolve(new Response('{"message":"SEGREDO-DO-PROVEDOR"}', { status: 500 })) : world.fake.fetch(input, init),
    );
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(' ')));
    await expect(tick({ cron: '*/15 * * * *' }, ENV)).resolves.not.toBeNull();
    const text = logs.join('\n');
    // #156 A falha do caso fica isolada e contada; a rodada segue e registra a linha do passo.
    expect(text).toContain('pedidos ao fornecedor abertos 0');
    expect(text).toContain('com falha 1');
    expect(text).not.toContain('SEGREDO-DO-PROVEDOR');
    expect(text).not.toContain('sb_secret_fake');
  });
});
