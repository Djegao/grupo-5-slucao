// #156 Página "Tratativa com o fornecedor" (demonstração). Segue o wireframe aprovado: a analista cola a chave da
// nota, a página mostra o pedido ao fornecedor mais recente e oferece só as ações que o estado permite.
// Com `?mock=1` (ou aberta direto do disco) usa a API falsa de mock-api.js; senão chama o Worker na mesma origem.
// #157 Segunda vista, "Pedidos ao fornecedor" (aba no topo ou `?vista=lista`): os pedidos enviados por status, a
// conversa de cada um e o próximo passo (confirmar o documento citado ou cobrar), sempre com o clique de uma pessoa.
// A cobrança sai com o texto que a pessoa revisou (para, assunto e o que pedimos ficam travados); a resposta a quem
// pediu informação é escrita por ela; e só ela encerra o caso.
import { createMockApi, DEMO_KEY } from './mock-api.js';

const params = new URLSearchParams(location.search);
const useMock = params.has('mock') || location.protocol === 'file:';
const mock = useMock ? createMockApi({ scenario: params.get('cenario') ?? 'draft' }) : null;

async function api(method, path, body) {
  if (mock) return mock.call(method, path, body);
  const response = await fetch(path, {
    method,
    credentials: 'include',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = {};
  try {
    json = await response.json();
  } catch {
    /* corpo vazio ou não JSON: fica {} */
  }
  return { status: response.status, body: json };
}

// ---------- textos ----------

const CONFLICT = {
  wrong_state: 'O pedido mudou de estado. Veja a situação atual abaixo.',
  stale: 'Outra pessoa alterou o pedido. Recarregamos a versão atual; refaça a ação se ainda valer.',
  open_request_exists: 'Esta nota já tem um pedido aberto.',
  no_longer_qualifies: 'A decisão desta nota mudou e ela não pede mais devolução.',
  no_supplier_email: 'O fornecedor não tem e-mail no cadastro.',
  queue_mismatch: 'O valor da nota não bate com a fila de devoluções. Fale com o fiscal.',
  queue_not_pending: 'A devolução na fila do fiscal não está mais pendente.',
};

const SYSTEM_DISCARD = {
  number_mismatch: 'O Claude escreveu um número que não bate com o banco; o rascunho foi descartado.',
  invalid_shape: 'O Claude não devolveu o texto no formato esperado; o rascunho foi descartado.',
};

const SEND_FAILURE = { send_error: 'o provedor de e-mail recusou o envio' };

const BUSY_LABEL = {
  'emitir-e-enviar': 'Emitindo e enviando…',
  reenviar: 'Enviando…',
  descartar: 'Descartando…',
  refazer: 'Refazendo…',
  editar: 'Salvando…',
};

// ---------- formatação ----------

const brl = (cents) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const reais = (value) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dayMonth = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '');
const hourMinute = (iso) =>
  iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }) : '';
const esc = (text) =>
  String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- estado ----------

const state = {
  me: null,
  key: '',
  phase: 'idle', // idle | loading | empty | not_found | offline | auth | ready
  requests: [],
  editing: false,
  draftText: '',
  busy: null,
  notice: null, // { kind: 'error' | 'info', text }
  showNote: false,
  pollTimer: null,
};

const $ = (id) => document.getElementById(id);
const current = () => state.requests[state.requests.length - 1] ?? null;
const who = (email) => (email === state.me ? 'você' : email === 'system' ? 'o sistema' : email);

// ---------- carregar ----------

async function load({ quiet = false } = {}) {
  clearTimeout(state.pollTimer);
  if (!/^\d{44}$/.test(state.key)) {
    state.notice = { kind: 'error', text: 'A chave tem 44 dígitos.' };
    return draw();
  }
  if (!quiet) {
    state.phase = 'loading';
    state.notice = null;
    draw();
  }
  let res;
  try {
    res = await api('GET', `/api/pedidos-fornecedor?nota=${state.key}`);
  } catch {
    state.phase = 'offline';
    return draw();
  }
  if (res.status === 200) {
    state.requests = res.body.requests ?? [];
    state.phase = state.requests.length ? 'ready' : 'empty';
    if (current()?.status === 'writing') state.pollTimer = setTimeout(() => load({ quiet: true }), 5000);
  } else if (res.status === 401 || res.status === 403) {
    state.phase = 'auth';
  } else if (res.status >= 500) {
    state.phase = 'offline';
  } else {
    state.phase = 'not_found';
  }
  draw();
}

async function act(action, body) {
  const request = current();
  if (!request || state.busy) return;
  state.busy = action;
  state.notice = null;
  draw();
  let res;
  try {
    res = await api('POST', `/api/pedidos-fornecedor/${request.id}/${action}`, body ?? {});
  } catch {
    res = { status: 0, body: {} };
  }
  state.busy = null;

  if (res.status === 200) {
    if (action === 'editar') state.editing = false;
    if (res.body.status === 'send_failed') {
      state.notice = { kind: 'error', text: 'A nota foi emitida, mas o e-mail não saiu. Você pode tentar enviar de novo.' };
    }
    return load({ quiet: true });
  }
  if (res.status === 422) {
    state.notice = { kind: 'error', text: `O texto não foi salvo: ${res.body.reason ?? 'texto inválido'}.` };
    return draw(); // fica na edição com o texto da pessoa
  }
  if (res.status === 409) {
    state.editing = false;
    state.notice = { kind: 'error', text: CONFLICT[res.body.reason] ?? 'O pedido mudou. Veja a situação atual abaixo.' };
    return load({ quiet: true });
  }
  if (res.status === 404) {
    state.editing = false;
    state.notice = { kind: 'error', text: 'Este pedido não existe mais.' };
    return load({ quiet: true });
  }
  if (res.status === 401 || res.status === 403) {
    state.phase = 'auth';
    return draw();
  }
  // rede ou 5xx: a ação pode ter acontecido; o backend é idempotente, então confere antes de liberar de novo.
  state.editing = false;
  state.notice = { kind: 'info', text: 'A ação pode ter sido feita. Conferindo o estado…' };
  draw();
  return load({ quiet: true });
}

