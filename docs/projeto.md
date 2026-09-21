# RunasVTT — documentação do projeto

> Documento vivo. Reúne a proposta, o plano, as decisões, o estado atual e o histórico de mudanças do RunasVTT. Toda mudança de escopo, decisão ou fase concluída deve ser registrada aqui, na seção correspondente e no \[Histórico de mudanças](#12-histórico-de-mudanças).

* **Repositório:** [Player07x/RunasVTT](https://github.com/Player07x/RunasVTT) (público desde 2026-09-19)
* **Pasta local:** `C:\\Users\\joaoa\\Desktop\\Repositorios\\RunasVTT`
* **Projeto relacionado:** [Player07x/Runas-Core](https://github.com/Player07x/Runas-Core) (Runas Suite), em `C:\\Users\\joaoa\\Desktop\\Repositorios\\runas-suite`
* **Última atualização:** 2026-09-20

\---

## Sumário

1. [Proposta](#1-proposta)
2. [Princípios e restrições](#2-princípios-e-restrições)
3. [Arquitetura](#3-arquitetura)
4. [Integração com a Runas Suite](#4-integração-com-a-runas-suite)
5. [Referência: recursos do FoundryVTT e cobertura no RunasVTT](#5-referência-recursos-do-foundryvtt-e-cobertura-no-runasvtt)
6. [Plano original](#6-plano-original)
7. [Mudanças propostas pelo usuário](#7-mudanças-propostas-pelo-usuário)
8. [Plano revisado (vigente)](#8-plano-revisado-vigente)
9. [Decisões registradas](#9-decisões-registradas)
10. [Estado atual](#10-estado-atual)
11. [Pendências e riscos](#11-pendências-e-riscos)
12. [Histórico de mudanças](#12-histórico-de-mudanças)

\---

## 1\. Proposta

O RunasVTT é uma **mesa virtual (VTT) desktop, instalável e offline**, inspirada nos recursos do FoundryVTT, feita para o mestre conduzir sessões de RPG com as regras da Runas Suite.

A ideia central, definida pelo usuário na revisão do plano, é que **o VTT não copia nenhum recurso dos sites da Runas Suite**. Em vez disso:

* O VTT cuida do que é exclusivamente de mesa: **mapa, cenas, tokens, paredes, visão, luz, névoa, áudio e a tela dos jogadores**.
* Os sites **Runas Tools, Runas DM e Runas Book** rodam dentro de um **navegador integrado** ao VTT, em tempo real, com uma cópia local para funcionar sem internet.
* Ao detectar que estão dentro do VTT, os sites mudam o comportamento: **exportar ficha passa a importar para o VTT**, e **dano e testes são aplicados ao token selecionado**.
* Fichas, testes, dano e regras continuam sendo calculados **pelos sites** (que usam o `@runas/core`). O VTT nunca reimplementa regra.

**Quem usa:** somente o mestre opera o VTT. Os jogadores assistem pela **Vista dos Jogadores**, uma **página web** sem HUD que o próprio VTT transmite (ADR 0009). Eles abrem um link no navegador: na rede local, ou pela internet com um link público opcional (Cloudflare Quick Tunnel, gratuito e sem conta). A mesma página pode abrir numa TV ou num segundo monitor. Não há dependência do Discord, cuja transmissão de vídeo está bloqueada no Brasil.

**Custo contínuo:** nenhum obrigatório. O app roda localmente, e os serviços da suíte já usam a camada gratuita da Cloudflare.

\---

## 2\. Princípios e restrições

1. **Offline-first.** Todo o fluxo de mesa funciona sem internet. A rede só serve para atualizar os sites e para o backup opcional de cada site.
2. **Zero regra duplicada.** O VTT não depende do `@runas/core` e não interpreta o formato `Character`. Ele guarda a ficha recebida como um envelope opaco e mostra apenas o resumo enviado pelo site (ADR 0003).
3. **O mundo é uma pasta.** Copiar a pasta do mundo é um backup completo, com banco, mapas, tokens e áudio.
4. **Só o mestre opera o VTT.** Não há servidor multiusuário, contas nem permissões por jogador (ADR 0001).
5. **O VTT é a fonte da verdade do estado dos tokens.** Dentro do VTT, a Mesa do Runas DM opera sobre os tokens da cena, não sobre cópias próprias (ADR 0006).
6. **Implementação independente (clean-room).** O código, os assets e a marca do FoundryVTT são proprietários: reproduzimos ideias de recursos, nunca código, CSS, ícones ou nomes.
7. **As regras da Runas Suite continuam valendo** para toda mudança feita nela por causa do VTT (ver `AGENTS.md` do runas-suite): migração de `Character` só em `characterStorage.ts`, testes no core, e typecheck e build de todos os consumidores.

\---

## 3\. Arquitetura

```text
RunasVTT (Electron 44 · Node 24 · Chromium)
 ├── Processo principal (src/main)
 │     ├── WorldStore: pasta de mundos, manifesto, abrir/fechar
 │     ├── WorldDatabase: SQLite nativo do Node (node:sqlite), migrações por user\_version
 │     ├── BrowserManager: abas (WebContentsView), sessões persist:runas-sites e persist:web
 │     ├── world-documents: único caminho de escrita (valida, normaliza, transmite)
 │     ├── world-assets + protocolo vtt-asset://: imagens pelo hash do conteúdo
 │     ├── SiteMirror + site-responder: cópia local same-origin (node:sqlite), atualização automática
 │     └── \[Fase 3] Ponte runasVTT: IPC restrito às origens da Runas Suite
 ├── Preload (src/preload): expõe window.vtt para a interface do VTT
 ├── Interface (src/renderer): React 19 + PixiJS 8 (SceneView, reutilizável na Vista dos Jogadores)
 │     └── DocumentStore: cópia dos documentos, atualizada pelas transmissões do processo principal
 └── \[Fase 5] Vista dos Jogadores: servidor somente leitura (HTTP + WebSocket) com projeção filtrada da cena, página web com SceneView { editable: false } e link público opcional (ADR 0009)
```

**Pilha:** Electron 44, electron-vite 5, Vite 7, React 19, TypeScript 5.9, Vitest 3, lucide-react. SQLite via `node:sqlite`, embutido no Node 24 do Electron, sem módulo nativo para compilar. Isso foi verificado no runtime real do Electron.

### Formato do mundo (versão 1)

```text
%APPDATA%\\runas-vtt\\worlds\\<nome>-<id8>\\
  world.json   manifesto: formatVersion, id, title, description, rulesetId, createdAt, updatedAt
  world.db     SQLite: tabela documents (id, type, parent\_id, sort, data JSON, created\_at, updated\_at)
  assets\\maps  assets\\tokens  assets\\tiles  assets\\audio   (arquivos nomeados pelo hash)
```

* **Tipos de documento:** `scene`, `token`, `tile`, `drawing`, `note`, `wall`, `light`, `region`, `sound`, `playlist`, `track` e `log-entry`. O formato de `data` de cada tipo é definido na fase correspondente.
* **Exclusão em cascata:** apagar uma cena apaga os tokens, as paredes e tudo o que ela contém, pela chave estrangeira `parent\_id`.
* **Versões futuras são recusadas:** um manifesto ou banco de versão mais nova é recusado com a mensagem "Atualize o RunasVTT", em vez de arriscar corromper o mundo.
* **Gravação do manifesto:** o `world.json` é gravado de forma atômica (arquivo temporário e depois `rename`).

\---

## 4\. Integração com a Runas Suite

### 4.1 Navegador integrado com os sites instalados localmente

* O navegador sempre abre o **endereço real** de cada site: `runas-tools.pages.dev`, `runas-dm.pages.dev` e `runas-book.pages.dev`.
* O VTT intercepta as requisições. Com internet, busca na rede e atualiza a cópia local; sem internet, entrega a cópia local.
* **Motivo:** IndexedDB e localStorage são separados por origem. Servir a cópia local em outro endereço (ex.: `runas://tools`) separaria os dados, e as fichas "sumiriam" ao alternar entre online e offline.
* **O instalador já traz uma cópia dos 3 sites,** então funciona offline desde a primeira abertura.
* **Nunca entram na cópia local:** `/api/backup`, `/api/campaign-data`, `/api/book-auth`, `/cdn-cgi/`, autenticação e payloads RSC. É a mesma regra dos service workers da suíte.
* **Cloudflare Access:** o login é feito uma vez no navegador integrado e a sessão fica guardada.
* **Obsidian:** a sincronização por pasta local (File System Access API) precisa ser testada no Chromium do Electron, porque as permissões funcionam de outro jeito.

### 4.2 Ponte `window.runasVTT`

Ela é injetada **somente** nas origens da Runas Suite. Sites externos, como o YouTube, nunca a recebem. Os sites detectam a ponte pela presença do objeto, e não pelo *user agent*.

|Ação no site|Fora do VTT|Dentro do VTT|
|-|-|-|
|Exportar ficha (Tools/DM)|baixa JSON/ZIP|importa para o VTT como ator + token|
|Aplicar dano (Mesa do DM)|aplica no ator da Mesa|aplica no token selecionado no VTT|
|Testes|resultado no painel|resultado no painel e no Registro do VTT, com texto sobre o token|

**Fluxo de dano:**

1. O site pede à ponte a ficha do token selecionado.
2. O site calcula a simulação com o `@runas/core`.
3. Na confirmação explícita, o site devolve a ficha atualizada e o resumo para as barras.

O contrato será versionado em um pacote próprio, sugerido `runas-suite/packages/vtt-bridge`, e toda mudança nele exige validar os dois lados.

### 4.3 Imagem da ficha vira token

* `Character.portraitDataUrl` (JPEG 512×512) passa a ser uma **imagem de token**: PNG ou WebP com transparência, com moldura opcional e tamanho em quadrados da grade.
* **Exige mudanças na suíte:**

  * novo `CHARACTER\_VERSION` e migração em `characterStorage.ts`;
  * teste no core;
  * campo também na ficha avançada do Runas Tools, pela regra de paridade;
  * o recorte de retrato do DM vira um editor de token.
* Ao importar a ficha, o VTT cria o token com essa mesma imagem.

### 4.4 Autenticação dos sites (já aplicada)

* **Runas DM:** Campanhas e Wiki abrem sem login nem senha. O token de backup só ativa a cópia na nuvem (D1).
* **Runas Book:** a área DM é desbloqueada só pelo token, sem senha.
* **Pré-requisito do VTT:** com isso, a área privada do DM funciona offline dentro do navegador integrado.

\---

## 5\. Referência: recursos do FoundryVTT e cobertura no RunasVTT

Pesquisa feita em 2026-09-18, com o FoundryVTT na **V14 estável** (14.359 como primeira estável; V14.5 e V15 em planejamento). Ele é vendido por licença única e tem cerca de 475 sistemas e 5.338 módulos.

|Área do Foundry|Principais recursos|No RunasVTT|
|-|-|-|
|Plataforma|Servidor Node + Electron, jogadores pelo navegador, Setup de mundos/sistemas/módulos, licença, backups e snapshots|**Parcial:** app Electron, mundos em pasta e backup da pasta. Sem servidor multiusuário, sem módulos.|
|Dados|Documents (Actor, Item, Scene, Journal, Macro, Playlist, RollTable, Cards, Combat, ChatMessage, User, Folder, Adventure, ActiveEffect), compêndios, pastas, UUIDs, flags|**Parcial:** documentos de mesa. Ficha, itens e jornal ficam nos sites.|
|Usuários|Papéis (Player, Trusted, Assistant, GM), propriedade por documento|**Fora:** só o mestre usa.|
|Canvas|Cena, grade quadrada/hex/sem grade, tokens (barras, condições, alvo, elevação, anéis, movimento com waypoints), régua|**Sim:** Fase 2.|
|Paredes/visão|Paredes com restrições independentes, portas e secretas, visão por token, modos de visão e detecção|**Sim:** Fase 6.|
|Luz/névoa|Luzes com animações, escuridão, iluminação global, névoa persistente e compartilhada|**Sim:** Fase 6.|
|Tiles, desenhos, notas|Imagens e vídeos em camadas, oclusão, desenhos e texto, alfinetes de jornal|**Sim:** Fase 2. As notas apontam para páginas dos sites.|
|Regiões|Formas, comportamentos (teleporte, terreno, escuridão, texto, macro), eventos de token e turno; templates de área absorvidos na V14|**Sim, simples (Fase 8):** retângulo ou elipse com teleporte, texto e terreno difícil; sem macros e sem eventos de turno.|
|Scene Levels (V14)|Andares empilhados na mesma cena|**Fora.**|
|Chat e dados|Modos de rolagem, sussurros, rolagens inline, motor de dados completo|**Delegado:** os testes são dos sites. O VTT mostra o Registro.|
|Combate|Tracker, iniciativa, rodadas, derrotados, grupos, Active Effects V2|**Delegado:** a Mesa do DM opera sobre os tokens.|
|Jornal|Páginas, ProseMirror, segredos, links|**Delegado:** Wiki e Campanhas do DM, e o Runas Book.|
|Áudio/vídeo|Playlists, sons posicionais, A/V por WebRTC|**Sim:** só áudio local (Fase 7). Vídeo e streaming pelo navegador integrado. Sem A/V.|
|Tabelas, cartas, macros|Roll Tables, Cards, macros de script|**Fora** por ora.|
|Extensibilidade|Sistemas e módulos, API de hooks, Marketplace|**Fora.**|
|Interface|Pop-outs, temas, atalhos, localização|**Parcial:** tema escuro da suíte, pt-BR.|

\---

## 6\. Plano original

Primeira versão, antes da revisão do usuário. Mantida aqui como histórico.

**Arquitetura original:**

* Electron com servidor Node embutido (Fastify + WebSocket), autoritativo;
* SQLite por mundo, cliente React + PixiJS;
* jogadores conectados pelo navegador;
* o VTT consumindo `@runas/core` diretamente para calcular regras;
* extração de `packages/runas-knowledge` do DM para reaproveitar Wiki, Cronologia, História e Obsidian.

|#|Fase original|Estimativa (1 dev)|
|-|-|-|
|0|Fundações, ADRs, extração de `runas-knowledge`|2–3 sem|
|1|Servidor e persistência, permissões e sessões|4–6 sem|
|2|Cliente-base e fichas (importação, ficha, testes e dano no chat)|5–6 sem|
|3|Canvas essencial|6–8 sem|
|4|Combate|3–4 sem|
|5|Visão, paredes, luz e névoa|8–10 sem|
|6|Regiões, efeitos, macros, tabelas e cartas|6 sem|
|7|Conteúdo: jornal = Wiki, Obsidian, compêndios, aventuras|4–5 sem|
|8|Áudio e vídeo (WebRTC)|3–4 sem|
|9|Rede e distribuição (instalador, LAN, túnel, HTTPS)|3–4 sem|
|10|Integração com a nuvem da suíte (D1, Access Service Token)|2–3 sem|
|11|Paridade avançada (níveis, partículas, API de plugins)|contínua|

Estimativa original para paridade: 18 a 30 meses para uma pessoa. Com o Claude: MVP em 1 a 2 meses e paridade próxima da V14 em 6 a 10 meses.

\---

## 7\. Mudanças propostas pelo usuário

Registradas em 2026-09-18.

|#|Proposta do usuário|Efeito no plano|
|-|-|-|
|M1|Fase 7 (conteúdo) não é necessária: basta um **navegador integrado**|Wiki, compêndios e jornal ficam nos sites. A extração de `runas-knowledge` foi cancelada.|
|M2|Dentro do VTT, **exportar ficha importa para o VTT** em vez de baixar|Ponte `runasVTT` e ajuste nos botões de exportar do Tools e do DM|
|M3|No DM, anexar **token** em vez de imagem; a imagem do token importado é a mesma|Mudança no `Character` (seção 4.3)|
|M4|O navegador já vem com **os 3 sites instalados localmente** e os atualiza com internet|Espelho local same-origin (seção 4.1)|
|M5|Fase 8: **sem vídeo**, só áudio importado localmente. Vídeo é possível pelo navegador|A/V por WebRTC removido. Áudio local mantido.|
|M6|**Compartilhar a tela sem HUD**, só objetos e cenário|Nova fase: Vista dos Jogadores|
|M7|Fase 9 (distribuição e rede) não é necessária no momento|Removida. Instalador e jogadores remotos ficam para depois.|
|M8|Fase 10 (nuvem) precisa ser repensada|Os sites continuam fazendo o próprio backup. O VTT só faz backup do próprio mundo.|
|M9|Fase 11 (paridade avançada) não será implementada|Removida|
|M10|Fase 2: dentro do VTT, o site oferece **aplicar dano no token selecionado**|Ponte e ajuste na Mesa do DM|
|M11|Princípio geral: **não copiar recursos dos sites**; usar os sites em tempo real pelo navegador local|O VTT não depende do `@runas/core` (ADR 0003)|
|M12|Só o mestre usa o VTT; os jogadores veem pela tela compartilhada|Sem servidor multiusuário nem permissões (ADR 0001)|
|M13|A Mesa do DM usa os tokens do VTT como atores|O VTT é a fonte da verdade dos tokens (ADR 0006)|
|M14|Remover a senha do Runas DM: Campanhas e Wiki sem login, token só para o backup|Aplicado no runas-suite (`e226df6`)|
|M15|Runas Book: usar apenas o token, sem senha|Aplicado no runas-suite (`9e52973`)|
|M16|A Vista dos Jogadores é transmitida por uma **página web**, e não por captura de janela (a transmissão de vídeo do Discord está bloqueada no Brasil)|ADR 0009; Fase 5 passa a ter servidor somente leitura (revisa os ADRs 0001 e 0005)|
|M18|Espectadores podem **mover tokens "Jogador"** (nova categoria)|ADR 0017: revisa 0001 e 0009; o VTT valida cada pedido (Jogador, mapa, paredes)|
|M17|Gerar um **instalador `.exe`** (revisa M7)|ADR 0016: electron-builder com NSIS; dados em `%APPDATA%\runas-vtt` tanto no instalado quanto em desenvolvimento|
|M20|**Sessão com código por jogador:** o mestre diz quantos jogadores terá, o VTT gera um código para cada um, o código libera o Runas Tools no navegador do jogador e a ficha enviada aparece na Mesa do Runas DM, sincronizada nos dois sentidos|Fase 10. ADR 0019 (assentos, ficha por HTTP, revisão e conflito) e ADR 0020 (o VTT serve o Tools); revisa os ADRs 0001, 0009 e 0017|

\---

## 8\. Plano revisado (vigente)

|#|Fase|Onde|Estimativa|Status|
|-|-|-|-|-|
|0|Fundações: Electron + Vite + React + TS, formato do mundo, ADRs|RunasVTT|1 sem|**Concluída** (2026-09-18)|
|1|Navegador integrado: abas, sessão persistente, espelho local same-origin, atualização|RunasVTT|2–3 sem|**Concluída** (2026-09-18). A ponte `runasVTT` foi para a Fase 3, junto do contrato.|
|2|Canvas essencial: cenas, grade quadrada/hex, tokens, barras PV/PA/PE, régua, tiles, desenhos, notas|RunasVTT|3–4 sem|**Concluída** (2026-09-18)|
|3|Integração: contrato da ponte, exportar→importar, dano no token selecionado, testes no Registro, Mesa sobre tokens|ambos|2–3 sem|**Concluída** (2026-09-18)|
|4|Imagem → token: `CHARACTER\_VERSION`, migração, editor de token no DM, campo no Tools|runas-suite|1 sem|**Concluída** (2026-09-18)|
|5|Vista dos Jogadores como página web: servidor somente leitura, projeção filtrada, link na rede local com QR code, link público opcional e janela local (ADR 0009)|RunasVTT|2–3 sem|**Concluída** (2026-09-18)|
|6|Paredes, portas, visão, luz e névoa|RunasVTT|5–8 sem|**Concluída** (2026-09-18)|
|7|Áudio local: playlists, loop, fade, canais, sons posicionais|RunasVTT|1 sem|**Concluída** (2026-09-18), com o áudio também na Vista dos Jogadores (ADR 0013)|
|8|Regiões simples: teleporte, texto, terreno (opcional)|RunasVTT|2 sem|**Concluída** (2026-09-18) (ADR 0014)|
|9|Backup do mundo: exportar `.zip` e snapshot antes de cada sessão|RunasVTT|3 dias|**Concluída** (2026-09-18) (ADR 0015)|
|10|Sessões de jogadores: assentos com código, lobby, Runas Tools servido pelo VTT, ficha do assento e sincronização com a Mesa (ADRs 0019 e 0020)|ambos|3,5–4,5 sem|**Concluída** (2026-09-21; Release `v0.3.1`)|

* **Marcos:** o MVP jogável corresponde às fases 0 a 5 (cerca de 2 a 3 meses). Com visão e luz, cerca de 3,5 a 5 meses.
* **Removidos:** jornal e compêndios, vídeo e A/V, distribuição e rede, nuvem própria do VTT e paridade avançada.

### Fase 10 — etapas (em andamento desde 2026-09-20)

|Etapa|O que entra|Arquivos principais|Estimativa|
|-|-|-|-|
|10.0|Spike e ADRs: servir uma rota do espelho pelo `PlayerServer` e abrir o Tools num navegador externo da LAN; conferir o fallback de rota do export estático, o service worker na origem não segura e um `PUT` de ficha real pelo túnel|`player-server.ts`, `site-responder.ts`|1–2 dias|**Concluída** (2026-09-20)|
|10.1|Sessões e assentos: 1 a 12 jogadores ao ligar a transmissão, códigos com hash, regenerar, revogar, limpar a ficha, estados do assento, contagem separada de espectadores e tabela no painel do mestre|`player-session.ts` (novo), `player-transmission.ts`, `shared/ipc.ts`, `shared/player.ts`, `preload/index.ts`, `PlayerPanel.tsx`|3–5 dias|**Concluída** (2026-09-20)|
|10.2|Lobby e cookie: campo de código na Vista dos Jogadores, `POST /seat/join`, cookie `HttpOnly`, `Origin` validado, teto de conexões e `GET /tools/*` servindo o Tools do espelho|`player-server.ts`, `player-transmission.ts`, `PlayerView.tsx`, `site-responder.ts`|4–6 dias|**Concluída** (2026-09-21)|
|10.3|Shim `window.runasVTT` do assento (mesmo contrato, escopo de um assento) e ajustes de interface no Runas Tools|`src/player/seat-bridge.ts` (novo); no `runas-suite`: `lib/vttBridge.ts`, `character-actions.tsx`, `character-gallery.tsx`|3–5 dias|**Concluída** (2026-09-21)|
|10.4|Anexação e sincronização: `seat-character`, token na cena da Mesa, sanitização no ingresso, imagem por hash, revisão e avisos ao assento|`player-transmission.ts`, `bridge-service.ts`, `bridge-ipc.ts`, `world-assets.ts`, `world-documents.ts`|4–6 dias|**Concluída** (2026-09-21)|
|10.5|Conflito e reconexão: `baseRevision`, `mutationId`, `409` com a versão da mesa e retomada pelo código|`player-server.ts`, shim, Runas Tools|2–4 dias|**Concluída** (2026-09-21)|
|10.6|Segurança e limites: tentativas por minuto, quota de escrita e de assets, revogação, `Origin`, movimento restrito ao token do assento|`player-server.ts`, `player-moves.ts`, `player-session.ts`|2–3 dias|**Concluída** (2026-09-21; quota de assets segue limitada à projeção permitida)|
|10.7|Testes e publicação: unitários dos dois lados, ponta a ponta com três assentos, `seed:sites`, instalador, LAN e Quick Tunnel|`tests/`, `runas-suite`|4–5 dias|**Concluída** (2026-09-21; CI, deploy dos sites e Release `v0.3.1`)|

* **Decisão em aberto:** servido pelo VTT, o Tools do jogador roda numa origem nova a cada sessão — sem PWA instalável e com a galeria local vazia. A ficha do assento cobre o caso principal; quem quiser manter a galeria pessoal continua usando o site publicado fora da sessão e levando o JSON.

**Progresso atual (2026-09-21):** a Fase 10 está concluída. O VTT cria assentos efêmeros e códigos com hash, faz lobby por cookie `HttpOnly`, serve o Tools do espelho na mesma origem, injeta o shim `runasVTT` por assento e grava fichas como `seat-character`. O envio cria/atualiza automaticamente o token `Jogador` na cena da Mesa; alterações do mestre voltam por avisos WebSocket e HTTP com revisão, `mutationId` e resposta `409` para conflito. `Origin`, limite de conexões, tentativas de ingresso, quota de escrita, bloqueio do service worker espelhado e dono do token são verificados no servidor. A matriz local (typecheck, 134 testes e smoke do Electron), os testes/builds da suíte (82 testes, typecheck e Tools/DM), CI, deploy dos sites e instalador foram concluídos.

\---

## 9\. Decisões registradas

|ADR|Decisão|Motivo|
|-|-|-|
|0001|Só o mestre opera o VTT; existe apenas um servidor de transmissão WebSocket/HTTP, desligado por padrão e somente leitura.|M12/M16. Jogadores assistem pela página, sem contas, permissões ou escrita.|
|0002|Navegador integrado com espelho local **na mesma origem** dos sites|Preserva IndexedDB e localStorage entre online e offline (seção 4.1)|
|0003|O VTT não interpreta `Character`: guarda o envelope opaco e o resumo enviado pelo site|Evita duplicar regras (M11 e regra da suíte)|
|0004|Mundo = pasta com `world.json`, `world.db` (SQLite `node:sqlite`) e `assets/`|Backup por cópia, sem módulo nativo, migrações versionadas|
|0005|Vista dos Jogadores = página web transmitida; a janela Electron local abre essa mesma página sem HUD|M6/M16. Funciona em navegador, TV ou monitor e não depende de captura de vídeo.|
|0006|O VTT é a fonte da verdade dos tokens; o token é uma cópia independente da ficha|M13. Evita duas "mesas" divergentes e mantém a regra da Mesa do DM.|
|0008|Cena: documentos normalizados no processo principal, assets por hash via `vtt-asset://` (CORS), `SceneView` imperativo em PixiJS com `unsafe-eval` oficial|Uma única regra de dados, cache seguro e renderizador pronto para a Vista dos Jogadores|
|0009|Vista dos Jogadores como página web transmitida pelo VTT, somente leitura, com projeção filtrada e link público opcional|Preferência do usuário; não depende de serviço de vídeo (Discord bloqueado no Brasil)|
|0007|Electron em vez de Tauri|Chromium embutido e controlado para o navegador integrado, e ecossistema TypeScript|
|0010|Vista dos Jogadores com câmera própria; régua do mestre e textos de dano transmitidos; régua local do espectador|Pedido do usuário: o mestre olha o mapa sem arrastar a tela dos jogadores|
|0011|Configurações do aplicativo (atalhos) e Token de Acesso cifrado, preenchido nas telas de "Chave de acesso" da suíte|Pedido do usuário; o token não entra na ponte `runasVTT`|
|0012|Visão, luz e névoa calculadas no processo principal; a projeção só envia o que os aliados enxergam|A página dos jogadores é pública na rede: esconder no cliente vazaria a cena|
|0013|Áudio decidido no processo principal e tocado, sincronizado, na mesa e na página dos jogadores|Os jogadores assistem de casa: o áudio precisa chegar até eles|
|0015|Backup: `.zip` com cópia consistente do banco (`VACUUM INTO`) e importação validada; snapshots do banco por sessão, fora da pasta do mundo|Desfazer uma sessão e levar o mundo para outra máquina com segurança|
|0017|Espectadores movem tokens "Jogador"; o VTT valida (cena, categoria, travado, mapa, paredes) e grava pelo mesmo caminho da mesa|Pedido do usuário; os jogadores podem mover os próprios personagens sem contas|
|0018|Tag `v*` gera o instalador no GitHub Actions e o publica numa Release; a tag precisa bater com o `package.json`|Pedido do usuário; o CI também atualiza a cópia inicial dos sites a cada versão|
|0014|Regiões com gatilhos (teleporte, texto) no processo principal e terreno difícil na régua; jogadores só recebem forma e terreno das regiões visíveis|Os gatilhos valem para qualquer movimento, inclusive o feito pela ponte com os sites|
|0019|Sessões com assentos efêmeros: código por assento, ficha por HTTP com revisão e conflito, WebSocket só para avisos, ficha guardada no mundo (`seat-character`)|Pedido do usuário (M20). O WebSocket artesanal não carrega envelopes de megabytes, e o envelope opaco não admite merge|
|0020|O VTT serve o Runas Tools ao jogador, na origem da Vista dos Jogadores, a partir do espelho local, injetando um shim de `window.runasVTT`|Uma página HTTPS não abre `ws://IP:porta`: sem isso, o recurso dependeria de internet e túnel até em mesa presencial|

Os ADRs detalhados ficam em [`docs/adr/`](adr/).

\---

## 10\. Estado atual

Atualizado em 2026-09-18.

### Runas Suite (aplicado e publicado)

* `e226df6`: Runas DM, Campanhas e Wiki sem login; o token só ativa o backup na nuvem. Publicado em `runas-dm.pages.dev`.
* `9e52973`: Runas Book, área DM só com token. Publicado em `runas-book.pages.dev`.
* Secrets na Cloudflare: token novo cadastrado no DM e no Book; `RUNAS\_DM\_CAMPAIGN\_PASSWORD` removido pelo usuário. O mesmo token vale nos dois sites (confirmado pelo usuário).

### RunasVTT (Fases 0 a 9 concluídas)

**Fase 0: fundações**

* Electron 44.4.2 (Node 24.21), electron-vite 5, Vite 7, React 19, TypeScript 5.9 e Vitest 3.
* Mundo em pasta (`world.json`, `world.db` com `node:sqlite` e `assets/`); tela de mundos e esqueleto da mesa.
* ADRs 0001–0007, `AGENTS.md`, README e CI.

**Fase 1: navegador integrado**

* **Abas e interface:** abas em `WebContentsView` no painel lateral (redimensionável, com botão para expandir), barra de endereço, voltar, avançar, recarregar e uma nova aba com atalhos para os 3 sites ou qualquer endereço.
* **Cópia local na mesma origem:** a página continua em `https://runas-\*.pages.dev` com internet ou sem ela, e os dados dos sites (IndexedDB) ficam os mesmos.
* **Sessões separadas:** os sites da suíte ficam em `persist:runas-sites`, com cópia local; a web externa fica em `persist:web`, sem interceptação.
* **Indicador de origem:** mostra se a página veio *Online*, da *Cópia local* ou está *Indisponível*.
* **Painel "Funcionamento offline":**

  * *Preparar offline*, com progresso;
  * tamanho da cópia de cada site;
  * *Forçar modo offline*, para testar ou para usar sem rede.
* **Atualização automática** ao abrir, quando a internet volta e a cada 6 h. Arquivos de builds antigos são limpos.
* **Cópia inicial para a primeira execução:** `npm run seed:sites`.
* **Nunca copiados:** `/api/\*`, `/cdn-cgi/\*`, RSC, POST e respostas com `no-store` ou `set-cookie`.
* **Verificações:**

  * 27 testes unitários;
  * `npm run smoke`;
  * `npm run smoke:browser` contra os sites reais: online, redirecionamento 308, POST (401), cópia de 84 arquivos sem falhas e as 8 páginas principais dos 3 sites abrindo offline sem nenhuma requisição à rede;
  * teste de ponta a ponta da interface no Electron via DevTools Protocol: a página ocupa exatamente a área reservada, e *Preparar offline* seguido de modo offline forçado e recarga abriu o Runas DM da cópia, com as fichas preservadas.

**Importante para o uso:** o navegador do VTT é um perfil separado do Chrome. As fichas e a Wiki que você já tem no Chrome **não aparecem** automaticamente no VTT. Para levá-las, use uma destas opções:

* Runas DM: token de backup → *Backup na nuvem* no Chrome → *Importar da nuvem* no VTT;
* exportação e importação de JSON/ZIP;
* sincronização com o Obsidian.

**Fase 2: canvas essencial**

* **Cenas (aba *Cenas*):**

  * criar, abrir, renomear e excluir, com confirmação; excluir uma cena apaga tudo o que ela contém;
  * mapa de fundo importado, e a cena assume o tamanho da imagem;
  * cor de fundo e tamanho em pixels;
  * lembra a última cena aberta de cada mundo.
* **Grade:**

  * quadrada, hexagonal (fileiras ou colunas) ou sem grade;
  * tamanho da célula e deslocamento X/Y, para alinhar com mapas que já têm grade desenhada;
  * valor da célula e unidade (padrão 1,5 m);
  * regra das diagonais;
  * cor e opacidade.
* **Tokens:**

  * imagem ou inicial do nome, com borda na cor da disposição (aliado, neutro, hostil ou secreto);
  * tamanho em células, rotação e elevação;
  * até 3 barras (PV, PA, PE) nas cores da suíte;
  * nome visível ou não;
  * ocultar dos jogadores (fica translúcido para o mestre) e travar a posição.
* **Outros objetos:**

  * tiles (imagens soltas) acima ou abaixo dos tokens, com opacidade e rotação; também é possível arrastar arquivos de imagem para o mapa;
  * desenhos: retângulo, elipse, mão livre e texto, com cores e espessura;
  * notas no mapa ligadas a uma página: duplo clique abre no navegador integrado (ex.: a Wiki do DM).
* **Interação:**

  * selecionar, com Shift para somar e caixa de seleção;
  * arrastar com encaixe na grade (Alt ignora o encaixe) e régua automática ao arrastar um token;
  * ferramenta *Régua* (distância na unidade da cena e em células);
  * botão direito arrasta o mapa, a roda do mouse aproxima, e *Enquadrar cena* reenquadra;
  * atalhos: V, R, T, D, N para as ferramentas; setas movem uma célula; Delete exclui; H oculta; Esc cancela.
* **Painel de propriedades** para o objeto selecionado, e ações em lote para vários.
* **Verificação:**

  * 44 testes, incluindo a geometria das grades quadrada e hexagonal, a normalização dos dados e o protocolo dos assets;
  * teste de ponta a ponta no Electron real, com mouse simulado: mapa importado e exibido; token arrastado encaixando exatamente na célula esperada; token e nota criados pelas ferramentas; régua medindo 4 células = 6 m; retângulo desenhado; troca para grade hexagonal; nenhum erro no console.
* **Problemas encontrados e corrigidos nos testes:**

  * o PixiJS exigia `unsafe-eval` (resolvido com o módulo oficial `pixi.js/unsafe-eval`, sem afrouxar a CSP);
  * imagens do mundo não carregavam (`net.fetch` de `file://` falhava, trocado por leitura direta);
  * o WebGL recusava as imagens (faltava CORS);
  * a cena não reenquadrava ao trocar o mapa.

**Fase 3: integração com a Runas Suite**

* A ponte `window.runasVTT` é exposta pelo preload somente às três origens da suíte; cada chamada é conferida novamente no processo principal antes de tocar o mundo.
* O Runas Tools e o Runas DM enviam fichas JSON como tokens na cena aberta. O lote é limitado a 50 fichas por chamada e dividido automaticamente quando necessário.
* O DM lê os tokens da cena como atores da Mesa, usa o token selecionado como alvo preferido, grava a ficha recalculada no próprio token somente após confirmação do dano e envia testes/danos ao Registro.
* O Registro mantém as 500 entradas mais recentes, mostra testes e danos na aba lateral e exibe o texto flutuante sobre o token correspondente.
* A ficha continua opaca no VTT: envelope, barras e imagem são calculados pela suíte; o VTT apenas normaliza limites de transporte, persiste e renderiza.
* **Verificação:** `npm run typecheck`, `npm test` e `npm run smoke` passaram; 53 testes (incluindo 9 da ponte) e o smoke do Electron confirmaram a persistência de tokens e a remoção em cascata da cena.
* **Revisão da Fase 3 (feita pelo Claude sobre o trabalho do Codex):**

  * **Bloqueante:** o commit da suíte usava `@runas/core/lib/characterSummary` sem versionar o arquivo; o CI não compilaria. Nada tinha sido enviado, então nada quebrado foi publicado. Corrigido no commit `94a248c` da suíte.
  * As mensagens de erro do VTT chegavam aos sites com o prefixo técnico do Electron ("Error invoking remote method…"). O preload da ponte passou a entregar só o motivo (`cleanRemoteError`), com teste.
  * O Tools escondia o motivo da recusa (ex.: "Abra uma cena no RunasVTT antes de importar"); agora mostra.
  * "Iniciar encontro" das Campanhas gravava o encontro na Mesa local, que fica oculta dentro do VTT. Agora envia as criaturas como tokens.
  * Tokens importados ficavam colados e com os nomes sobrepostos; agora há uma célula livre entre eles.
  * As regras de produto da suíte ganharam a seção "Integração com o RunasVTT".
* **Verificação da suíte:** o commit publicado foi testado isoladamente (exportado sem as alterações locais pendentes): testes 37 + 3 + 8 + 82, typecheck e builds do Tools e do DM ok. O JavaScript inicial do Tools ficou em 676 KB, com limite de 700 KB. Os três deploys foram bem-sucedidos.
* **Teste de ponta a ponta contra os sites publicados, no Electron real:**

  * a ponte apareceu no DM (protocolo 1) e o cartão PWA ficou oculto;
  * "Enviar fichas ao VTT" criou 2 tokens com barras calculadas pelo core;
  * o clique no token no mapa virou o alvo automático na Mesa;
  * o dano de 10 cortante levou o token a PV 14/16 e PA 0/7, com "-9" no Registro;
  * o teste rolado também foi registrado;
  * nenhum erro no console;
  * fora do VTT, o DM segue com "Exportar fichas" e sem ponte.

**Fase 4: token da ficha**

* **Formato:** `Character` v21 com `tokenImageDataUrl` (PNG ou WebP com transparência) e `tokenSize` (0,5 a 10 células). Fichas v20 migram com tamanho 1 e sem token; o retrato continua sendo a reserva.
* **Desenho compartilhado:** `renderTokenImage` e `tokenCrop` em `@runas/vtt-bridge` fazem o recorte circular com borda opcional, ou a imagem livre, com fundo transparente em 400 px, WebP com reserva em PNG. Os dois apps usam as mesmas funções.
* **DM:** escolher a imagem da ficha abre o editor de token (formato, zoom, enquadramento, borda, tamanho e prévia). Token e tamanho também aparecem na ficha avançada. Cartões, Mesa e encontros mostram o token.
* **Tools:** campo Token abaixo do retrato 2:3, com o mesmo editor, gravado na seção `token` do IndexedDB (sem ela, o token se perderia ao recarregar).
* **VTT:** a ponte aceita `tokenSize` (opcional no protocolo 1), e o token é criado e encaixado com esse tamanho.
* **Problema achado e corrigido nos testes:** a imagem do editor sumia no Tools em desenvolvimento, porque o StrictMode remonta o componente e o endereço `blob:` já tinha sido revogado. Os editores passaram a ler o arquivo como data URL.
* **Verificação:**

  * core com 44 testes (incluindo a migração v20 → v21) e vtt-bridge com 7;
  * commit da suíte testado isoladamente (testes, typecheck, builds e limite do Tools em 676,5 de 700 KB) e publicado;
  * no navegador: editor do DM (token WebP salvo, tamanho 2, versão 21, cartão com token, campo na ficha avançada) e editor do Tools (token persiste após recarregar);
  * ponta a ponta no Electron contra o DM publicado: token 2×2 criado no DM chegou ao mapa do VTT com imagem e tamanho.

**Fase 5: Vista dos Jogadores como página web (ADR 0009)**

* O processo principal oferece um servidor HTTP + WebSocket somente leitura, desligado por padrão, em `0.0.0.0:30000` (porta configurável). A chave aleatória de 128 bits muda a cada ativação; sem a chave, a página, o WebSocket e os assets respondem 404.
* A segunda entrada do Vite (`player.html`) usa o mesmo `SceneView` com `editable: false`. A janela local da TV/monitor carrega a mesma URL HTTP e não recebe preload, `window.vtt` nem `window.runasVTT`.
* A projeção é construída em módulo puro e testado: só a cena transmitida e objetos visíveis; tokens sem `actor`; notas sem `url`; nenhum Registro; barras configuráveis (padrão só aliados). Assets só são servidos quando referenciados pela projeção atual.
* O painel do mestre liga/desliga, mostra link LAN, QR code local e espectadores, permite escolher cena, seguir/desligar a câmera do mestre, puxar a câmera e escolher barras. O link público opcional baixa e verifica o `cloudflared` oficial apenas depois de confirmação e abre um Quick Tunnel.
* A página suporta câmera seguindo o mestre (centro e zoom) ou câmera local independente. Mensagens de clientes são ignoradas, exceto `ping`; desligar a transmissão ou fechar o mundo encerra as conexões.
* A imagem do token preserva o alpha de PNG/WebP e recebe a borda da disposição como uma dilatação da silhueta, em vez de um fundo ou quadrado colorido. Um clique sem movimento publica a seleção no `pointerup`; arrastar e soltar apenas move o token e não abre a ficha.
* **Verificação:** 61 testes (incluindo checksum do release, projeção e servidor), `npm run typecheck`, `npm test`, `npm run smoke` e página real aberta no navegador externo com canvas renderizado, WebSocket conectado e nenhum erro de console.

**Correções da Fase 5 (pedidas pelo usuário após o uso)**

* **Link público:** agora leva a chave da sessão (`?k=`) e só é entregue depois que o `cloudflared` registra a conexão. O link aparece no cartão, em vez de uma janela que era bloqueada.
* **Câmera dos jogadores independente (ADR 0010):** mover a câmera do mestre não mexe na dos jogadores; só o botão "Puxar a câmera" a move. O espectador arrasta o mapa com o botão esquerdo, usa a roda e as teclas WASD ou as setas.
* **Régua:** a régua da ferramenta Régua do mestre aparece aos jogadores (dourada), só na cena transmitida. A régua de arrastar tokens não é enviada. O espectador tem a própria régua, que fica só na tela dele.
* **Textos de dano** aparecem também para os espectadores, só sobre tokens visíveis a eles.
* **Tokens:** a tecla F espelha a imagem; a moldura branca de seleção foi removida; a borda da disposição ficou 40% mais fina.
* **Configurações (ADR 0011):** a tela Configurações fica na barra da mesa e na tela de mundos, e tem duas partes.
  * **Teclado:** velocidade da câmera e atalhos regraváveis. O padrão é WASD e setas para a câmera, Shift + direção para mover a seleção e P para Desenhar.
  * **Acesso:** o Token de Acesso fica cifrado pelo `safeStorage` e preenche a "Chave de acesso" do DM (backup) e do Book (área DM) dentro do navegador integrado. Isso foi verificado nos dois sites publicados.
* Quem conecta à transmissão recebe sempre a cena completa (antes podia receber só a última mensagem de câmera).

**Fase 6: paredes, portas, visão, luz e névoa (ADR 0012)**

* **Ferramenta Paredes (B):**
  * arrastar cria parede, porta ou porta secreta;
  * as pontas encaixam em outras paredes e em cantos e meios de célula, e Alt solta o encaixe;
  * clicar na ponta de uma parede começa outra emendada;
  * a parede selecionada tem alças para mover as pontas, e arrastar a linha move a parede inteira.
* **Portas:** o ícone de porta fica sempre visível ao mestre e abre ou fecha com um clique. Portas abertas deixam passar visão e luz.
* **Ferramenta Luzes (L):** clique para acender. Cada luz tem luz plena, penumbra, cor, intensidade e "apagada". Os tokens também podem carregar luz (tocha).
* **Visão do token:** aliados com visão revelam o mapa; "Enxerga no escuro" em células conta a partir da borda do token.
* **Cena:** névoa de guerra, escuridão (0–100%), luz do dia, lembrar áreas exploradas e o botão "Redefinir áreas exploradas".
* **Jogadores:** veem preto fora da visão, o explorado esmaecido e, com escuridão, só as áreas iluminadas ou ao alcance no escuro. Tokens fora da visão nem são enviados, e as paredes nunca saem do VTT.
* **Mestre:** vê a escuridão a 60%, com as luzes recortadas pelas paredes, e tem o botão "Ver como os jogadores".
* **Mundos antigos:** o banco normaliza os documentos também na leitura, então cenas e tokens anteriores ganham os campos novos sem migração. Um mundo antigo chegou a derrubar a mesa no teste, antes dessa correção.
* **Verificação:**
  * 94 testes, incluindo raycasting, portas, luz, alcance no escuro, exploração e a projeção não vazando token, luz ou parede escondidos;
  * typecheck e `npm run smoke`;
  * ponta a ponta no Electron real, com instância isolada: paredes e porta desenhadas pela interface, luz criada pela ferramenta, prévia do mestre, página dos jogadores com a porta fechada (Orc não enviado) e aberta (Orc aparece), e exploração esmaecida depois de mover o token.

**Fase 7: áudio local (ADR 0013)**

* **Aba Áudio:**
  * volumes geral, de música, de ambiente e de efeitos, desta máquina e gravados nas configurações;
  * "Parar tudo";
  * playlists com canal, modo (em sequência, aleatória ou mesa de sons), volume, fade em segundos e "recomeçar ao terminar";
  * faixas importadas de vários arquivos de uma vez (MP3, OGG, WAV, M4A, FLAC, WEBM e OPUS), copiadas para a pasta do mundo, com tocar ou parar, nome, volume e loop.
* **Mesa de sons:** cada clique toca a faixa de novo, e os toques podem se sobrepor.
* **Sons no mapa (ferramenta Sons, tecla M):** arquivo, alcance, volume, "paredes abafam o som" e desligado. Tocam em loop no canal Ambiente enquanto um aliado estiver no alcance, mais alto quanto mais perto.
* **Jogadores:**
  * o áudio vai na transmissão (opção no painel Jogadores);
  * a página tem "Ativar som" e um volume próprio;
  * quem entra depois ouve do mesmo ponto da faixa;
  * só os arquivos tocando podem ser baixados.
* **Range (HTTP 206)** em `vtt-asset://` e no servidor dos jogadores, para o navegador pular para o meio da faixa.
* **Verificação:**
  * 105 testes, incluindo sequência, repetição, mesa de sons, faixa apagada, sons do mapa com distância, inimigos e paredes, deslocamento pelo relógio, mistura de volumes e Range;
  * typecheck e `npm run smoke`;
  * ponta a ponta no Electron real: WAV importados pelo seletor de arquivos, a playlist tocou e avançou sozinha (abertura, brinde e de volta à abertura, cerca de 1,6 s por faixa), a página dos jogadores baixou o áudio com 206 depois de "Ativar som" e o som no mapa tocou com a aliada no alcance.

**Fase 8: regiões simples (ADR 0014)**

* **Ferramenta Regiões (tecla G):** arrastar cria um retângulo ou uma elipse, com os cantos encaixados em meias células (Alt solta o encaixe). Clicar numa região edita e arrastar move.
* **Propriedades da região:**
  * nome, forma, largura, altura e cor;
  * ativa;
  * visível aos jogadores;
  * dispara com: só aliados ou qualquer token.
* **Comportamentos:**
  * **Teleporte** para outra região, na mesma cena ou em outra, com o token encaixado na grade;
  * **Texto ao entrar:** vai ao Registro e sobe sobre o token; a opção "Só uma vez" desliga o texto depois de mostrar;
  * **Terreno difícil:** multiplicador que a régua conta ("terreno difícil" no rótulo).
* **Gatilhos:** disparam ao entrar, com qualquer movimento (mesa, teclado ou sites). Token novo, região desenhada por cima de um token e a chegada de um teleporte não disparam.
* **Jogadores:** veem só as regiões marcadas como visíveis, sem destinos nem mensagens.
* **Verificação:**
  * 111 testes, incluindo geometria, terreno na régua, texto "só uma vez", teleporte entre cenas sem ricochete, inimigos e regiões desativadas;
  * typecheck e `npm run smoke`;
  * ponta a ponta no Electron real: região criada pela ferramenta, painel de propriedades, a Seta arrastada para a Armadilha foi teleportada à Sala do Orc com o texto no Registro, a régua deu 7 células em vez de 5 atravessando a lama ×2 e a página dos jogadores mostrou a região visível e o token no destino.

**Fase 9: backup do mundo (ADR 0015)**

* **Tela de mundos, em cada mundo:**
  * **Exportar** gera um `.zip` com o manifesto, uma cópia consistente do banco (mesmo com o mundo aberto) e os assets;
  * **Snapshots** abre a lista com data, motivo e tamanho, e os botões Restaurar, Apagar e "Criar snapshot agora".
* **Importar mundo (.zip):**
  * aceita só o formato do RunasVTT;
  * confere o hash de cada asset e o banco;
  * recusa caminhos estranhos;
  * se o mundo já existe, importa como "(cópia)".
* **Snapshots automáticos:** ao abrir o mundo (início de cada sessão), só se algo mudou desde o último. Ficam em `%APPDATA%\runas-vtt\snapshots`, são mantidos os 15 mais recentes, e restaurar guarda antes o estado atual.
* **Verificação:**
  * 118 testes, incluindo o ZIP de ida e volta, exportar e importar como cópia, recusa de caminho estranho e de asset adulterado, pasta existente preservada, deduplicação, restauração, limite de 15 e ids inválidos;
  * typecheck;
  * `npm run smoke`, que agora faz no Electron real a ida e volta do `.zip` e a restauração de um snapshot;
  * ponta a ponta pela interface: snapshot de sessão ao abrir, "Criar snapshot agora" (e "Nada mudou" na repetição) e restauração devolvendo o nome antigo de um token.
* **Problema achado e corrigido nos testes:** numa importação que falhava porque a pasta de destino já existia, a limpeza tentava apagar a pasta do mundo existente.

**Instalador para Windows (ADR 0016)**

* `npm run dist` gera `dist/RunasVTT-Setup-<versão>.exe`, um NSIS por usuário: sem administrador, com escolha de pasta e atalhos na Área de Trabalho e no menu Iniciar.
* O pacote leva `out/` num `app.asar` e a cópia inicial dos sites (`site-seed.db`, atualizada por `npm run seed:sites`).
* A pasta de dados foi fixada em `%APPDATA%\runas-vtt`, a mesma usada em desenvolvimento, e desinstalar não apaga os mundos.
* Ícone: a runa "R" (`npm run icon`).
* **Verificação do app empacotado (`win-unpacked`), com pasta de dados temporária:**
  * a interface abriu de dentro do `asar`;
  * um mundo e uma cena foram criados;
  * a cópia dos sites veio junto (Tools 36, DM 30 e Book 17 arquivos);
  * a Vista dos Jogadores serviu `player.html` e os três arquivos de script e estilo de dentro do `asar`, todos com 200.

**Zoom no celular e erro ao fechar (2026-09-19)**

* **Vista dos Jogadores no celular:** o PixiJS desliga os gestos do navegador no canvas (`touch-action: none`), então não havia zoom no celular. O `SceneView` passou a tratar a pinça de dois dedos, que aproxima, afasta e move o mapa ao mesmo tempo. O segundo dedo cancela o gesto de um dedo sem mover token nem régua. A barra do espectador ganhou os botões **Aproximar** e **Afastar**, e a página inteira bloqueia o zoom do navegador para a interface não sair do lugar.
* **Erro ao fechar o app** ("Object has been destroyed" em `BrowserManager.close`): no `before-quit`, a janela principal já tinha sido destruída quando as abas do navegador integrado eram fechadas. `close` e `layout` passaram a ignorar a janela destruída. O erro só aparecia com alguma aba aberta.
* **Verificação:** pinça para aproximar e afastar, arraste com um dedo e botões testados em viewport de celular contra a transmissão real (`--smoke-player-server`). O fechamento foi testado com uma aba aberta pelo protocolo de depuração: a caixa de erro abria antes da correção e não abre depois.

**Releases no GitHub (ADR 0018)**

* `.github/workflows/release.yml`: um push de tag `v*` roda, num runner Windows, typecheck, testes, `seed:sites`, smoke e electron-builder. Depois publica a Release com o `.exe`, o `SHA256SUMS.txt` e notas geradas dos commits.
* Para publicar: `npm version patch` (ou `minor`/`major`) e `git push --follow-tags` na `main`. O workflow recusa a tag que não bate com o `package.json`. Tags com hífen viram pré-release.
* Rodar o workflow manualmente pela aba Actions gera o instalador só como artefato, sem Release.
* O repositório é público desde 2026-09-19; qualquer pessoa baixa o instalador em [Releases](https://github.com/Player07x/RunasVTT/releases).
* **Sem assinatura:** o SmartScreen avisa na primeira execução.

**Jogadores movem tokens "Jogador" (ADR 0017)**

* **Nova categoria "Jogador"** (borda verde): conta como aliada para visão, sons do mapa, regiões e barras. As fichas do Runas Tools entram como Jogador.
* **Na página dos jogadores,** tokens Jogador ficam arrastáveis, com régua durante o arraste. O VTT confere cada pedido e recusa:
  * token que não é Jogador, está oculto ou travado;
  * destino fora do mapa;
  * caminho que toca parede ou porta fechada, inclusive na junta de duas paredes.

  O destino é encaixado na grade pelo próprio VTT. Na recusa, o token volta ao lugar e o espectador vê o motivo.
* **No painel Jogadores:** "Jogadores podem mover os tokens marcados como Jogador" (ligado por padrão).
* **Proteções:** no máximo 8 pedidos por segundo por espectador, mensagens de até 16 KB, e os movimentos aceitos passam pelo mesmo caminho da mesa (visão, regiões, áudio e sites).
* **Verificação:**
  * 126 testes;
  * no Electron real, pela página dos jogadores: Jogador movido e encaixado, Hostil não arrastável, parede bloqueando com aviso, passagem pela porta aberta e nada se move com a opção desligada.
* **Bug achado e corrigido:** a checagem de parede deixava passar exatamente pela junta de duas paredes.

**Fases 0 a 10 concluídas.** Os ADRs 0019 e 0020 foram aceitos; a sessão de jogadores foi publicada com a Release `v0.3.1`, incluindo o instalador Windows e o seed offline atualizado do Runas Tools.

\---

## 11\. Pendências e riscos

### Mudanças necessárias na Runas Suite (Fase 4)

* Core: imagem de token no `Character`, com `CHARACTER\_VERSION`, migração e teste. Tools: campo na ficha avançada. DM: editor de token.
* Revisar os service workers da suíte para convivência com o espelho local do VTT.

### Pendências da Fase 1 que dependem de outras fases ou de você

* **Obsidian por pasta local no Electron:** não dá para automatizar (exige escolher a pasta no diálogo). A permissão `fileSystem` está liberada na sessão da suíte; validar manualmente.
* **Card "Instalar Runas DM" (PWA) aparece dentro do VTT:** já oculto quando `window.runasVTT` existe.
* **Cloudflare Access não está ativo em `runas-dm.pages.dev`** (a página responde 200 sem login), apesar de a documentação da suíte exigir. O risco é baixo (dados locais, API com token), mas a configuração deve ser conferida no painel da Cloudflare.

### Pendências da Fase 5

* O link público depende do primeiro download do `cloudflared`, que é opcional, pede confirmação no painel e exige conectividade para baixar/verificar o release oficial. O app consulta o release oficial da Cloudflare no GitHub, lê o checksum publicado e aceita o redirecionamento para `release-assets.githubusercontent.com`; a rede local não depende dele.

### Limitações conhecidas da Fase 2 (para fases futuras)

* Sem desfazer/refazer.
* Sem alças para redimensionar ou girar com o mouse (é feito pelo painel de propriedades).
* Ao trocar a grade de quadrada para hexagonal, os tokens não são reencaixados automaticamente.
* Paredes não bloqueiam o movimento dos tokens (só o mestre move; ADR 0001).

### Achados fora do escopo

* O repositório da suíte versiona a pasta `.pnpm-store/` (2.814 arquivos) desde o primeiro commit. Isso incha o repositório e impede criar *worktrees* no Windows (caminhos longos demais). Sugestão: remover do Git e ignorar.
* O JavaScript inicial do Tools está a 24 KB do limite do `check:bundle`.

### Riscos

* **Espelho same-origin:** validado na Fase 1, inclusive com os service workers dos sites. Resta observar o comportamento quando um site publicar um build novo enquanto o VTT estiver offline por muito tempo.
* **Obsidian no Electron:** permissões da File System Access API.
* **Desempenho de visão e luz** em mapas grandes (Fase 6): mitigar com Web Workers e cache de polígonos.
* **Deriva do contrato da ponte** entre dois repositórios: mitigar com versionamento e testes dos dois lados.
* **Servidor de transmissão exposto na rede local:** mitigado por desligado por padrão, chave por sessão, projeção sem campos privados, filtro de assets e somente leitura; ainda requer que o mestre confie na própria rede e na distribuição do link.
* **Escrita de ficha pela rede (Fase 10):** o VTT passará a aceitar fichas de clientes autenticados por código. Mitigado por cookie de assento, `Origin` validado, quotas, sanitização no ingresso e revogação ao desligar a transmissão; ainda assim é a maior ampliação de superfície desde o ADR 0009.
* **Ficha de terceiro em contexto privilegiado (Fase 10):** a ficha do jogador é renderizada pela Mesa do Runas DM dentro do navegador integrado, que expõe `window.runasVTT`. Uma falha de sanitização vira execução de script com acesso ao mundo do mestre.
* **Espelho sem o Runas Tools (Fase 10):** se a cópia local estiver vazia, o jogador não abre a ficha. O painel precisa avisar antes de a sessão começar.
* **Ritmo:** o gargalo é o tempo de teste e revisão do usuário, não a escrita de código.

\---

## 12\. Histórico de mudanças

|Data|Mudança|
|-|-|
|2026-09-21|Correções da Fase 10: áudio longo deixou de morrer aos ~4 min (o teto de 4 MB por requisição em `world-assets.ts` fazia o Chromium encerrar a mídia com `error` no fim do trecho — Range aberta agora vai até o fim do arquivo e o corpo é transmitido por stream), `AudioEngine` passou a tratar `error` como fim de faixa para a playlist avançar, e o Runas Tools abre dentro da própria Vista dos Jogadores em vez de uma aba separada.|
|2026-09-21|Fase 10 concluída (M20 / ADRs 0019 e 0020): sessões com assentos, lobby por código, Runas Tools servido na mesma origem, fichas `seat-character` anexadas à Mesa e sincronização bidirecional com conflitos por revisão. CI, deploy do Tools/DM e Release `v0.3.1` (instalador Windows e `SHA256SUMS.txt`) publicados.|
|2026-09-21|Fase 10 (etapas 10.0–10.6): lobby por código e cookie, Tools servido pelo VTT com shim por assento, ficha `seat-character` anexada à Mesa, sincronização bidirecional por HTTP/WebSocket, conflitos por revisão, limites de ingresso/escrita, `Origin`, service worker bloqueado e movimento restrito ao token do jogador. A matriz final da etapa 10.7 e a publicação ficam em validação.|
|2026-09-20|Fase 10 iniciada (etapa 10.1): `PlayerSession` efêmera com 1–12 assentos, hash de códigos, tokens/revogação/revisão, IPC e tabela de códigos no painel do mestre. Typecheck, 131 testes e smoke do Electron passaram; as etapas 10.2–10.7 continuam planejadas.|
|2026-09-20|Fase 10 planejada (M20 / ADRs 0019 e 0020): sessões com assentos e código por jogador, Runas Tools servido pelo próprio VTT, ficha do assento guardada no mundo, ficha por HTTP com revisão e conflito, e WebSocket só para avisos. Revisa os ADRs 0001, 0002, 0009 e 0017; nada implementado ainda.|
|2026-09-19|Vista dos Jogadores com pinça de dois dedos e botões de zoom no celular; corrigido o erro "Object has been destroyed" ao fechar o app com abas abertas. Release `v0.2.1`.|
|2026-09-19|Repositório `Player07x/RunasVTT` tornado público (histórico conferido sem segredos) e primeira Release, `v0.2.0`.|
|2026-09-19|Releases no GitHub (M19 / ADR 0018): workflow `release.yml` gera o instalador Windows a cada tag `v*` e o publica numa Release com SHA-256; `npm version` cria o commit e a tag.|
|2026-09-18|Espectadores movem tokens "Jogador" (M18 / ADR 0017): nova categoria, pedido validado no VTT, opção no painel Jogadores; `lineBlocked` corrigido para as juntas entre paredes.|
|2026-09-18|Instalador Windows (M17 / ADR 0016): `npm run dist` com electron-builder (NSIS por usuário), ícone, cópia inicial dos sites no pacote e `userData` fixo em `%APPDATA%\runas-vtt`.|
|2026-09-18|Fase 9 concluída: exportar e importar o mundo em `.zip` (ZIP próprio, validação de hash e de caminhos) e snapshots do banco por sessão, manuais e antes de restaurar (ADR 0015). Plano vigente concluído.|
|2026-09-18|Fase 8 concluída: regiões (retângulo ou elipse) com teleporte entre cenas, texto ao entrar ("só uma vez") e terreno difícil na régua; gatilhos no processo principal (ADR 0014).|
|2026-09-18|Fase 7 concluída: playlists (sequência, aleatória, mesa de sons), faixas com loop e volume, canais e fade, sons no mapa ouvidos pelos aliados, áudio sincronizado na Vista dos Jogadores e Range nos assets (ADR 0013).|
|2026-09-18|Fase 6 concluída: paredes, portas, luzes, visão dos tokens, escuridão e névoa com memória do explorado, calculadas no processo principal (ADR 0012); leitura do banco normalizada para mundos antigos.|
|2026-09-18|Correções da Fase 5: link público com chave, câmera dos jogadores independente, régua transmitida e régua local do espectador, dano para os espectadores, F espelha o token, sem moldura de seleção, Configurações com atalhos e Token de Acesso (ADRs 0010 e 0011).|
|2026-09-18|Pesquisa dos recursos do FoundryVTT (V14) e plano original de 12 fases.|
|2026-09-18|Estimativa de prazo e custo; confirmado o funcionamento offline, em LAN e online.|
|2026-09-18|Criado o repositório privado `Player07x/RunasVTT`.|
|2026-09-18|Revisão do plano pelo usuário (M1–M13): navegador integrado, ponte com os sites, Vista dos Jogadores e remoção das fases 7, 9 e 11 originais e do vídeo.|
|2026-09-18|Runas Suite `e226df6`: DM sem senha; Campanhas e Wiki abertas; token só para backup (M14). Publicado.|
|2026-09-18|Runas Suite `9e52973`: Book só com token (M15). Publicado.|
|2026-09-18|Início da Fase 0: base Electron + React, formato do mundo v1 com SQLite, testes.|
|2026-09-18|Criado este documento.|
|2026-09-18|Fase 2 concluída: cenas, grades quadrada e hexagonal, tokens, tiles, desenhos, notas, régua, seleção e arraste, painel de propriedades, importação de imagens por hash (`vtt-asset://`) e ADR 0008.|
|2026-09-18|Fase 1 concluída: navegador integrado com cópia local na mesma origem, sessões suíte/web separadas, atualização automática, modo offline forçado, cópia inicial (`seed:sites`) e teste contra os sites reais (`smoke:browser`). Correções encontradas nos testes: redirecionamento (troca de `session.fetch` por `net.request`), HEAD offline, assets referenciados por CSS, manifesto e service worker, e área da página com altura zero.|
|2026-09-18|Fase 0 concluída: ADRs 0001–0007, AGENTS.md, README, CI, smoke test no Electron e verificação visual (corrigido botão "Mundos" esticado na barra da mesa).|
|2026-09-18|Decisão M16 / ADR 0009: a Vista dos Jogadores passa a ser uma página web transmitida pelo VTT (servidor somente leitura, projeção filtrada, link local com QR code e link público opcional via Cloudflare Quick Tunnel). ADRs 0001 e 0005 revisados; Fase 5 reestimada em 2–3 semanas.|
|2026-09-18|Vista dos Jogadores sem dependência do Discord (transmissão de vídeo bloqueada no Brasil): projeto.md e ADR 0005 listam TV/monitor, Meet, Teams, Zoom, Jitsi e OBS, com requisitos de captura da janela.|
|2026-09-18|Fase 4 concluída: token da ficha (Character v21), editor de token no DM e no Tools, desenho compartilhado em `@runas/vtt-bridge` e tamanho do token no VTT; suíte publicada e teste de ponta a ponta aprovado.|
|2026-09-18|Fase 5 concluída: servidor HTTP/WebSocket somente leitura, projeção segura, página `player.html` com SceneView não editável, link LAN com QR, câmera sincronizada, janela local pela mesma URL e túnel Cloudflare opcional verificado; typecheck, testes, smoke e navegador externo aprovados.|
|2026-09-18|Ajustes finais da Fase 5: moldura dos tokens passou a se ajustar à área ocupada; a seleção de um clique sem movimento é publicada no `pointerup`, fazendo a ficha abrir apenas ao clicar.|
|2026-09-18|Correções da Vista dos Jogadores: Quick Tunnel usa os metadados e o checksum do release oficial atual do `cloudflared`; imagens transparentes mantêm o alpha e a borda colorida acompanha a silhueta; arrastar um token não publica seleção nem abre ficha.|
|2026-09-18|Revisão da Fase 3: corrigidos o arquivo do core que faltava no commit da suíte, as mensagens de erro da ponte, o "Iniciar encontro" dentro do VTT e o espaçamento dos tokens importados; suíte publicada; teste de ponta a ponta contra os sites reais aprovado.|
|2026-09-18|Fase 3 concluída: ponte `runasVTT` restrita às origens da suíte, importação Tools/DM → tokens, Mesa do DM sobre tokens, dano confirmado, Registro e textos flutuantes; testes e smoke do Electron aprovados.|
