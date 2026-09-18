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

## Notas de implementação (Fase 1, 2026-09-18)
- **Duas sessões.** `persist:runas-sites` (sites da suíte, com interceptação de `https`) e `persist:web` (resto da web, sem interceptação nenhuma). Um clique ou endereço que cruza a fronteira abre em nova aba, na sessão certa.
- **Rede por `net.request`.** `session.fetch` não informa redirecionamentos: com `redirect: "manual"` ele aborta ("Redirect was cancelled") e com `"follow"` esconde a URL final (`url` vazio, `redirected: false`). `net.request` emite `redirect`, e o 3xx volta ao Chromium, que atualiza a URL da aba. O corpo chega descompactado, então `content-encoding` e `content-length` são removidos da resposta.
- **Estratégia:**
  - assets em `/_next/static/`: cópia primeiro;
  - demais GET: rede primeiro, com 6 s para navegação e 15 s para recursos, e cópia se falhar ou se o servidor devolver 5xx;
  - HEAD: rede e, na falta dela, a cópia sem corpo (o service worker do Tools confere as páginas com HEAD).
- **Headers `Sec-Fetch-*` não chegam ao interceptador.** Navegação é detectada pelo `Accept: text/html`.
- **RSC:** os pré-carregamentos `__next._tree.txt?_rsc=` do Tools falham offline de propósito, e o Next.js cai para a navegação de documento, que vem da cópia.
- **Atualização automática:** a cópia completa é atualizada ao abrir o app, quando a internet volta (checagem a cada 60 s) e a cada 6 h online. Arquivos não tocados por 30 dias são removidos, e só após uma atualização sem falhas.
- **Cópia inicial:** `npm run seed:sites` gera `resources/site-seed.db` (≈ 4,8 MB), copiada para `userData` na primeira execução. Fica fora do Git e será empacotada pelo instalador quando ele existir.
- **Validação:** `npm run smoke:browser` testa online, redirecionamento, POST e as 8 páginas principais offline contra os sites reais.