// ---------- desenhar ----------

function draw() {
  $('me').textContent = state.me ? `você: ${state.me}` : '';
  $('mode').hidden = !useMock;
  $('key').disabled = state.phase === 'loading';
  $('open').disabled = state.phase === 'loading';
  $('count').textContent = `${state.key.length}/44`;

  const notice = $('notice');
  notice.hidden = !state.notice;
  notice.className = `notice ${state.notice?.kind ?? ''}`;
  notice.textContent = state.notice?.text ?? '';

  $('main').innerHTML = page();
}

function page() {
  switch (state.phase) {
    case 'idle':
      return `<p class="muted">Informe a chave de acesso da nota para ver o pedido ao fornecedor.</p>`;
    case 'loading':
      return `<div class="card skeleton" aria-busy="true"><p class="muted">Buscando o pedido…</p></div>`;
    case 'empty':
      return `<div class="card"><p>Esta nota não tem pedido ao fornecedor. Ele só existe para proposta decidida com devolução (E1, E2, E3).</p>
        <p class="muted small">O rascunho sai na rodada automática seguinte à decisão, não num clique.</p></div>`;
    case 'not_found':
      return `<div class="card"><p>Não achamos essa nota.</p><button data-do="reset">Abrir outra nota</button></div>`;
    case 'auth':
      return `<div class="card"><p>Sua sessão expirou: entre de novo.</p><button data-do="reload">Tentar de novo</button></div>`;
    case 'offline':
      return `<div class="card"><p>Não foi possível falar com o servidor.</p><button data-do="reload">Tentar de novo</button></div>`;
    default:
      return noteHeader() + block() + historyList();
  }
}

function noteHeader() {
  const r = current();
  return `<section class="note-header">
    <div><strong>NF ${esc(r.subject.match(/NF (\d+)/)?.[1] ?? '')}</strong> · fornecedor ${esc(r.supplierId)}</div>
    <div class="muted small">Decisão: receber parcial · chave ${esc(r.invoiceAccessKey)}</div>
  </section>`;
}

function block() {
  const r = current();
  const body = {
    writing: writing,
    draft: () => (state.editing ? editing(r) : draft(r)),
    sent: sent,
    send_failed: sendFailed,
    discarded: discarded,
  }[r.status];
  return `<section class="card block" aria-live="polite">
    <header class="block-head"><h2>Pedido ao fornecedor</h2>${r.model || r.status === 'writing' ? '<span class="chip">✦ Claude</span>' : ''}</header>
    ${body ? body(r) : `<p>Estado desconhecido: ${esc(r.status)}</p>`}
  </section>`;
}

function button(action, label, { primary = false, quiet = false } = {}) {
  const busy = state.busy === action;
  const cls = primary ? 'primary' : quiet ? 'quiet' : '';
  return `<button class="${cls}" data-act="${action}" ${state.busy ? 'disabled' : ''}>${busy ? BUSY_LABEL[action] : label}</button>`;
}

function draftNote(rn) {
  if (!rn || rn.state !== 'draft') return '';
  const rows = rn.items
    .map(
      (i) => `<tr><td>${esc(i.description)}</td><td class="num">${i.quantity.amount} ${esc(i.quantity.unit)}</td>
        <td class="num">${brl(i.unitPriceCents)}</td><td class="num">${brl(i.valueCents)} <span title="travado">🔒</span></td></tr>`,
    )
    .join('');
  return `<h3>Nota de devolução <span class="muted small">(rascunho · travada)</span></h3>
    <table><thead><tr><th>Item</th><th class="num">Qtd.</th><th class="num">Preço</th><th class="num">Valor</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td colspan="3">Total da devolução</td><td class="num">${brl(rn.totalCents)} <span title="travado">🔒</span></td></tr></tfoot></table>`;
}

function emailHead(r) {
  return `<div class="meta">Para: ${esc(r.to)} · Prazo: ${dayMonth(r.dueOn)}<br>Assunto: ${esc(r.subject)}</div>`;
}

function asks(r) {
  return `<div class="asks"><span class="muted small">O que pedimos 🔒</span><ul>${r.asks.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></div>`;
}

function writing(r) {
  return `<p class="spin">⟳ O Claude está preparando o pedido…</p>
    <div class="meta">Para: ${esc(r.to)} · Ref.: ${esc(r.subject)}</div>
    ${draftNote(r.returnNote)}
    <div class="actions">${button('descartar', 'Descartar', { quiet: true })}</div>`;
}

function draft(r) {
  const edited = r.editedAt ? `<p class="muted small">Editado por ${esc(who(r.editedBy))} às ${hourMinute(r.editedAt)}</p>` : '';
  return `${draftNote(r.returnNote)}
    <h3>E-mail</h3>${emailHead(r)}
    <pre class="body">${esc(r.body)}</pre>${edited}
    ${asks(r)}
    <p class="muted small">📎 A nota de devolução vai anexa ao emitir; o número dela só nasce na emissão.</p>
    <div class="actions">${button('descartar', 'Descartar', { quiet: true })}<span class="grow"></span>
      <button data-do="edit" ${state.busy ? 'disabled' : ''}>Editar</button>${button('emitir-e-enviar', 'Emitir e enviar', { primary: true })}</div>`;
}

