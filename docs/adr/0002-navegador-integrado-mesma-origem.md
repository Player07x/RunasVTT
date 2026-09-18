# ADR 0002 — Navegador integrado com espelho local na mesma origem

- **Status:** aceita (2026-09-18) · implementação na Fase 1

## Contexto
Runas Tools, Runas DM e Runas Book devem funcionar dentro do VTT em tempo real e também sem internet, vindo pré-instalados. Os dados desses sites (fichas, bestiário, wiki) vivem no IndexedDB e no localStorage, que são separados por **origem**.

## Decisão
O navegador integrado sempre carrega o endereço real de cada site (`https://runas-*.pages.dev`), em uma sessão persistente do Electron. O processo principal intercepta as requisições dessas origens:
- **com rede:** busca online e atualiza a cópia local da resposta;
- **sem rede:** responde com a cópia local;
- **primeira execução:** o instalador traz uma cópia inicial dos três sites.

Nunca entram na cópia local: `/api/backup`, `/api/campaign-data`, `/api/book-auth`, `/cdn-cgi/`, respostas de autenticação e payloads RSC (`_rsc`, `RSC: 1`).

## Alternativas rejeitadas
- **Esquema próprio (`runas://tools`):** outra origem, então os dados ficariam separados dos do site online.
- **Depender só dos service workers dos sites:** não cobre a primeira abertura offline e não garante as três cópias.

## Consequências
- É preciso validar a convivência com os service workers dos sites e com o Cloudflare Access.
- A ponte `runasVTT` (ADR 0003) só é injetada nessas origens.
