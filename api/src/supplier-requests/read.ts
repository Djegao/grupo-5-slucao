// #156: o que a gaveta lê: os pedidos da nota, o texto cru e o preenchido, e a nota de devolução.
import {
  renderText,
  type ReturnNote,
  type ReturnNoteDraft,
  type SupplierRequest,
  type SupplierRequestSnapshot,
} from '../domain/index.js';
import type { SupplierRequestDeps } from './ports.js';
import { catalogOf, planCase, type PlannedCase } from './shared.js';

export type ReturnNoteView =
  | { readonly state: 'draft'; readonly draft: ReturnNoteDraft }
  | { readonly state: 'emitted'; readonly note: ReturnNote };

export type SupplierRequestView = {
  readonly request: SupplierRequestSnapshot;
  /** #156: o texto como o Claude e a pessoa o escreveram, com os `{{chave}}`; nulo enquanto escreve. */
  readonly template: string | null;
  /** #156: o mesmo texto com os marcadores trocados pelos valores do banco. */
  readonly renderedBody: string | null;
  /** #156: a nota emitida, quando o pedido a anexou; senão o rascunho da regra; nulo sem a decisão. */
  readonly returnNote: ReturnNoteView | null;
};

async function viewOf(deps: SupplierRequestDeps, request: SupplierRequest, planned: PlannedCase | null): Promise<SupplierRequestView> {
  const attached = request.attachments.find((a) => a.kind === 'return_note');
  const emitted = attached ? await deps.emissions.findByNoteId(attached.returnNoteId) : null;
  const returnNote: ReturnNoteView | null = emitted
    ? { state: 'emitted', note: emitted }
    : planned
      ? { state: 'draft', draft: planned.draft }
      : null;
  const template = request.body;
  const renderedBody =
    template !== null && planned && request.dueOn !== null ? renderText(template, catalogOf(planned, request.dueOn)) : null;
  return { request: request.snapshot(), template, renderedBody, returnNote };
}

/** #156: os pedidos da nota, do mais antigo ao mais novo. */
export async function readSupplierRequests(
  deps: SupplierRequestDeps,
  invoiceAccessKey: string,
): Promise<{ readonly requests: SupplierRequestView[] }> {
  const requests = await deps.requests.listByInvoice(invoiceAccessKey);
  if (requests.length === 0) return { requests: [] };
  const decided = await deps.source.find(invoiceAccessKey);
  const planned = decided ? planCase(decided) : null;
  const ordered = [...requests].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { requests: await Promise.all(ordered.map((r) => viewOf(deps, r, planned))) };
}
