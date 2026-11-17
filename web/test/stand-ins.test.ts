import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { KIT_ENTRIES } from "../vite.config";

/**
 * #53/AC-3 Os kits da Barte (`@barte-ai-services/*`) são pacotes privados que este fork não lê: sem eles, a tela roda
 * nos substitutos de `src/stand-ins/`. O substituto só vale se exportar tudo o que as telas importam. Este teste lê os
 * imports de `src/` e `test/` (tipos inclusive) e falha com o nome que falta, o arquivo e o caminho do kit. Vale com ou
 * sem os pacotes reais instalados: o substituto precisa cobrir a superfície que a tela usa nos dois casos.
 */

const WEB = resolve(import.meta.dirname, "..");
const PREFIX = "@barte-ai-services/";

/** O arquivo do substituto para um caminho de kit (`@barte-ai-services/shell-kit/server`), ou `undefined`. */
function standInFile(specifier: string): string | undefined {
  const [kit, ...rest] = specifier.slice(PREFIX.length).split("/");
  const subpath = rest.length > 0 ? `/${rest.join("/")}` : "";
  const file = kit === undefined ? undefined : KIT_ENTRIES[kit]?.[subpath];
  return file === undefined ? undefined : join(WEB, "src", "stand-ins", kit as string, file);
}

const exportCache = new Map<string, Set<string>>();

/** Os nomes (valores e tipos) que o módulo do substituto exporta, lidos pelo compilador. */
function exportsOf(file: string): Set<string> {
  const cached = exportCache.get(file);
  if (cached) return cached;
  const program = ts.createProgram([file], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    skipLibCheck: true,
    noEmit: true,
    types: [],
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(file);
  const symbol = source ? checker.getSymbolAtLocation(source) : undefined;
  const names = new Set((symbol ? checker.getExportsOfModule(symbol) : []).map((exported) => exported.getName()));
  exportCache.set(file, names);
  return names;
}

interface KitImport {
  specifier: string;
  /** Os nomes importados, como o kit os exporta (`type X` e `X as Y` contam como `X`). */
  names: string[];
  /** `import X from` ou `import * as X from`. */
  defaultName: boolean;
}

/** Os `import`/`export … from "@barte-ai-services/…"` de um arquivo. */
function kitImportsIn(fileName: string, text: string): KitImport[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true, fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: KitImport[] = [];
  for (const node of source.statements) {
    if (!(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) || !node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    const specifier = node.moduleSpecifier.text;
    if (!specifier.startsWith(PREFIX)) continue;
    const names: string[] = [];
    let defaultName = false;
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (clause?.name) defaultName = true;
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) defaultName = false;
      if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) names.push((element.propertyName ?? element.name).text);
    } else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) names.push((element.propertyName ?? element.name).text);
    }
    found.push({ specifier, names, defaultName });
  }
  return found;
}

/** O que o arquivo importa de um kit e o substituto não tem: uma frase por problema. */
function problemsIn(fileName: string, text: string): string[] {
  const problems: string[] = [];
  for (const { specifier, names, defaultName } of kitImportsIn(fileName, text)) {
    const file = standInFile(specifier);
    if (file === undefined) {
      problems.push(`${fileName}: o substituto não tem o caminho ${specifier}`);
      continue;
    }
    if (!existsSync(file)) {
      problems.push(`${fileName}: ${specifier} aponta para ${relative(WEB, file)}, que não existe`);
      continue;
    }
    if (file.endsWith(".css")) continue;
    const available = exportsOf(file);
    if (defaultName && !available.has("default")) problems.push(`${fileName}: ${specifier} não exporta default`);
    for (const name of names) if (!available.has(name)) problems.push(`${fileName}: ${specifier} não exporta ${name}`);
  }
  return problems;
}

/** Todo `.ts` e `.tsx` de `dir`, menos a pasta dos substitutos (eles não importam de si como pacote). */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "stand-ins" || entry.name === "node_modules" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("#53/AC-3 os substitutos cobrem o que as telas importam dos kits da Barte", () => {
  it("#53/AC-3: nenhum arquivo de src/ e test/ importa de @barte-ai-services/* um nome que o substituto não exporta", { timeout: 60_000 }, () => {
    const files = [...sourceFiles(join(WEB, "src")), ...sourceFiles(join(WEB, "test"))];
    const problems = files.flatMap((file) => problemsIn(relative(WEB, file), readFileSync(file, "utf8")));
    expect(problems).toEqual([]);
  });

  it("#53/AC-3: o teste enxerga o que falta: um nome, um tipo, um subcaminho e um caminho que o substituto não tem", { timeout: 60_000 }, () => {
    const problems = problemsIn(
      "tela-ficticia.tsx",
      [
        'import { Panel, Inexistente, type TipoInexistente } from "@barte-ai-services/barte-ui-kit";',
        'import { fetchShellContext, buscaQueNaoHa } from "@barte-ai-services/shell-kit/server";',
        'import Padrao from "@barte-ai-services/shell-kit";',
        'import "@barte-ai-services/barte-ui-kit/outro-caminho";',
        'export { OutroInexistente } from "@barte-ai-services/shell-kit";',
      ].join("\n"),
    );
    expect(problems).toEqual([
      "tela-ficticia.tsx: @barte-ai-services/barte-ui-kit não exporta Inexistente",
      "tela-ficticia.tsx: @barte-ai-services/barte-ui-kit não exporta TipoInexistente",
      "tela-ficticia.tsx: @barte-ai-services/shell-kit/server não exporta buscaQueNaoHa",
      "tela-ficticia.tsx: @barte-ai-services/shell-kit não exporta default",
      "tela-ficticia.tsx: o substituto não tem o caminho @barte-ai-services/barte-ui-kit/outro-caminho",
      "tela-ficticia.tsx: @barte-ai-services/shell-kit não exporta OutroInexistente",
    ]);
  });

  it("#53/AC-3: todo caminho da lista de entradas existe no disco", () => {
    for (const [kit, entries] of Object.entries(KIT_ENTRIES)) {
      for (const file of Object.values(entries)) expect(existsSync(join(WEB, "src", "stand-ins", kit, file)), `${kit}/${file}`).toBe(true);
    }
  });
});