function editing(r) {
  return `${draftNote(r.returnNote)}
    <h3>E-mail <span class="muted small">— editando só o texto</span></h3>${emailHead(r)}
    <textarea id="text" rows="10" ${state.busy ? 'disabled' : ''}>${esc(state.draftText)}</textarea>
    <p class="muted small">Os trechos {{entre chaves}} são os números do banco: não altere. Número, itens e "O que pedimos" ficam travados.</p>
    <div class="actions"><button data-do="cancel" ${state.busy ? 'disabled' : ''}>Cancelar</button><span class="grow"></span>
      ${button('editar', 'Salvar texto', { primary: true })}</div>`;
}

function emitted(r) {
  const note = r.returnNote?.state === 'emitted' ? r.returnNote.note : null;
  if (!note || !state.showNote) return note ? `<button data-do="toggle-note">Ver a nota</button>` : '';
  const rows = note.itens
    .map((i) => `<tr><td>${esc(i.descricao)}</td><td class="num">${i.quantidade} ${esc(i.unidade)}</td><td class="num">${reais(i.preco_unitario)}</td><td class="num">${reais(i.valor)}</td></tr>`)
    .join('');
  return `<button data-do="toggle-note">Esconder a nota</button>
    <table><caption>${esc(note.nota_id)} · série ${note.serie} · emitida em ${dayMonth(note.data_emissao)}</caption>
    <tbody>${rows}</tbody><tfoot><tr><td colspan="3">Total</td><td class="num">${reais(note.valor_total)}</td></tr></tfoot></table>`;
}

function noteId(r) {
  return r.returnNote?.state === 'emitted' ? r.returnNote.note.nota_id : 'de devolução';
}

function sent(r) {
  return `<p class="ok">✔ Nota ${esc(noteId(r))} emitida e enviada por ${esc(who(r.sentBy))} às ${hourMinute(r.sentAt)} · aguardando resposta até ${dayMonth(r.dueOn)}</p>
    ${emitted(r)}
    <p class="muted small">E-mail enviado para ${esc(r.to)}${r.channel === 'mock' ? ' (caixa de teste)' : ''}.</p>
    <pre class="body">${esc(r.body)}</pre>`;
}

function sendFailed(r) {
  const why = SEND_FAILURE[r.sendFailure] ?? r.sendFailure ?? 'motivo desconhecido';
  return `<p class="warn">⚠ A nota ${esc(noteId(r))} foi emitida, mas o e-mail não saiu: ${esc(why)}.<br>
    Nenhuma nova nota será emitida ao tentar de novo. Descartar não cancela a nota já emitida.</p>
    ${emitted(r)}
    <div class="actions">${button('descartar', 'Descartar', { quiet: true })}<span class="grow"></span>${button('reenviar', 'Tentar enviar de novo', { primary: true })}</div>`;
}

function discarded(r) {
  const bySystem = r.discardedBy === 'system';
  const reason = bySystem
    ? SYSTEM_DISCARD[r.discardReason] ?? r.discardReason
    : r.discardReason && r.discardReason !== 'discarded_by_user'
      ? `Motivo: ${r.discardReason}`
      : '';
  return `<p>Pedido descartado por ${esc(who(r.discardedBy))} às ${hourMinute(r.discardedAt)}.</p>
    ${reason ? `<p class="muted">${esc(reason)}</p>` : ''}
    <div class="actions"><span class="grow"></span>${button('refazer', 'Refazer', { primary: true })}</div>`;
}

const STATUS_PT = { writing: 'escrevendo', draft: 'rascunho', sent: 'enviado', send_failed: 'falha no envio', discarded: 'descartado' };

function historyList() {
  const old = state.requests.slice(0, -1);
  if (!old.length) return '';
  const rows = old.map((r) => `<li>${STATUS_PT[r.status] ?? r.status} · ${hourMinute(r.updatedAt)}</li>`).join('');
  return `<details class="history"><summary>Histórico (${old.length})</summary><ul>${rows}</ul></details>`;
}

// ---------- eventos ----------

$('form').addEventListener('submit', (event) => {
  event.preventDefault();
  state.key = $('key').value.replace(/\D/g, '');
  state.editing = false;
  const url = new URL(location.href);
  url.searchParams.set('nota', state.key);
  window.history.replaceState(null, "", url);
  load();
});

$('key').addEventListener('input', () => {
  state.key = $('key').value.replace(/\D/g, '');
  $('count').textContent = `${state.key.length}/44`;
});

$('main').addEventListener('click', (event) => {
  const el = event.target.closest('button');
  if (!el) return;
  const action = el.dataset.act;
  const todo = el.dataset.do;
  if (action === 'editar') return act('editar', { text: $('text').value });
  if (action === 'descartar') {
    if (!confirm('Descartar este pedido ao fornecedor?')) return;
    return act('descartar');
  }
  if (action) return act(action);
  if (todo === 'edit') {
    state.editing = true;
    state.draftText = current().template ?? '';
    return draw();
  }
  if (todo === 'cancel') {
    const changed = $('text').value !== (current().template ?? '');
    if (changed && !confirm('Descartar as mudanças?')) return;
    state.editing = false;
    state.notice = null;
    return draw();
  }
  if (todo === 'toggle-note') {
    state.showNote = !state.showNote;
    return draw();
  }
  if (todo === 'reload') return load();
  if (todo === 'reset') {
    state.phase = 'idle';
    state.key = '';
    $('key').value = '';
    $('key').focus();
    return draw();
  }
});

