// #156 Página "Tratativa com o fornecedor" (demonstração). Segue o wireframe aprovado: a analista cola a chave da
// nota, a página mostra o pedido ao fornecedor mais recente e oferece só as ações que o estado permite.
// Com `?mock=1` (ou aberta direto do disco) usa a API falsa de mock-api.js; senão chama o Worker na mesma origem.
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
})();
