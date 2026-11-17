/**
 * O substituto de `@barte-ai-services/shell-kit/server`: a chamada que pede o contexto da moldura ao Shell (#53).
 */
import { CONTEXT_VERSION, type ShellContext } from "./index";

export interface FetchShellContextOptions {
  /** A origem do Shell. (#53) */
  shellUrl: string;
  /** O cabeçalho `cookie` da pessoa, quando a chamada vem do servidor; no navegador o cookie vai sozinho. (#53) */
  cookie: string;
}

/** Pede `GET {shellUrl}/api/shell/context`. Falha (resposta fora de 2xx, versão que não é a conhecida) lança. */
export async function fetchShellContext({ shellUrl, cookie }: FetchShellContextOptions): Promise<ShellContext> {
  const response = await fetch(`${shellUrl.replace(/\/$/, "")}/api/shell/context`, {
    credentials: "include",
    headers: cookie ? { cookie } : {},
  });
  if (!response.ok) throw new Error(`O Shell respondeu ${response.status}`);
  const body: unknown = await response.json();
  if (!isObject(body)) throw new Error("O Shell mandou um contexto fora da forma conhecida");
  if (body.version !== CONTEXT_VERSION) throw new Error("O Shell mandou uma versão de contexto desconhecida");
  if (!isShellContext(body)) throw new Error("O Shell mandou um contexto fora da forma conhecida");
  return body;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Confere cada campo que a tela lê do contexto (início, tema, pessoa, marca e navegação); o resto passa como veio (#53). */
function isShellContext(body: Record<string, unknown>): body is Record<string, unknown> & ShellContext {
  const { user, brand, navigation, account_menu, administration, home, theme } = body;
  return (
    typeof home === "string" &&
    (theme === "light" || theme === "dark") &&
    isObject(user) &&
    typeof user.name === "string" &&
    (typeof user.email === "string" || user.email === null) &&
    isObject(brand) &&
    typeof brand.name === "string" &&
    typeof brand.product === "string" &&
    Array.isArray(navigation) &&
    navigation.every(isNavigationGroup) &&
    Array.isArray(account_menu) &&
    Array.isArray(administration)
  );
}

function isNavigationGroup(group: unknown): boolean {
  return (
    isObject(group) &&
    typeof group.key === "string" &&
    typeof group.label === "string" &&
    Array.isArray(group.items) &&
    group.items.every((item) => isObject(item) && typeof item.key === "string" && typeof item.label === "string" && typeof item.href === "string")
  );
}
