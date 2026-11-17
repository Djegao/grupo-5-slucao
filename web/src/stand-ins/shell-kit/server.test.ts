import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTEXT_VERSION, type ShellContext } from "./index";
import { fetchShellContext } from "./server";

const GOOD: ShellContext = {
  version: CONTEXT_VERSION,
  user: { id: "u1", name: "Aluna", email: null, roles: [] },
  brand: { name: "Já Chegou", product: "Contas a pagar", logo: null },
  navigation: [],
  account_menu: [],
  administration: [],
  home: "/",
  theme: "light",
  account: null,
  sidebar: "expanded",
};

const OPTIONS = { shellUrl: "https://shell.exemplo", cookie: "" };

function answer(body: unknown, status = 200): void {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(body, { status })));
}

async function failureOf(options: { shellUrl: string; cookie: string }): Promise<unknown> {
  return fetchShellContext(options).then(
    () => null,
    (error: unknown) => error,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("#53/AC-2 fetchShellContext, o substituto de shell-kit/server", () => {
  it("#53/AC-2: pede /api/shell/context na origem, sem a barra final, com o cookie quando há", async () => {
    answer(GOOD);
    await fetchShellContext({ shellUrl: "https://shell.exemplo/", cookie: "sessao=abc" });
    expect(fetch).toHaveBeenCalledWith("https://shell.exemplo/api/shell/context", { credentials: "include", headers: { cookie: "sessao=abc" } });
  });

  it("#53/AC-2: sem cookie, não manda o cabeçalho", async () => {
    answer(GOOD);
    await fetchShellContext(OPTIONS);
    expect(fetch).toHaveBeenCalledWith("https://shell.exemplo/api/shell/context", { credentials: "include", headers: {} });
  });

  it("#53/AC-2: o corpo na forma certa volta como o contexto", async () => {
    answer(GOOD);
    await expect(fetchShellContext(OPTIONS)).resolves.toEqual(GOOD);
  });

  it("#53/AC-2: resposta fora de 2xx lança, sem repetir o corpo", async () => {
    answer({ detalhe: "segredo-do-corpo" }, 503);
    const failure = await failureOf(OPTIONS);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain("segredo-do-corpo");
  });

  it("#53/AC-2: versão de contexto desconhecida lança", async () => {
    answer({ ...GOOD, version: 2 });
    await expect(fetchShellContext(OPTIONS)).rejects.toThrow(/versão/);
  });

  it.each([
    ["um corpo que não é objeto", "texto-do-corpo"],
    ["nulo", null],
    ["sem a pessoa", { ...GOOD, user: undefined }],
    ["o nome da pessoa que não é texto", { ...GOOD, user: { ...GOOD.user, name: 7 } }],
    ["sem a marca", { ...GOOD, brand: null }],
    ["o início que não é texto", { ...GOOD, home: 1 }],
    ["o tema fora de claro e escuro", { ...GOOD, theme: "azul" }],
    ["o e-mail que não é texto nem nulo", { ...GOOD, user: { ...GOOD.user, email: 3 } }],
    ["o nome da marca que não é texto", { ...GOOD, brand: { ...GOOD.brand, name: 1 } }],
    ["o produto da marca que não é texto", { ...GOOD, brand: { ...GOOD.brand, product: null } }],
    ["um grupo de navegação vazio", { ...GOOD, navigation: [{}] }],
    ["um grupo de navegação cujos itens não são lista", { ...GOOD, navigation: [{ key: "a", label: "A", items: "x" }] }],
    ["um item de navegação sem o endereço", { ...GOOD, navigation: [{ key: "a", label: "A", items: [{ key: "i", label: "I" }] }] }],
    ["a navegação que não é lista", { ...GOOD, navigation: {} }],
    ["o menu da conta que não é lista", { ...GOOD, account_menu: "x" }],
    ["a administração que não é lista", { ...GOOD, administration: null }],
  ])("#53/AC-2: forma inválida (%s) lança, sem repetir o corpo", async (_name, body) => {
    answer(body);
    const failure = await failureOf(OPTIONS);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain("texto-do-corpo");
  });
});
