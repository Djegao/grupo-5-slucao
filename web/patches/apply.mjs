/*
 * O `postinstall` (#53): aplica os patches sobre os kits reais, quando eles estão instalados.
 *
 * Os kits são `optionalDependencies`: sem acesso ao GitHub Packages o `npm ci` os pula e a tela usa os
 * substitutos de `src/stand-ins/`. O `patch-package` puro falha sem o kit (com `CI=true`, que o CI exporta, sai
 * com código 1), e derrubaria o `npm ci`. Aqui, sem o kit instalado, não há o que remendar.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const kit = fileURLToPath(new URL("../node_modules/@barte-ai-services/barte-ui-kit", import.meta.url));

if (!existsSync(kit)) {
  console.log("patches: o @barte-ai-services/barte-ui-kit não está instalado; a tela usa os substitutos de src/stand-ins/.");
} else {
  const cli = fileURLToPath(new URL("../node_modules/patch-package/index.js", import.meta.url));
  const result = spawnSync(process.execPath, [cli], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
