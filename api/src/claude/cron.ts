/**
 * A rodada do Claude no Cron do Worker (#171). Falha fechada: sem credencial, com 429, com 401 ou com
 * qualquer erro, conta a falha, registra uma linha sem segredo e devolve. Nada aqui derruba o Cron: sem
 * sugestão gravada, a regra determinística decide sozinha (descriptionMatch e resolveProbableOrder).
 */
import type { SupabaseRest } from '../connectors/supabase-rest.js';
import { ClaudeClient, credentialsFromEnv, type ClaudeEnv, type FetchFn } from './client.js';
import { restDb } from './db.js';
import { runTasks, type RunResult } from './runner.js';
import { tasksFor } from './tasks/index.js';

/**
 * #171 Teto de pedidos por tarefa a cada rodada: vale o menor entre ele e o limite da própria tarefa (runner.ts). Hoje as tarefas
 * #36 trazem o limite delas (api/src/claude/tasks/index.ts e api/src/supplier/draft-task.ts) e o teto só protege uma tarefa nova sem limite.
 * #36 Conta de subrequests da rodada no pior caso, com cada tarefa no limite dela (os 50 do plano gratuito), cada pedido com o que gasta:
 * #36   casamento de descrição e ordem provável (1 pedido cada): 7 leituras + 2 × 1 × 2 (a Messages API e o upsert) = 11
 * #36   rascunho do pedido ao fornecedor (#12, limite 2): 4 leituras + 2 × 5 = 14
 * #36   leitura da resposta (#4, limite 1): 4 leituras + 1 × 8 = 12
 * #36   rascunho da cobrança (#4, limite 1): 3 leituras + 1 × 6 = 9
 * #36   varredura do prazo (SUPPLIER_SWEEP_PER_ROUND = 1, api/src/cron/supplier-sweep.ts): 2 leituras + 1 × 2 = 4
 * #36 Total: 11 + 14 + 12 + 9 + 4 = 50, no limite dos 50 e sem crescer com o que está pendente. O rascunho do #12 fica nos 2 dele. A
 * #36 conta custa o casamento de descrição e a ordem provável irem de 5 para 1 por rodada (o que vai ao relatório da #36).
 */
export const CRON_LIMIT = 2;

/** #171 Orçamento da rodada: o Claude é periférico e a captura é o caminho crítico, então a rodada para cedo. */
export const ROUND_BUDGET_MS = 2 * 60_000;

export type ClaudeRound = { readonly ran: boolean; readonly failedTasks: string[]; readonly failures: number };

export async function runClaudeRound(
  rest: SupabaseRest,
  env: ClaudeEnv,
  options: { readonly fetch?: FetchFn; readonly log?: (line: string) => void } = {},
): Promise<ClaudeRound> {
  const log = options.log ?? ((line: string) => console.log(line));
  const credentials = credentialsFromEnv(env);
  if (!credentials) {
    log('cron: sem credencial do Claude; tarefas do Claude puladas e a regra decide sozinha');
    return { ran: false, failedTasks: [], failures: 0 };
  }
  const client = new ClaudeClient({ credentials, fetch: options.fetch });
  const secrets = [credentials.kind === 'api-key' ? credentials.apiKey : credentials.token, env.BARTE_ACADEMY_SUPABASE_SECRET_KEY ?? ''];
  let result: RunResult = { failedTasks: [] };
  try {
    result = await runTasks({
      db: restDb(rest),
      ask: client.ask,
      tasks: tasksFor(rest),
      log: (line) => log(`cron: ${line}`),
      limit: CRON_LIMIT,
      deadline: Date.now() + ROUND_BUDGET_MS,
      secrets,
    });
  } catch {
    // #171 O erro pode vir do banco ou da rede; o texto não é nosso, fica só o fato.
    log('cron: tarefas do Claude falharam; a regra decide sozinha');
    return { ran: true, failedTasks: ['todas'], failures: client.failures };
  }
  log(`cron: Claude, chamadas ${client.calls}, falhas ${client.failures}, tarefas com falha [${result.failedTasks.join(', ')}]`);
  return { ran: true, failedTasks: result.failedTasks, failures: client.failures };
}
