// #156 O passo do Cron do pedido ao fornecedor: abre o pedido das propostas decididas e o Claude escreve o texto.
import { ClaudeClient, credentialsFromEnv, type Ask, type FetchFn } from '../claude/client.js';
import { SupabaseRestError, type SupabaseRest } from '../connectors/supabase-rest.js';
import type { Env } from '../env.js';
import { runSupplierRepliesRound, supabaseSupplierReplyDeps, type SupplierRepliesRound } from '../supplier-replies/index.js';
import {
  openForDecided,
  supabaseSupplierRequestDeps,
  supplierRequestOptionsFromEnv,
  writeDrafts,
  type Clock,
  type IdGenerator,
} from '../supplier-requests/index.js';

/**
 * #156 Tetos da rodada. O Worker tem teto de 50 subrequests por invocação (plano gratuito; ver claude/cron.ts), e a
 * captura e a rodada do Claude (#171) já gastam uns 27 antes deste passo, mais o `recordRun` (#211) no fim. A conta
 * deste passo: listar as decididas ~8, mais 1 leitura dos pedidos existentes a cada 50 notas (`listByInvoices`), mais
 * ~5 para abrir um pedido; e escrever um pedido ~10 (ler, dossiê em 7 leituras em paralelo, a Messages API, gravar).
 * Com 1 aberto e 1 escrito por rodada o passo fica em ~24 até 50 notas decididas: o pedido sai em até duas rodadas
 * (30 min), dentro da janela de 24 h. A #157 soma ~4 (atrasados) em toda rodada e, só na rodada em que a #156 não
 * abriu nem escreveu (~10 gastos), mais ~7 para ler uma resposta: o pior caso do passo fica em ~28, e a rodada inteira
 * em ~27 + 28 + o recordRun, abaixo dos 50. Se o volume crescer, o passo vai para um Cron próprio.
 */
export const OPEN_LIMIT = 1;
export const WRITE_LIMIT = 1;

export type SupplierRequestsRound = {
  /** #156/AC-1: pedidos abertos nesta rodada (escrevendo). */
  readonly opened: number;
  /** #156: casos de fora, por motivo (só o motivo e a contagem; nada de chave nem e-mail). */
  readonly skipped: Readonly<Record<string, number>>;
  readonly drafted: number;
  readonly discarded: number;
  /** #156: falhas na abertura (casos ou a varredura inteira) mais as falhas na escrita. */
  readonly failed: number;
  /** #156: o Claude recusou (limite ou credencial) e a escrita parou; o resto fica para a próxima rodada. */
  readonly stopped: boolean;
  /** #156: o Claude escreveu? Falso sem credencial: só abriu. */
  readonly wrote: boolean;
  /** #157: os atrasados marcados e as respostas lidas nesta rodada. */
  readonly replies: SupplierRepliesRound;
};

export type SupplierRequestsRoundOptions = {
  /** #156: o `Ask` do Claude; sem ele, o do Env (setup token ou chave); sem credencial, só abre. */
  readonly ask?: Ask | undefined;
  readonly fetch?: FetchFn;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly log?: (line: string) => void;
};

/**
 * #156/AC-1: abre os pedidos e, com o Claude, escreve os que estão `writing`. Sem credencial do Claude só abre
 * e o pedido espera a próxima rodada. A abertura e a escrita são isoladas uma da outra: se a abertura falha, a
 * escrita roda mesmo assim. Um erro da escrita sobe, e quem chama (o tick) o isola.
 */
export async function runSupplierRequestsRound(
  rest: SupabaseRest,
  env: Env,
  options: SupplierRequestsRoundOptions = {},
): Promise<SupplierRequestsRound> {
  const log = options.log ?? ((line: string) => console.log(`cron: ${line}`));
  const deps = supabaseSupplierRequestDeps(rest, {
    ...supplierRequestOptionsFromEnv(env, log),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.ids ? { ids: options.ids } : {}),
  });
  let opened = 0;
  let failed = 0;
  const skipped: Record<string, number> = {};
  try {
    const result = await openForDecided(deps, { limit: OPEN_LIMIT });
    opened = result.opened.length;
    failed += result.failed;
    for (const { reason } of result.skipped) skipped[reason] = (skipped[reason] ?? 0) + 1;
  } catch (error) {
    failed += 1;
    const status = error instanceof SupabaseRestError ? `HTTP ${error.status}` : 'falha no passo';
    log(`abertura dos pedidos ao fornecedor indisponível (${status}); a escrita segue`);
  }
  const credentials = credentialsFromEnv(env);
  const ask = options.ask ?? (credentials ? new ClaudeClient({ credentials, fetch: options.fetch }).ask : undefined);
  // #157 Por causa do teto de subrequests, a rodada cuida das respostas só quando não abriu nem escreveu nada.
  let written: Awaited<ReturnType<typeof writeDrafts>> | null = null;
  if (ask) written = await writeDrafts(deps, ask, { limit: WRITE_LIMIT });
  else log('sem credencial do Claude; pedidos ao fornecedor abertos e o texto fica para a próxima rodada');
  const wroteSomething = written !== null && written.drafted + written.discarded + written.failed + written.skipped > 0;
  // #157 Os atrasados (sem Claude, ~4 subrequests) rodam sempre; a leitura com o Claude só quando a #156 não abriu nem escreveu.
  const replies = await repliesRound(rest, env, options, log, opened === 0 && !wroteSomething ? ask : undefined);
  return {
    opened,
    skipped,
    drafted: written?.drafted ?? 0,
    discarded: written?.discarded ?? 0,
    failed: failed + (written?.failed ?? 0),
    stopped: written?.stopped ?? false,
    wrote: written !== null,
    replies,
  };
}

/** #157 A resposta do fornecedor: atrasados sem Claude e a leitura de até 1 resposta com ele. Erro fica isolado. */
async function repliesRound(
  rest: SupabaseRest,
  env: Env,
  options: SupplierRequestsRoundOptions,
  log: (line: string) => void,
  ask: Ask | undefined,
): Promise<SupplierRepliesRound> {
  const deps = supabaseSupplierReplyDeps(rest, {
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.ids ? { ids: options.ids } : {}),
    log,
    secrets: supplierRequestOptionsFromEnv(env, log).secrets ?? [],
  });
  try {
    return await runSupplierRepliesRound(deps, ask);
  } catch (error) {
    const status = error instanceof SupabaseRestError ? `HTTP ${error.status}` : 'falha no passo';
    log(`respostas do fornecedor indisponíveis (${status})`);
    return { overdue: 0, read: 0, failed: 1, wrote: false };
  }
}
