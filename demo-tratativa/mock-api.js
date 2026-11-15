// #156 API falsa do pedido ao fornecedor, em memória, para a demonstração rodar sem o Worker nem o Access.
// Segue o contrato de api/src/http/supplier-requests.ts: as mesmas rotas, os mesmos status e o mesmo formato de
// `SupplierRequestView`. Dados fictícios (o exemplo da issue: NF 20046, Higiene Total Ltda., E2).

export const DEMO_KEY = '35261112345678000190550010000200461000200468';

const ME = 'analista@jachegou.test';
const SYSTEM = 'system';

const clone = (value) => JSON.parse(JSON.stringify(value));
const now = () => new Date().toISOString();

const TEMPLATE =
  'Olá, equipe da Higiene Total.\n\n' +
  'Na NF {{nota.numero}} veio {{item.descricao}} ({{item.quantidade}}, {{devolucao.total}}) no lugar do item pedido. ' +
  'Vamos devolver essa mercadoria com a nota de devolução em anexo.\n\n' +
  'Pedimos que retirem o item trocado e entreguem o item pedido até {{prazo}}.\n\n' +
  'Obrigado,\nRecebimento · Já Chegou';

const VALUES = {
  'nota.numero': '20046',
  'item.descricao': 'Shampoo 350 ml',
  'item.quantidade': '40 UN',
  'devolucao.total': 'R$ 2.163,20',
  prazo: '18/11',
};

export function render(template) {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, key) => (key in VALUES ? VALUES[key] : whole));
}

const DRAFT_ITEMS = [
  {
    supplierCode: 'F11-007',
    sku: 'SKU-2207',
    description: 'Shampoo 350 ml',
    quantity: { amount: 40, unit: 'UN' },
    unitPriceCents: 5408,
    valueCents: 216320,
  },
];

function baseRequest(id, status) {
  const created = now();
  return {
    id,
    invoiceAccessKey: DEMO_KEY,
    supplierId: 'F11',
    requestType: 'return_note',
    status,
    to: 'fiscal@higienetotal.test',
    subject: 'NF 20046 · devolução do item trocado',
    asks: ['Retirar o item trocado', 'Entregar o item pedido'],
    body: status === 'writing' ? null : render(TEMPLATE),
    template: status === 'writing' ? null : TEMPLATE,
    dueOn: '2026-11-18',
    channel: 'mock',
    model: status === 'writing' ? null : 'claude-sonnet-5-5',
    draftedAt: status === 'writing' ? null : created,
    createdAt: created,
    createdBy: SYSTEM,
    updatedAt: created,
    updatedBy: SYSTEM,
    editedAt: null,
    editedBy: null,
    sentAt: null,
    sentBy: null,
    providerMessageId: null,
    sendFailure: null,
    discardedAt: null,
    discardedBy: null,
    discardReason: null,
    attachments: [],
    returnNote: { state: 'draft', items: clone(DRAFT_ITEMS), totalCents: 216320 },
  };
}

function emittedNote() {
  return {
    nota_id: 'ND-0012',
    chave: '35261100000000000000550010000000121000000125',
    numero: 12,
    serie: 1,
    emitente: '00.000.000/0000-00',
    fornecedor_id: 'F11',
    destino: 'LJ-004',
    data_emissao: now().slice(0, 10),
    nota_referenciada: DEMO_KEY,
    natureza: 'devolucao',
    itens: [
      {
        codigo_fornecedor: 'F11-007',
        sku: 'SKU-2207',
        descricao: 'Shampoo 350 ml',
        quantidade: 40,
        unidade: 'UN',
        preco_unitario: 54.08,
        valor: 2163.2,
      },
    ],
    valor_total: 2163.2,
  };
}

const json = (status, body) => ({ status, body });
const conflict = (reason) => json(409, { error: 'conflict', reason });

/**
 * Cria a API falsa. `scenario` escolhe como a demo começa:
 *   'draft' (padrão) · 'writing' · 'empty' · 'send-fails' (o primeiro envio falha) · 'system-discard'.
 * `writingMs`: em 'writing', quanto tempo até o "Claude" terminar o rascunho.
 */
