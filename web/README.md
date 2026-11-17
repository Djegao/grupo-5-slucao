# Tela do contas a pagar

A tela da Já Chegou (fictícia), em React + Vite, na moldura do `@barte-ai-services/shell-kit` e com
os componentes do `@barte-ai-services/barte-ui-kit`, seguindo o wireframe aprovado (F3,
`artifacts/wireframe-contas-a-pagar`). O Worker de `api/` a serve, atrás do Cloudflare Access (#60).
Os dois kits são pacotes privados do GitHub Packages; sem acesso a eles, a tela usa substitutos locais (#53).

## Rodar

Não precisa de token. Os dois kits da Barte (`shell-kit` e `barte-ui-kit`) são `optionalDependencies`: sem acesso
ao GitHub Packages, o `npm ci` os pula e a tela roda nos substitutos de `src/stand-ins/` (#53).

```bash
npm --prefix web ci && npm --prefix web run dev
```

Em dev, o Vite repassa `/me` e `/api/...` ao `wrangler dev` da pasta `api/` (porta 8787). Sem a API
de pé, a moldura abre com o contexto fixo e a pessoa anônima, e as telas mostram o erro com "Tentar de novo".
As rotas `/api/...` pedem o token do Cloudflare Access, que o dev local não tem. Com `VITE_SHELL_URL`, o contexto
vem do Shell.

**Com acesso aos pacotes reais.** Instale com um token de `read:packages` (`gh auth token` serve):

```bash
NODE_AUTH_TOKEN=$(gh auth token) npm --prefix web ci
```

O `vite.config.ts` (alias) e o `tsconfig.json` (`paths`) escolhem o pacote real quando ele está em
`node_modules/@barte-ai-services/`, e o substituto quando não está. Nenhum arquivo de tela muda. O
`postinstall` (`patches/apply.mjs`) só aplica o patch do `DecisionForm` quando o `barte-ui-kit` real está
instalado: o `patch-package` puro falha sem ele, e com `CI=true` derrubaria o `npm ci`.

Na raiz, `make check` roda o `npm ci`, o typecheck, os testes e o build daqui junto com o resto do gate.

## Estrutura

- `src/routes/`: **uma rota, um arquivo** (`fila.tsx`, `proposta.tsx`, `lista-do-dia.tsx`,
  `duplicadas.tsx`, `valor-barrado.tsx`, `doca.tsx`). `routes/index.ts` liga caminho a componente.
- `src/evidence/`: **uma evidência, um arquivo** (`e1.tsx` … `e8.tsx`, `nao-catalogada.tsx`).
  `<EvidenceView divergence={...} />` escolhe o componente registrado para o código ou cai no
  `GenericEvidence`, que lista fonte, referência e descrição e nunca quebra. Se o registrado lançar
  um erro, o genérico entra no lugar.
- `src/components/`: `Screen` (a casca de toda tela: título compacto e carregando, vazio e erro) e
  `useLoad` (o `LoadState` de uma promessa, com `retry`).
- `src/api/`: `client.ts` (`apiGet`, `apiPost`, `me`, `ApiError`) e `contract.ts`, os DTOs do fio
  tipados pelo domínio de `api/src/domain` (`import type` por `@domain`).
- `src/router/`: o stand-in de `next/navigation` sobre a History API, o casamento de rota com
  parâmetro (`/pagar/fila/:id`) e o `Link`, que navega sem recarregar.
- `src/shell/context.ts`: o contexto da moldura e o menu.
- `src/stand-ins/`: os substitutos locais dos kits privados da Barte (#53), **uma pasta por pacote**:
  `barte-ui-kit/` (Panel, Block, DataList, StatusBadge, SegmentedFilter, DecisionForm, LoadFeedback e o resto
  que a tela importa, mais `styles.css`) e `shell-kit/` (`ShellFrame`, `ShellIcon`, `CONTEXT_VERSION`, os tipos
  de contexto e menu, `server.ts` com `fetchShellContext` e `styles.css`). Segue o precedente de `src/router/`, o
  stand-in de `next/navigation`. Só a superfície que as telas usam, sobre o `barte-design-system` (público) ou
  HTML acessível; o `DecisionForm` já traz as props do patch (`value`, `onValueChange`, `children`,
  `submitDisabled`). As telas continuam importando de `@barte-ai-services/*`: o `test/stand-ins.test.ts`
  (#53/AC-3) falha se alguma importar um nome que o substituto não exporta.

## Como uma história preenche a sua tela

1. **A rota.** Abra o arquivo da sua rota em `src/routes/`. Troque a carga vazia por um `apiGet`
   do seu endpoint, que vive sob `/api/...` no Worker, e diga quando o resultado é vazio:

   ```tsx
   const { state, data, retry } = useLoad((signal) => apiGet<ProposalDto[]>("/api/fila", { signal }), (rows) => rows.length === 0);
   return <Screen ... state={state} onRetry={retry}>{() => <Table data={data!} ... />}</Screen>;
   ```

   Título, subtítulo e textos de carregando, erro e vazio já são os do wireframe. Não mexa em
   `routes/index.ts`, a não ser para criar uma rota nova.
2. **O contrato.** Se o seu endpoint precisa de um DTO novo, acrescente em `src/api/contract.ts`,
   tipado pelos tipos do domínio.
3. **A evidência.** Se a história é de uma exceção, troque o corpo do componente em
   `src/evidence/eN.tsx` (ou `nao-catalogada.tsx`). A linha `registerEvidence(...)` e o
   `evidence/index.ts` ficam como estão.
4. **Os testes** ficam em `test/`, nomeados pelo critério (`#<issue>/AC-<n>`).
