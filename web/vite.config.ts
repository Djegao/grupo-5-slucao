import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * Os kits da Barte são `optionalDependencies` (#53): o GitHub Packages pede token com acesso, que este fork não tem,
 * e o `npm ci` os pula. Instalados, valem os reais. Ausentes, `@barte-ai-services/<kit>` (e os subcaminhos que a
 * tela importa) apontam para o substituto em `src/stand-ins/<kit>`. O `tsconfig.json` faz o mesmo para o tsc, com os
 * caminhos de código repetidos em `paths`. `KIT_ENTRIES` diz onde cada caminho de kit mora no substituto; o alias e o
 * `test/stand-ins.test.ts` (#53/AC-3) leem esta lista.
 */
export const KIT_ENTRIES: Record<string, Record<string, string>> = {
  "barte-ui-kit": { "": "index.ts", "/styles": "styles.css" },
  "shell-kit": { "": "index.tsx", "/server": "server.ts", "/styles.css": "styles.css" },
};

const standIns = Object.entries(KIT_ENTRIES).flatMap(([kit, entries]) =>
  existsSync(at(`./node_modules/@barte-ai-services/${kit}/package.json`))
    ? []
    : Object.entries(entries).map(([subpath, file]) => ({
        find: new RegExp(`^@barte-ai-services/${kit}${subpath.replace(/\./g, "\\.")}$`),
        replacement: at(`./src/stand-ins/${kit}/${file}`),
      })),
);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      ...standIns,
      // O shell-kit pede `next/navigation` (usePathname e useRouter). Sem Next aqui: o stand-in.
      { find: /^next\/navigation$/, replacement: at("./src/router/navigation.ts") },
      { find: /^@domain$/, replacement: at("../api/src/domain/index.ts") },
    ],
  },
  server: {
    // Em dev, a API é o `wrangler dev` da pasta api/. Mesma origem para o navegador.
    proxy: { "/me": "http://localhost:8787", "/api": "http://localhost:8787" },
  },
  build: { outDir: "dist", emptyOutDir: true },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    // O shell-kit real chega como TS fonte em node_modules, e os kits importam CSS: o Vitest precisa
    // transformá-los (e aplicar o alias de `next/navigation`) em vez de entregá-los crus ao Node. Os
    // substitutos de src/stand-ins/ já passam pelo Vite, por estarem fora de node_modules.
    server: { deps: { inline: [/@barte-ai-services\//, /barte-design-system/] } },
  },
});