$('main').addEventListener('input', (event) => {
  if (event.target.id === 'text') state.draftText = event.target.value;
});

// ---------- #157 vista "Pedidos ao fornecedor" ----------

const BUCKETS = [
  ['aguardando', 'Aguardando'],
  ['atendidos', 'Atendidos'],
  ['precisam', 'Precisam de você'],
  ['atrasados', 'Atrasados'],
];

const REQUEST_TYPE = {
  return_note: 'Nota de devolução',
  cancel_invoice: 'Cancelamento da nota',
  deliver_missing: 'Entrega do faltante',
  purchase_order_number: 'Número do pedido',
  registry_data: 'Dados cadastrais',
  notice: 'Aviso',
};

// Só para a demonstração: o `ListItem` traz o código do fornecedor, não o nome.
const SUPPLIER_NAME = { F02: 'Padaria', F03: 'Mercearia', F07: 'Limpeza', F08: 'Embalagens', F09: 'Frios', F11: 'Higiene', F14: 'Hortifruti' };
const supplierName = (id) => (SUPPLIER_NAME[id] ? `${id} ${SUPPLIER_NAME[id]}` : id);

const OUTCOME = {
  fulfilled: 'Atendeu',
  partially_fulfilled: 'Atendeu em parte',
  refused: 'Recusou',
  needs_information: 'Pediu informação',
  no_reply: 'Sem resposta',
};

const NEXT_STEP = {
  close: 'encerrar',
  confirm_document: 'confirmar o documento citado',
  answer_supplier: 'responder ao fornecedor',
  follow_up: 'cobrar o fornecedor',
};

const REPLY_CONFLICT = {
  wrong_state: 'Este passo não vale mais: o pedido mudou. Recarregamos a situação atual.',
  already_done: 'Isso já foi feito, talvez por outra pessoa. Recarregamos a situação atual.',
};

const REPLY_BUSY = {
  'confirmar-documento': 'Confirmando…',
  cobrar: 'Enviando cobrança…',
  responder: 'Enviando resposta…',
  encerrar: 'Encerrando…',
};

const REPLY_DONE = {
  'confirmar-documento': 'Documento confirmado. O pedido foi para Atendidos.',
  cobrar: 'Cobrança enviada. O pedido volta a aguardar a resposta.',
  responder: 'Resposta enviada. O pedido volta a aguardar o fornecedor.',
  encerrar: 'Caso encerrado. O pedido foi para Atendidos.',
};

const TEXT_INVALID = 'O texto não pode ficar vazio nem passar de 5.000 caracteres.';
const MAX_TEXT = 5000;

const when = (iso) => (iso ? `${dayMonth(iso)} às ${hourMinute(iso)}` : '');

const board = {
  phase: 'idle', // idle | loading | ready | offline | auth
  filter: null, // null = todos
  counts: null,
  items: [],
  openId: null,
  openItem: null,
  conv: null, // { phase: 'loading' | 'ready' | 'error', conversation, request }
  reviewing: false, // revisando a cobrança ou escrevendo a resposta
  text: null, // o texto que a pessoa está editando (cobrança ou resposta); sobrevive aos redesenhos
  closeNote: '',
  busy: null,
  notice: null,
};

let view = 'pedido';

function setView(next, { updateUrl = true } = {}) {
  view = next;
  for (const name of ['pedido', 'lista']) {
    $(`tab-${name}`).setAttribute('aria-selected', String(name === next));
    $(`view-${name}`).hidden = name !== next;
  }
  if (updateUrl) {
    const url = new URL(location.href);
    if (next === 'lista') url.searchParams.set('vista', 'lista');
    else url.searchParams.delete('vista');
    window.history.replaceState(null, '', url);
  }
  if (next === 'lista') loadBoard({ quiet: board.phase === 'ready' });
}

async function loadBoard({ quiet = false } = {}) {
  if (!quiet) {
    board.phase = 'loading';
    drawBoard();
  }
  let res;
  try {
    res = await api('GET', `/api/pedidos-fornecedor/lista${board.filter ? `?filtro=${encodeURIComponent(board.filter)}` : ''}`);
  } catch {
    res = { status: 0, body: {} };
  }
  if (res.status === 200) {
    board.phase = 'ready';
    board.counts = res.body.counts ?? null;
    board.items = res.body.items ?? [];
    const fresh = board.items.find((i) => i.id === board.openId);
    if (fresh) board.openItem = fresh;
  } else if (res.status === 400) {
    board.filter = null;
    board.notice = { kind: 'error', text: 'Filtro desconhecido; mostrando todos.' };
    return loadBoard({ quiet });
  } else if (res.status === 401 || res.status === 403) {
    board.phase = 'auth';
  } else {
    board.phase = 'offline';
  }
  drawBoard();
}

