# Tratativa com o fornecedor (demonstração, #156)

Uma página pequena e independente que mostra o bloco "Pedido ao fornecedor" da #156: a nota de devolução e o e-mail
que o agente prepara, e a pessoa revisa, edita, emite e envia. **Não é a gaveta oficial do painel** (`web/`): fica
fora dele, de propósito, sem os pacotes privados `@barte-ai-services` (que dão 403 fora da org). HTML e JavaScript
simples, sem build.

Segue o wireframe aprovado da #156: a analista cola a chave de acesso da nota (44 dígitos) e a página mostra o pedido
mais recente, com só as ações que o estado permite (escrevendo, rascunho, editando, enviado, falha no envio, descartado).

## Ver a página

Módulos ES não abrem direto do disco (`file://`), então sirva a pasta:

```bash
python3 -m http.server 8156 --directory demo-tratativa
```

- **Com a API falsa:** <http://localhost:8156/?mock=1>. Dados fictícios, nada é emitido nem enviado.
  Outros começos: `&cenario=writing` (o "Claude" termina em ~6 s), `&cenario=send-fails` (o primeiro envio falha),
  `&cenario=system-discard` (descartado pelo sistema), `&cenario=empty` (nota sem pedido).
- **Com o Worker de verdade:** sem `?mock`, a página chama `/me` e `/api/pedidos-fornecedor*` na mesma origem, com o
  cookie do Cloudflare Access. Só funciona servida pelo mesmo domínio do Worker.

## Contrato

As rotas e o formato `SupplierRequestView` estão no cabeçalho de `api/src/http/supplier-requests.ts`. A API falsa
(`mock-api.js`) imita esse contrato; `mock-api.test.mjs` confere os pontos principais:

```bash
node --test demo-tratativa/
```
