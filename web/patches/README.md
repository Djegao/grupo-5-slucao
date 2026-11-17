# Patches sobre os kits

`@barte-ai-services+barte-ui-kit+0.2.0.patch` dá ao `DecisionForm` as props `value`, `onValueChange`,
`children` (entre as opções e a observação) e `submitDisabled` (#203). É a mesma mudança do PR
barte-ai-services/barte-ui-kit#87. **O patch sai, junto com o `postinstall` e o `patch-package`, quando o
kit novo entrar** (`package.json` sobe a versão do kit e este arquivo é apagado).

O `postinstall` roda `apply.mjs`, e não o `patch-package` direto (#53): o `barte-ui-kit` é `optionalDependency` e, sem
acesso ao GitHub Packages, não está instalado. O `patch-package` puro falha sem o pacote (com `CI=true`, que o CI
exporta, sai com código 1 e derruba o `npm ci`); o `apply.mjs` só o chama quando o kit real está lá. O substituto de
`src/stand-ins/barte-ui-kit/` já traz as props do patch.