export function createMockApi({ scenario = 'draft', writingMs = 6000 } = {}) {
  let seq = 1;
  let failNextSend = scenario === 'send-fails';
  const requests = [];
  const writingSince = new Map();

  const start = (status) => {
    const r = baseRequest(`pf_${String(seq++).padStart(4, '0')}`, status);
    if (status === 'writing') writingSince.set(r.id, Date.now());
    requests.push(r);
    return r;
  };

  if (scenario === 'draft' || scenario === 'send-fails') start('draft');
  if (scenario === 'writing') start('writing');
  if (scenario === 'system-discard') {
    const r = start('draft');
    Object.assign(r, {
      status: 'discarded',
      body: null,
      template: null,
      discardedAt: now(),
      discardedBy: SYSTEM,
      discardReason: 'number_mismatch',
    });
  }

  // O "Cron": um pedido escrevendo vira rascunho depois de `writingMs`.
  const tick = () => {
    for (const r of requests) {
      if (r.status !== 'writing') continue;
      if (Date.now() - (writingSince.get(r.id) ?? 0) < writingMs) continue;
      Object.assign(r, {
        status: 'draft',
        template: TEMPLATE,
        body: render(TEMPLATE),
        model: 'claude-sonnet-5-5',
        draftedAt: now(),
        updatedAt: now(),
        updatedBy: SYSTEM,
      });
    }
  };

  const find = (id) => requests.find((r) => r.id === id);
  const touch = (r) => Object.assign(r, { updatedAt: now(), updatedBy: ME });

  const send = (r) => {
    if (failNextSend) {
      failNextSend = false;
      Object.assign(r, { status: 'send_failed', sendFailure: 'send_error' });
    } else {
      Object.assign(r, {
        status: 'sent',
        sendFailure: null,
        sentAt: now(),
        sentBy: ME,
        providerMessageId: `mock_${r.id}`,
      });
    }
    touch(r);
    return json(200, { status: r.status, request: clone(r), note: clone(r.returnNote.note) });
  };

  const actions = {
    editar(r, body) {
      if (r.status !== 'draft') return conflict('wrong_state');
      const text = typeof body.text === 'string' ? body.text : '';
      if (!text.trim()) return json(422, { error: 'invalid', reason: 'O texto não pode ficar vazio.' });
      const keys = (t) => (t.match(/\{\{\s*[\w.]+\s*\}\}/g) ?? []).map((k) => k.replace(/\s/g, '')).sort().join('|');
      if (keys(text) !== keys(r.template)) {
        return json(422, { error: 'invalid', reason: 'Os números entre {{chaves}} não podem mudar.' });
      }
      Object.assign(r, { template: text, body: render(text), editedAt: now(), editedBy: ME });
      touch(r);
      return json(200, { request: clone(r) });
    },
    'emitir-e-enviar'(r) {
      if (r.status !== 'draft') return conflict('wrong_state');
      const note = emittedNote();
      r.returnNote = { state: 'emitted', note };
      r.attachments = [{ kind: 'return_note', returnNoteId: note.nota_id, filename: `nota-devolucao-${note.nota_id}.pdf` }];
      return send(r);
    },
    reenviar(r) {
      if (r.status !== 'send_failed') return conflict('wrong_state');
      return send(r);
    },
    descartar(r, body) {
      if (!['writing', 'draft', 'send_failed'].includes(r.status)) return conflict('wrong_state');
      const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 500) : 'discarded_by_user';
      Object.assign(r, { status: 'discarded', discardedAt: now(), discardedBy: ME, discardReason: reason });
      touch(r);
      return json(200, { request: clone(r) });
    },
    refazer(r) {
      if (r.status !== 'discarded') return conflict('wrong_state');
      if (requests.some((x) => ['writing', 'draft', 'send_failed'].includes(x.status))) return conflict('open_request_exists');
      const fresh = start('writing');
      fresh.createdBy = ME;
      return json(200, { request: clone(fresh) });
    },
  };

  /** Mesma assinatura do cliente de verdade: (method, path, body) → { status, body }. */
  async function call(method, path, body = {}) {
    await new Promise((resolve) => setTimeout(resolve, 350)); // a demo mostra o "em andamento"
    tick();
    const url = new URL(path, 'http://demo.local');
    if (url.pathname === '/me') return json(200, { email: ME });
    if (url.pathname === '/api/pedidos-fornecedor') {
      if (method !== 'GET') return json(405, { error: 'method_not_allowed' });
      const nota = url.searchParams.get('nota') ?? '';
      if (!/^\d{44}$/.test(nota)) return json(400, { error: 'invalid_nota' });
      const list = scenario === 'empty' || nota !== DEMO_KEY ? [] : requests;
      return json(200, { requests: clone(list) });
    }
    const match = url.pathname.match(/^\/api\/pedidos-fornecedor\/([^/]+)\/([a-z-]+)$/);
    if (!match || !actions[match[2]]) return json(404, { error: 'not_found' });
    if (method !== 'POST') return json(405, { error: 'method_not_allowed' });
    const r = find(match[1]);
    if (!r) return json(404, { error: 'not_found' });
    return actions[match[2]](r, body ?? {});
  }

  return { call };
}
