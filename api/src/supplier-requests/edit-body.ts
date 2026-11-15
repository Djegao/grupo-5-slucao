// #156/AC-7: a pessoa edita só o texto do e-mail.
import { DomainError } from '../domain/index.js';
import type { SupplierRequestDeps } from './ports.js';
import { NOT_FOUND, conflict, type EditBodyResult } from './results.js';
import { catalogOf, loadPlanned, persist } from './shared.js';

/** #156/AC-7: só em rascunho; número solto, marcador trocado ou texto vazio é `invalid` e nada muda. */
export async function editBody(
  deps: SupplierRequestDeps,
  requestId: string,
  text: string,
  by: string,
): Promise<EditBodyResult> {
  const request = await deps.requests.findById(requestId);
  if (!request) return NOT_FOUND;
  if (request.status !== 'draft' || request.dueOn === null) return conflict('wrong_state');
  const planned = await loadPlanned(deps, request.invoiceAccessKey);
  if (!planned) return conflict('no_longer_qualifies');
  const expected = request.updatedAt;
  try {
    request.editBody(text, catalogOf(planned, request.dueOn), by, deps.clock.now().toISOString());
  } catch (error) {
    // #156: a mensagem é do domínio, nossa; não carrega texto de dependência.
    if (error instanceof DomainError) return { kind: 'invalid', reason: error.message };
    throw error;
  }
  if (!(await persist(deps, request, expected))) return conflict('stale');
  return { kind: 'ok', request: request.snapshot() };
}
