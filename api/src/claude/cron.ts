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
 * #36 Conta de subrequests, com a fila cheia de cada tarefa e cada uma no limite dela (PostgREST + Messages API), medida por
 * #36 api/test/claude/budget.test.ts sobre tasksFor de verdade:
 * #36   casamento de descrição (limite 1): 5 + 1 = 6; ordem provável (limite 1): 11 + 1 = 12; rascunho do #12 (limite 2): 12 + 2 = 14;
 * #36   leitura da resposta (#4, limite 1): 11 + 1 = 12; rascunho da cobrança (#4, limite 1): 8 + 1 = 9; a rodada: 53.
 * #36   varredura do prazo (SUPPLIER_SWEEP_PER_ROUND = 1, api/src/cron/supplier-sweep.ts): 4. Total medido: 57.
 * #36 Os 50 do plano gratuito contam só a rodada do Claude e a varredura, não a invocação inteira: a captura, proposeChecked, as
 * #36 publicações e as notas de devolução gastam subrequests antes (api/src/cron/tick.ts, runRound). Se o Worker publicado de fato roda
 * #36 sob esse limite é pergunta de infraestrutura da pessoa, não do código; a medida de 57 já o passa, e o teste a registra como lacuna.
 * #36 A rodada é de melhor esforço, pelo desenho fail-closed da #171: passado o limite do Worker, um fetch lança e a rodada não grava
 * #36 nada. A ordem de tasksFor decide qual tarefa passa fome primeiro: as duas da #4 (a leitura e a cobrança) são as últimas.
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