async function openRow(id, { review = false } = {}) {
  const item = board.items.find((i) => i.id === id);
  if (!item) return;
  board.openId = id;
  board.openItem = item;
  board.reviewing = review;
  board.text = null;
  board.closeNote = '';
  board.conv = { phase: 'loading' };
  board.notice = null;
  drawBoard();
  await loadConversation();
  $('panel')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function closePanel() {
  board.openId = null;
  board.openItem = null;
  board.conv = null;
  board.reviewing = false;
  board.text = null;
  board.closeNote = '';
}

async function loadConversation() {
  const id = board.openId;
  const item = board.openItem;
  if (!id) return;
  let conv;
  let req = null;
  try {
    [conv, req] = await Promise.all([
      api('GET', `/api/pedidos-fornecedor/${encodeURIComponent(id)}/conversa`),
      api('GET', `/api/pedidos-fornecedor?nota=${encodeURIComponent(item.invoiceAccessKey)}`).catch(() => null),
    ]);
  } catch {
    conv = { status: 0, body: {} };
  }
  if (board.openId !== id) return; // a pessoa abriu outro pedido enquanto carregava
  if (conv.status === 200) {
    const request = req?.status === 200 ? (req.body.requests ?? []).find((r) => r.id === id) ?? null : null;
    board.conv = { phase: 'ready', conversation: conv.body.conversation, request };
  } else if (conv.status === 404) {
    board.notice = { kind: 'error', text: 'Este pedido não existe mais.' };
    closePanel();
  } else if (conv.status === 401 || conv.status === 403) {
    board.phase = 'auth';
  } else {
    board.conv = { phase: 'error' };
  }
  drawBoard();
}

/** O corpo de cada ação: a cobrança e a resposta levam o texto da pessoa; o encerramento, a nota opcional. */
function bodyFor(action) {
  if (action === 'cobrar' || action === 'responder') return board.text === null ? {} : { text: board.text };
  if (action === 'encerrar') return board.closeNote.trim() ? { note: board.closeNote.trim() } : {};
  return {};
}

async function actBoard(action) {
  const id = board.openId;
  if (!id || board.busy) return;
  if (action === 'encerrar' && !window.confirm('Encerrar este caso? Depois disso, nenhuma cobrança ou resposta sai por aqui.')) return;
  const field = $('reply-text');
  if ((action === 'cobrar' || action === 'responder') && field) board.text = field.value;
  if ((action === 'cobrar' || action === 'responder') && board.text !== null) {
    const t = board.text.trim();
    if (!t || t.length > MAX_TEXT) {
      board.notice = { kind: 'error', text: TEXT_INVALID };
      return drawBoard(); // fica na edição com o texto da pessoa
    }
  }
  board.busy = action;
  board.notice = null;
  drawBoard();
  let res;
  try {
    res = await api('POST', `/api/pedidos-fornecedor/${encodeURIComponent(id)}/${action}`, bodyFor(action));
  } catch {
    res = { status: 0, body: {} };
  }
  board.busy = null;

  if (res.status === 422) {
    board.notice = { kind: 'error', text: TEXT_INVALID };
    return drawBoard(); // mantém a revisão aberta e o texto da pessoa
  }
  board.reviewing = false;
  board.text = null;
  if (res.status === 200) board.closeNote = '';

  if (res.status === 200) {
    board.conv = { ...board.conv, phase: 'ready', conversation: res.body.conversation };
    board.notice = { kind: 'info', text: REPLY_DONE[action] ?? 'Feito.' };
    return loadBoard({ quiet: true });
  }
  if (res.status === 409) {
    board.notice = { kind: 'error', text: REPLY_CONFLICT[res.body.reason] ?? 'O pedido mudou. Recarregamos a situação atual.' };
    await loadBoard({ quiet: true });
    return loadConversation();
  }
  if (res.status === 404) {
    board.notice = { kind: 'error', text: 'Este pedido não existe mais.' };
    closePanel();
    return loadBoard({ quiet: true });
  }
  if (res.status === 401 || res.status === 403) {
    board.phase = 'auth';
    return drawBoard();
  }
  // rede ou 5xx: a ação pode ter acontecido (o backend não repete), então confere antes de liberar de novo.
  board.notice = { kind: 'info', text: 'A ação pode ter sido feita. Conferindo o estado…' };
  await loadBoard({ quiet: true });
  return loadConversation();
}

function drawBoard() {
  const notice = $('lista-notice');
  notice.hidden = !board.notice;
  notice.className = `notice ${board.notice?.kind ?? ''}`;
  notice.textContent = board.notice?.text ?? '';
  $('lista').innerHTML = boardPage();
}

function boardPage() {
  switch (board.phase) {
    case 'idle':
    case 'loading':
      return `<div class="card skeleton" aria-busy="true"><p class="muted">Buscando os pedidos enviados…</p></div>`;
    case 'auth':
      return `<div class="card"><p>Sua sessão expirou: entre de novo.</p><button data-board="reload">Tentar de novo</button></div>`;
    case 'offline':
      return `<div class="card"><p>Não foi possível falar com o servidor.</p><button data-board="reload">Tentar de novo</button></div>`;
    default:
      return `<h2 class="list-title">Pedidos ao fornecedor</h2>${chips()}${table()}${panel()}`;
  }
}

const KPI_SUB = { aguardando: 'pedidos no prazo', atendidos: 'fornecedor atendeu', precisam: 'pedem uma decisão sua', atrasados: 'passaram do prazo' };

function chips() {
  const counts = board.counts ?? {};
  const total = BUCKETS.reduce((n, [key]) => n + Number(counts[key] ?? 0), 0);
  // #157 Os cards de números, como os da Fila de aprovação.
  const kpis = BUCKETS.map(
    ([key, label]) =>
      `<div class="kpi" data-kpi="${key}"><span class="k-label"><span class="k-dot"></span>${esc(label)}</span><span class="k-value">${Number(counts[key] ?? 0)}</span><span class="k-sub">${esc(KPI_SUB[key] ?? '')}</span></div>`,
  ).join('');
  // #157 Os filtros em pílula ("Todas" e um por aba) e a busca, como na fila.
  const pills = [`<button class="pill p-all" data-filter="__all" aria-pressed="${board.filter === null}">Todas · ${total}</button>`]
    .concat(BUCKETS.map(([key, label]) => `<button class="pill p-${key}" data-filter="${key}" aria-pressed="${board.filter === key}">${esc(label)} · ${Number(counts[key] ?? 0)}</button>`))
    .join('');
  const search = `<label class="search"><input id="board-search" type="search" placeholder="Buscar nota ou fornecedor" value="${esc(board.query ?? '')}" autocomplete="off" /><i class="ph ph-magnifying-glass" aria-hidden="true"></i></label>`;
  return `<div class="kpis">${kpis}</div><div class="toolbar"><div class="pills" role="group" aria-label="Filtrar por status">${pills}</div>${search}</div>`;
}

/** #157 A busca filtra as linhas já desenhadas, sem redesenhar (o campo não perde o foco). */
function applySearch() {
  const q = (board.query ?? '').trim().toLowerCase();
  for (const tr of document.querySelectorAll('#lista tr[data-search]')) tr.hidden = q !== '' && !tr.dataset.search.includes(q);
}

function table() {
  if (!board.items.length) {
    return `<p class="muted">${board.filter ? 'Nenhum pedido nesta aba.' : 'Nenhum pedido enviado ao fornecedor ainda.'}</p>`;
  }
  const rows = board.items.map(row).join('');
  return `<table class="list">
    <thead><tr><th>Nota fiscal</th><th>Pedido</th><th class="num">Valor</th><th>Prazo</th><th>Status</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

function row(i) {
  const open = i.id === board.openId;
  const search = `${i.invoiceNumber ?? ''} ${supplierName(i.supplierId)} ${i.supplierId}`.toLowerCase();
  const q = (board.query ?? '').trim().toLowerCase();
  return `<tr data-row="${esc(i.id)}" data-search="${esc(search)}" class="${open ? 'open' : ''}"${q && !search.includes(q) ? ' hidden' : ''}>
    <td data-label="Nota fiscal"><button class="link" data-row-open="${esc(i.id)}" aria-expanded="${open}">NF ${esc(i.invoiceNumber ?? '—')}</button><div class="sub">${esc(supplierName(i.supplierId))}</div></td>
    <td data-label="Pedido"><span class="badge b-grey">${esc(REQUEST_TYPE[i.requestType] ?? i.requestType)}</span></td>
    <td data-label="Valor" class="num"><strong>${i.valueCents == null ? '—' : esc(brl(i.valueCents))}</strong></td>
    <td data-label="Prazo">${esc(dayMonth(i.dueOn))}</td>
    <td data-label="Status" class="status">${statusCell(i)}</td>
  </tr>`;
}

function statusCell(i) {
  const l = i.latest;
  const doc = l?.supplierDocument ? `: ${esc(l.supplierDocument)}` : '';
  const badge = (cls, text) => `<span class="badge ${cls}">${text}</span>`;
  let text;
  if (i.closed) text = badge('b-grey', 'Encerrado');
  else if (i.bucket === 'atrasados') {
    text = `${badge('b-err', 'Atrasado')} <button class="small" data-row-cobrar="${esc(i.id)}" ${board.busy ? 'disabled' : ''}>Cobrar</button>`;
  } else if (!l) text = badge('b-info', 'Aguardando resposta');
  else if (i.documentConfirmed || l.nextStep === 'close') text = badge('b-ok', `Atendeu${doc}`);
  else if (l.nextStep === 'confirm_document') text = badge('b-warn', `Atendeu${doc} · confirmar`);
  else if (l.outcome === 'needs_information') text = i.followUpSent ? badge('b-info', 'Respondido · aguardando') : badge('b-purple', 'Pediu informação');
  else if (i.followUpSent) text = badge('b-info', 'Cobrado · aguardando');
  else if (l.outcome === 'refused') text = badge('b-err', 'Recusou');
  else text = badge('b-grey', esc(OUTCOME[l.outcome] ?? l.outcome));
  const flag = l?.injectionFlag ? `<br><span class="flag">⚠ Ordem escondida na resposta</span>` : '';
  return text + flag;
}

function panel() {
  if (!board.openId) return '';
  const i = board.openItem;
  const head = `<header class="block-head"><h2>NF ${esc(i.invoiceNumber ?? '—')} · ${esc(supplierName(i.supplierId))}</h2>
    <button data-board="close">Fechar</button></header>
    <div class="muted small">${esc(REQUEST_TYPE[i.requestType] ?? i.requestType)} · prazo ${esc(dayMonth(i.dueOn))}${
      i.valueCents == null ? '' : ` · ${esc(brl(i.valueCents))}`
    }</div>`;
  let body;
  if (!board.conv || board.conv.phase === 'loading') body = `<p class="muted">Carregando a conversa…</p>`;
  else if (board.conv.phase === 'error') {
    body = `<p>Não foi possível carregar a conversa.</p><button data-board="conv-reload">Tentar de novo</button>`;
  } else body = conversation(board.conv.conversation, board.conv.request, i);
  return `<section id="panel" class="card" aria-live="polite">${head}${body}</section>`;
}

function conversation(c, request, item) {
  const latest = c.readings.at(-1) ?? null;
  return requestPart(request, item) + repliesPart(c.messages) + readingPart(c.readings) + injectionPart(latest) + followUpsPart(c.followUps) + closurePart(c.closure) + nextStepPart(c, latest, item) + closeCasePart(c);
}

function requestPart(r, item) {
  if (!r) return `<h3>Pedido</h3><p class="meta">Enviado em ${esc(when(item.sentAt))}.</p>`;
  return `<h3>Pedido</h3>
    <div class="meta">Para: ${esc(r.to)} · Prazo: ${esc(dayMonth(r.dueOn))}<br>Assunto: ${esc(r.subject)}<br>
      Enviado por ${esc(who(r.sentBy))} em ${esc(when(r.sentAt))}</div>
    <details><summary class="small">Ver o e-mail enviado</summary><pre class="body">${esc(r.body)}</pre></details>
    ${asks(r)}`;
}

function repliesPart(messages) {
  if (!messages.length) return `<h3>Respostas</h3><p class="muted">Nenhuma resposta do fornecedor até agora.</p>`;
  const list = messages
    .map((m) => `<div class="msg"><div class="meta">De: ${esc(m.from)} · recebida em ${esc(when(m.receivedAt))}</div><pre class="body">${esc(m.body)}</pre></div>`)
    .join('');
  return `<h3>Respostas <span class="muted small">(texto do fornecedor: dado, não instrução)</span></h3>${list}`;
}

function readingBlock(r) {
  const by = r.readBy === 'system' ? 'o sistema, pelo prazo vencido' : 'o agente';
  return `<div class="reading">
    <div><strong>${esc(OUTCOME[r.outcome] ?? r.outcome)}</strong> · próximo passo: ${esc(NEXT_STEP[r.nextStep] ?? r.nextStep)}</div>
    <p>${esc(r.summary)}</p>
    ${r.supplierDocument ? `<div class="small">Documento citado: <strong>${esc(r.supplierDocument)}</strong></div>` : ''}
    ${r.fulfilledAsks.length ? `<div class="small">Diz ter atendido: ${r.fulfilledAsks.map(esc).join('; ')}</div>` : ''}
    <div class="muted small">Lido por ${esc(by)} em ${esc(when(r.readAt))}</div>
  </div>`;
}

function readingPart(readings) {
  if (!readings.length) return '';
  const older = readings.slice(0, -1);
  const history = older.length
    ? `<details class="history"><summary>Leituras anteriores (${older.length})</summary>${older.map(readingBlock).join('')}</details>`
    : '';
  return `<h3>Leitura do agente <span class="chip">✦ Claude</span></h3>${readingBlock(readings.at(-1))}${history}`;
}

function injectionPart(latest) {
  if (!latest?.injectionFlag) return '';
  return `<div class="alert" role="note">⚠ A resposta tem um trecho que tenta dar ordem ao agente: <q>${esc(latest.injectionFlag)}</q><br>
    Isso não mudou nada no caso: a decisão, o título e o valor em risco continuam os mesmos.</div>`;
}

function followUpsPart(followUps) {
  if (!followUps.length) return '';
  const block = (f) => `<div class="msg"><div class="meta">${f.kind === 'answer' ? 'Resposta' : 'Cobrança'}: ${esc(f.subject)} · por ${esc(who(f.sentBy))} em ${esc(when(f.sentAt))}</div>
    <pre class="body">${esc(f.body)}</pre></div>`;
  const followUpsSent = followUps.filter((f) => f.kind !== 'answer');
  const answers = followUps.filter((f) => f.kind === 'answer');
  return (
    (followUpsSent.length ? `<h3>Cobranças enviadas</h3>${followUpsSent.map(block).join('')}` : '') +
    (answers.length ? `<h3>Respostas enviadas ao fornecedor</h3>${answers.map(block).join('')}` : '')
  );
}

function closurePart(closure) {
  if (!closure) return '';
  const by = who(closure.closedBy);
  const head = by === 'você' ? `Encerrado por você às ${hourMinute(closure.closedAt)}` : `Encerrado por ${by} em ${when(closure.closedAt)}`;
  return `<p class="ok">■ ${esc(head)}.${closure.note ? `<br><span class="small">Nota: ${esc(closure.note)}</span>` : ''}</p>`;
}

/** Encerrar o caso: a qualquer momento enquanto não está encerrado, sempre por uma pessoa. */
function closeCasePart(c) {
  if (c.closure) return '';
  const busy = board.busy === 'encerrar';
  return `<div class="actions">
    <label class="small grow">Nota ao encerrar (opcional)
      <textarea id="close-note" rows="2" maxlength="500" ${board.busy ? 'disabled' : ''}>${esc(board.closeNote)}</textarea></label>
    <button class="quiet" data-reply-act="encerrar" ${board.busy ? 'disabled' : ''}>${busy ? REPLY_BUSY.encerrar : 'Encerrar caso'}</button>
  </div>`;
}

function editor(id, fallback) {
  const value = board.text ?? fallback;
  return `<textarea id="${id}" rows="10" ${board.busy ? 'disabled' : ''}>${esc(value)}</textarea>
    <div class="muted small">${value.trim().length.toLocaleString('pt-BR')} / 5.000 caracteres</div>`;
}

function replyButton(action, label) {
  const busy = board.busy === action;
  return `<button class="primary" data-reply-act="${action}" ${board.busy ? 'disabled' : ''}>${busy ? REPLY_BUSY[action] : esc(label)}</button>`;
}

function nextStepPart(c, latest, item) {
  if (c.closure) return '';
  if (!latest) {
    return `<p class="muted">Aguardando a resposta do fornecedor até ${esc(dayMonth(item.dueOn))}. Nada a fazer agora.</p>`;
  }
  const confirmation = c.confirmations.find((x) => x.readingId === latest.id);
  if (confirmation) {
    return `<p class="ok">✓ Documento confirmado por ${esc(who(confirmation.confirmedBy))} em ${esc(when(confirmation.confirmedAt))}.</p>`;
  }
  const followUp = c.followUps.find((x) => x.readingId === latest.id);
  if (followUp) {
    const what = followUp.kind === 'answer' ? 'Resposta enviada' : 'Cobrança enviada';
    return `<p class="ok">✓ ${what} por ${esc(who(followUp.sentBy))} em ${esc(when(followUp.sentAt))}. Aguardando a resposta.</p>`;
  }
  if (latest.nextStep === 'confirm_document') {
    const doc = latest.supplierDocument ? `o documento ${esc(latest.supplierDocument)}` : 'o que o fornecedor diz ter feito';
    return `<p class="small">O agente não fecha o "atendeu" sozinho: confira ${doc} antes de confirmar.</p>
      <div class="actions"><span class="grow"></span>${replyButton('confirmar-documento', 'Confirmar documento')}</div>`;
  }
  if (latest.followUpDraft) {
    if (!board.reviewing) {
      return `<div class="actions"><span class="grow"></span><button class="primary" data-board="review" ${board.busy ? 'disabled' : ''}>Cobrar</button></div>`;
    }
    const d = latest.followUpDraft;
    return `<h3>Rascunho da cobrança <span class="muted small">— revise e ajuste o texto antes de enviar</span></h3>
      <div class="meta">Para: ${esc(d.to)} 🔒<br>Assunto: ${esc(d.subject)} 🔒</div>
      <label class="small" for="reply-text">Texto da cobrança</label>
      ${editor('reply-text', d.body)}
      <div class="asks"><span class="muted small">O que pedimos 🔒</span><ul>${d.asks.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></div>
      <div class="actions"><button data-board="cancel-review" ${board.busy ? 'disabled' : ''}>Cancelar</button><span class="grow"></span>
        ${replyButton('cobrar', 'Enviar cobrança')}</div>`;
  }
  if (latest.nextStep === 'answer_supplier') {
    if (!board.reviewing) {
      return `<div class="actions"><span class="grow"></span><button class="primary" data-board="review" ${board.busy ? 'disabled' : ''}>Responder ao fornecedor</button></div>`;
    }
    const r = board.conv.request;
    const lastFrom = c.messages.at(-1)?.from;
    const to = r?.to ?? lastFrom ?? '';
    const subject = r ? `Re: ${r.subject}` : 'Re: o pedido enviado';
    return `<h3>Responder ao fornecedor <span class="muted small">— o texto é seu e só sai com o clique</span></h3>
      <div class="meta">Para: ${esc(to)} 🔒<br>Assunto: ${esc(subject)} 🔒</div>
      <label class="small" for="reply-text">Sua resposta</label>
      ${editor('reply-text', '')}
      <div class="actions"><button data-board="cancel-review" ${board.busy ? 'disabled' : ''}>Cancelar</button><span class="grow"></span>
        ${replyButton('responder', 'Enviar resposta')}</div>`;
  }
  return '';
}

document.querySelector('.tabs').addEventListener('click', (event) => {
  const tab = event.target.closest('button[data-view]');
  if (tab && tab.dataset.view !== view) setView(tab.dataset.view);
});

$('lista').addEventListener('click', (event) => {
  const el = event.target.closest('button');
  if (el) {
    if (el.disabled) return;
    const d = el.dataset;
    if (d.filter) {
      board.filter = d.filter === '__all' || board.filter === d.filter ? null : d.filter;
      board.notice = null;
      return loadBoard({ quiet: true });
    }
    if (d.rowCobrar) return openRow(d.rowCobrar, { review: true });
    if (d.rowOpen) return d.rowOpen === board.openId ? (closePanel(), drawBoard()) : openRow(d.rowOpen);
    if (d.replyAct) return actBoard(d.replyAct);
    if (d.board === 'close') {
      closePanel();
      return drawBoard();
    }
    if (d.board === 'reload') return loadBoard();
    if (d.board === 'conv-reload') {
      board.conv = { phase: 'loading' };
      drawBoard();
      return loadConversation();
    }
    if (d.board === 'review') {
      board.reviewing = true;
      return drawBoard();
    }
    if (d.board === 'cancel-review') {
      board.reviewing = false;
      board.text = null;
      board.notice = null;
      return drawBoard();
    }
    return;
  }
  const tr = event.target.closest('tr[data-row]');
  if (tr && !event.target.closest('#panel')) {
    const id = tr.dataset.row;
    if (id === board.openId) {
      closePanel();
      return drawBoard();
    }
    return openRow(id);
  }
});

// O texto em edição fica no estado: a lista se redesenha inteira depois de cada ação.
$('lista').addEventListener('input', (event) => {
  if (event.target.id === 'reply-text') {
    board.text = event.target.value;
    const counter = event.target.nextElementSibling;
    if (counter) counter.textContent = `${board.text.trim().length.toLocaleString('pt-BR')} / 5.000 caracteres`;
  }
  if (event.target.id === 'close-note') board.closeNote = event.target.value;
  if (event.target.id === 'board-search') {
    board.query = event.target.value;
    applySearch();
  }
});

// ---------- início ----------

(async () => {
  try {
    const me = await api('GET', '/me');
    state.me = me.status === 200 ? me.body.email ?? null : null;
  } catch {
    state.me = null;
  }
  const initial = params.get('nota') ?? (useMock ? DEMO_KEY : '');
  $('key').value = initial;
  state.key = initial.replace(/\D/g, '');
  draw();
  if (state.key) load();
  if (params.get('vista') === 'lista') setView('lista', { updateUrl: false });
})();
