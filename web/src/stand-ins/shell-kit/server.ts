/**
 * O substituto de `@barte-ai-services/shell-kit/server`: a chamada que pede o contexto da moldura ao Shell.
 */
import { CONTEXT_VERSION, type ShellContext } from "./index";

export interface FetchShellContextOptions {
  /** A origem do Shell. */
  shellUrl: string;
  /** O cabeçalho `cookie` da pessoa, quando a chamada vem do servidor; no navegador o cookie vai sozinho. */
  cookie: string;
}

/** Pede `GET {shellUrl}/api/shell/context`. Falha (resposta fora de 2xx, versão que não é a conhecida) lança. */
export async function fetchShellContext({ shellUrl, cookie }: FetchShellContextOptions): Promise<ShellContext> {
  const response = await fetch(`${shellUrl.replace(/\/$/, "")}/api/shell/context`, {
    credentials: "include",
    headers: cookie ? { cookie } : {},
  });
  if (!response.ok) throw new Error(`O Shell respondeu ${response.status}`);
  const context = (await response.json()) as ShellContext;
  if (context.version !== CONTEXT_VERSION) throw new Error("O Shell mandou uma versão de contexto desconhecida");
  return context;
}
