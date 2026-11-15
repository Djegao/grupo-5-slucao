// #156: as portas do pedido ao fornecedor montadas sobre um cliente PostgREST: o que o Worker e o Cron compõem.
import type { SupabaseRest } from '../connectors/supabase-rest.js';
import { selectSupplierEmail } from './email-sender.js';
import type { Clock, IdGenerator, SupplierRequestDeps } from './ports.js';
import { supabaseSupplierDirectory } from './supabase-directory.js';
import { supabaseReturnNoteEmissions } from './supabase-emissions.js';
import { supabaseSupplierEmailSender } from './supabase-email-sender.js';
import { supabaseReturnNoteWorkQueue } from './supabase-queue.js';
import { supabaseSupplierRequestRepository } from './supabase-requests.js';
import { supabaseDecidedProposalSource } from './supabase-source.js';

export type SupabaseSupplierRequestOptions = {
  /** #156: o CNPJ da Já Chegou, o emitente da nota de devolução. */
  readonly issuerCnpj: string;
  /** #156/AC-5: a chave do Resend; sem ela, ou enquanto o Resend não existe, o canal é o mock. */
  readonly resendApiKey?: string | null;
  readonly log: (line: string) => void;
  /** #156: valores que nunca podem aparecer no log. */
  readonly secrets?: readonly string[];
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
};

/** #156: o repositório tem estado por instância (a `version` lida); monte as dependências uma vez por requisição ou rodada. */
export function supabaseSupplierRequestDeps(rest: SupabaseRest, options: SupabaseSupplierRequestOptions): SupplierRequestDeps {
  const { channel, sender } = selectSupplierEmail(
    { resendApiKey: options.resendApiKey ?? null },
    { mock: supabaseSupplierEmailSender(rest) },
  );
  return {
    requests: supabaseSupplierRequestRepository(rest),
    emissions: supabaseReturnNoteEmissions(rest),
    queue: supabaseReturnNoteWorkQueue(rest),
    sender,
    directory: supabaseSupplierDirectory(rest),
    source: supabaseDecidedProposalSource(rest),
    clock: options.clock ?? { now: () => new Date() },
    ids: options.ids ?? { next: () => crypto.randomUUID() },
    config: { issuerCnpj: options.issuerCnpj, channel },
    log: options.log,
    ...(options.secrets ? { secrets: options.secrets } : {}),
  };
}
