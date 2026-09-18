# RunasVTT — documentação do projeto

> Documento vivo. Reúne a proposta, o plano, as decisões, o estado atual e o histórico de mudanças do RunasVTT. Toda mudança de escopo, decisão ou fase concluída deve ser registrada aqui, na seção correspondente e no [Histórico de mudanças](#12-histórico-de-mudanças).

- **Repositório:** [Player07x/RunasVTT](https://github.com/Player07x/RunasVTT) (privado)
- **Pasta local:** `C:\Users\joaoa\Desktop\Repositorios\RunasVTT`
- **Projeto relacionado:** [Player07x/Runas-Core](https://github.com/Player07x/Runas-Core) (Runas Suite), em `C:\Users\joaoa\Desktop\Repositorios\runas-suite`
- **Última atualização:** 2026-09-18

---

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

---

## 1. Proposta

O RunasVTT é uma **mesa virtual (VTT) desktop, instalável e offline**, inspirada nos recursos do FoundryVTT, feita para o mestre conduzir sessões de RPG com as regras da Runas Suite.

A ideia central, definida pelo usuário na revisão do plano, é que **o VTT não copia nenhum recurso dos sites da Runas Suite**. Em vez disso:

- O VTT cuida do que é exclusivamente de mesa: **mapa, cenas, tokens, paredes, visão, luz, névoa, áudio e a tela dos jogadores**.
- Os sites **Runas Tools, Runas DM e Runas Book** rodam dentro de um **navegador integrado** ao VTT, em tempo real, com uma cópia local para funcionar sem internet.
- Ao detectar que estão dentro do VTT, os sites mudam o comportamento: **exportar ficha passa a importar para o VTT**, e **dano e testes são aplicados ao token selecionado**.
- Fichas, testes, dano e regras continuam sendo calculados **pelos sites** (que usam o `@runas/core`). O VTT nunca reimplementa regra.

**Quem usa:** somente o mestre, em uma máquina. Os jogadores veem a **Vista dos Jogadores**, uma janela limpa, sem HUD, exibida em um segundo monitor ou TV, ou compartilhada pelo Discord ou OBS.

**Custo contínuo:** nenhum obrigatório. O app roda localmente, e os serviços da suíte já usam a camada gratuita da Cloudflare.

---

## 2. Princípios e restrições

1. **Offline-first.** Todo o fluxo de mesa funciona sem internet. A rede só serve para atualizar os sites e para o backup opcional de cada site.
2. **Zero regra duplicada.** O VTT não depende do `@runas/core` e não interpreta o formato `Character`. Ele guarda a ficha recebida como um envelope opaco e mostra apenas o resumo enviado pelo site (ADR 0003).
3. **O mundo é uma pasta.** Copiar a pasta do mundo é um backup completo, com banco, mapas, tokens e áudio.
4. **Só o mestre opera o VTT.** Não há servidor multiusuário, contas nem permissões por jogador (ADR 0001).
5. **O VTT é a fonte da verdade do estado dos tokens.** Dentro do VTT, a Mesa do Runas DM opera sobre os tokens da cena, não sobre cópias próprias (ADR 0006).
6. **Implementação independente (clean-room).** O código, os assets e a marca do FoundryVTT são proprietários: reproduzimos ideias de recursos, nunca código, CSS, ícones ou nomes.
7. **As regras da Runas Suite continuam valendo** para toda mudança feita nela por causa do VTT (ver `AGENTS.md` do runas-suite): migração de `Character` só em `characterStorage.ts`, testes no core, e typecheck e build de todos os consumidores.

---

## 3. Arquitetura

```text
RunasVTT (Electron 44 · Node 24 · Chromium)
 ├── Processo principal (src/main)
 │     ├── WorldStore: pasta de mundos, manifesto, abrir/fechar
 │     ├── WorldDatabase: SQLite nativo do Node (node:sqlite), migrações por user_version
 │     ├── BrowserManager: abas (WebContentsView), sessões persist:runas-sites e persist:web
 │     ├── SiteMirror + site-responder: cópia local same-origin (node:sqlite), atualização automática
 │     └── [Fase 3] Ponte runasVTT: IPC restrito às origens da Runas Suite
 ├── Preload (src/preload): expõe window.vtt para a interface do VTT
 ├── Interface (src/renderer): React 19 + [Fase 2] PixiJS 8 no canvas
 └── [Fase 5] Janela da Vista dos Jogadores (sem HUD)
```

**Pilha:** Electron 44, electron-vite 5, Vite 7, React 19, TypeScript 5.9, Vitest 3, lucide-react. SQLite via `node:sqlite`, embutido no Node 24 do Electron, sem módulo nativo para compilar. Isso foi verificado no runtime real do Electron.

### Formato do mundo (versão 1)

```text
%APPDATA%\RunasVTT\worlds\<nome>-<id8>\
  world.json   manifesto: formatVersion, id, title, description, rulesetId, createdAt, updatedAt
  world.db     SQLite: tabela documents (id, type, parent_id, sort, data JSON, created_at, updated_at)
  assets\maps  assets\tokens  assets\tiles  assets\audio   (arquivos nomeados pelo hash)
```

- **Tipos de documento:** `scene`, `token`, `tile`, `drawing`, `note`, `wall`, `light`, `region`, `sound`, `playlist`, `track` e `log-entry`. O formato de `data` de cada tipo é definido na fase correspondente.
- **Exclusão em cascata:** apagar uma cena apaga os tokens, as paredes e tudo o que ela contém, pela chave estrangeira `parent_id`.
- **Versões futuras são recusadas:** um manifesto ou banco de versão mais nova é recusado com a mensagem "Atualize o RunasVTT", em vez de arriscar corromper o mundo.
- **Gravação do manifesto:** o `world.json` é gravado de forma atômica (arquivo temporário e depois `rename`).

---

## 4. Integração com a Runas Suite

### 4.1 Navegador integrado com os sites instalados localmente

- O navegador sempre abre o **endereço real** de cada site: `runas-tools.pages.dev`, `runas-dm.pages.dev` e `runas-book.pages.dev`.
- O VTT intercepta as requisições. Com internet, busca na rede e atualiza a cópia local; sem internet, entrega a cópia local.
- **Motivo:** IndexedDB e localStorage são separados por origem. Servir a cópia local em outro endereço (ex.: `runas://tools`) separaria os dados, e as fichas "sumiriam" ao alternar entre online e offline.
- **O instalador já traz uma cópia dos 3 sites,** então funciona offline desde a primeira abertura.
- **Nunca entram na cópia local:** `/api/backup`, `/api/campaign-data`, `/api/book-auth`, `/cdn-cgi/`, autenticação e payloads RSC. É a mesma regra dos service workers da suíte.
- **Cloudflare Access:** o login é feito uma vez no navegador integrado e a sessão fica guardada.
- **Obsidian:** a sincronização por pasta local (File System Access API) precisa ser testada no Chromium do Electron, porque as permissões funcionam de outro jeito.

### 4.2 Ponte `window.runasVTT`

Ela é injetada **somente** nas origens da Runas Suite. Sites externos, como o YouTube, nunca a recebem. Os sites detectam a ponte pela presença do objeto, e não pelo *user agent*.

| Ação no site | Fora do VTT | Dentro do VTT |
|---|---|---|
| Exportar ficha (Tools/DM) | baixa JSON/ZIP | importa para o VTT como ator + token |
| Aplicar dano (Mesa do DM) | aplica no ator da Mesa | aplica no token selecionado no VTT |
| Testes | resultado no painel | resultado no painel e no Registro do VTT, com texto sobre o token |

**Fluxo de dano:**
1. O site pede à ponte a ficha do token selecionado.
2. O site calcula a simulação com o `@runas/core`.
3. Na confirmação explícita, o site devolve a ficha atualizada e o resumo para as barras.

O contrato será versionado em um pacote próprio, sugerido `runas-suite/packages/vtt-bridge`, e toda mudança nele exige validar os dois lados.

### 4.3 Imagem da ficha vira token

- `Character.portraitDataUrl` (JPEG 512×512) passa a ser uma **imagem de token**: PNG ou WebP com transparência, com moldura opcional e tamanho em quadrados da grade.
- **Exige mudanças na suíte:**
  - novo `CHARACTER_VERSION` e migração em `characterStorage.ts`;
  - teste no core;
  - campo também na ficha avançada do Runas Tools, pela regra de paridade;
  - o recorte de retrato do DM vira um editor de token.
- Ao importar a ficha, o VTT cria o token com essa mesma imagem.

### 4.4 Autenticação dos sites (já aplicada)

- **Runas DM:** Campanhas e Wiki abrem sem login nem senha. O token de backup só ativa a cópia na nuvem (D1).
- **Runas Book:** a área DM é desbloqueada só pelo token, sem senha.
- **Pré-requisito do VTT:** com isso, a área privada do DM funciona offline dentro do navegador integrado.

---

## 5. Referência: recursos do FoundryVTT e cobertura no RunasVTT

Pesquisa feita em 2026-09-18, com o FoundryVTT na **V14 estável** (14.359 como primeira estável; V14.5 e V15 em planejamento). Ele é vendido por licença única e tem cerca de 475 sistemas e 5.338 módulos.

| Área do Foundry | Principais recursos | No RunasVTT |
|---|---|---|
| Plataforma | Servidor Node + Electron, jogadores pelo navegador, Setup de mundos/sistemas/módulos, licença, backups e snapshots | **Parcial:** app Electron, mundos em pasta e backup da pasta. Sem servidor multiusuário, sem módulos. |
| Dados | Documents (Actor, Item, Scene, Journal, Macro, Playlist, RollTable, Cards, Combat, ChatMessage, User, Folder, Adventure, ActiveEffect), compêndios, pastas, UUIDs, flags | **Parcial:** documentos de mesa. Ficha, itens e jornal ficam nos sites. |
| Usuários | Papéis (Player, Trusted, Assistant, GM), propriedade por documento | **Fora:** só o mestre usa. |
| Canvas | Cena, grade quadrada/hex/sem grade, tokens (barras, condições, alvo, elevação, anéis, movimento com waypoints), régua | **Sim:** Fase 2. |
| Paredes/visão | Paredes com restrições independentes, portas e secretas, visão por token, modos de visão e detecção | **Sim:** Fase 6. |
| Luz/névoa | Luzes com animações, escuridão, iluminação global, névoa persistente e compartilhada | **Sim:** Fase 6. |
| Tiles, desenhos, notas | Imagens e vídeos em camadas, oclusão, desenhos e texto, alfinetes de jornal | **Sim:** Fase 2. As notas apontam para páginas dos sites. |
| Regiões | Formas, comportamentos (teleporte, terreno, escuridão, texto, macro), eventos de token e turno; templates de área absorvidos na V14 | **Opcional:** Fase 8, versão simples. |
| Scene Levels (V14) | Andares empilhados na mesma cena | **Fora.** |
| Chat e dados | Modos de rolagem, sussurros, rolagens inline, motor de dados completo | **Delegado:** os testes são dos sites. O VTT mostra o Registro. |
| Combate | Tracker, iniciativa, rodadas, derrotados, grupos, Active Effects V2 | **Delegado:** a Mesa do DM opera sobre os tokens. |
| Jornal | Páginas, ProseMirror, segredos, links | **Delegado:** Wiki e Campanhas do DM, e o Runas Book. |
| Áudio/vídeo | Playlists, sons posicionais, A/V por WebRTC | **Sim:** só áudio local (Fase 7). Vídeo e streaming pelo navegador integrado. Sem A/V. |
| Tabelas, cartas, macros | Roll Tables, Cards, macros de script | **Fora** por ora. |
| Extensibilidade | Sistemas e módulos, API de hooks, Marketplace | **Fora.** |
| Interface | Pop-outs, temas, atalhos, localização | **Parcial:** tema escuro da suíte, pt-BR. |

---

## 6. Plano original

Primeira versão, antes da revisão do usuário. Mantida aqui como histórico.

**Arquitetura original:**
- Electron com servidor Node embutido (Fastify + WebSocket), autoritativo;
- SQLite por mundo, cliente React + PixiJS;
- jogadores conectados pelo navegador;
- o VTT consumindo `@runas/core` diretamente para calcular regras;
- extração de `packages/runas-knowledge` do DM para reaproveitar Wiki, Cronologia, História e Obsidian.

| # | Fase original | Estimativa (1 dev) |
|---|---|---|
| 0 | Fundações, ADRs, extração de `runas-knowledge` | 2–3 sem |
| 1 | Servidor e persistência, permissões e sessões | 4–6 sem |
| 2 | Cliente-base e fichas (importação, ficha, testes e dano no chat) | 5–6 sem |
| 3 | Canvas essencial | 6–8 sem |
| 4 | Combate | 3–4 sem |
| 5 | Visão, paredes, luz e névoa | 8–10 sem |
| 6 | Regiões, efeitos, macros, tabelas e cartas | 6 sem |
| 7 | Conteúdo: jornal = Wiki, Obsidian, compêndios, aventuras | 4–5 sem |
| 8 | Áudio e vídeo (WebRTC) | 3–4 sem |
| 9 | Rede e distribuição (instalador, LAN, túnel, HTTPS) | 3–4 sem |
| 10 | Integração com a nuvem da suíte (D1, Access Service Token) | 2–3 sem |
| 11 | Paridade avançada (níveis, partículas, API de plugins) | contínua |

Estimativa original para paridade: 18 a 30 meses para uma pessoa. Com o Claude: MVP em 1 a 2 meses e paridade próxima da V14 em 6 a 10 meses.

---

## 7. Mudanças propostas pelo usuário

Registradas em 2026-09-18.

| # | Proposta do usuário | Efeito no plano |
|---|---|---|
| M1 | Fase 7 (conteúdo) não é necessária: basta um **navegador integrado** | Wiki, compêndios e jornal ficam nos sites. A extração de `runas-knowledge` foi cancelada. |
| M2 | Dentro do VTT, **exportar ficha importa para o VTT** em vez de baixar | Ponte `runasVTT` e ajuste nos botões de exportar do Tools e do DM |
| M3 | No DM, anexar **token** em vez de imagem; a imagem do token importado é a mesma | Mudança no `Character` (seção 4.3) |
| M4 | O navegador já vem com **os 3 sites instalados localmente** e os atualiza com internet | Espelho local same-origin (seção 4.1) |
| M5 | Fase 8: **sem vídeo**, só áudio importado localmente. Vídeo é possível pelo navegador | A/V por WebRTC removido. Áudio local mantido. |
| M6 | **Compartilhar a tela sem HUD**, só objetos e cenário | Nova fase: Vista dos Jogadores |
| M7 | Fase 9 (distribuição e rede) não é necessária no momento | Removida. Instalador e jogadores remotos ficam para depois. |
| M8 | Fase 10 (nuvem) precisa ser repensada | Os sites continuam fazendo o próprio backup. O VTT só faz backup do próprio mundo. |
| M9 | Fase 11 (paridade avançada) não será implementada | Removida |
| M10 | Fase 2: dentro do VTT, o site oferece **aplicar dano no token selecionado** | Ponte e ajuste na Mesa do DM |
| M11 | Princípio geral: **não copiar recursos dos sites**; usar os sites em tempo real pelo navegador local | O VTT não depende do `@runas/core` (ADR 0003) |
| M12 | Só o mestre usa o VTT; os jogadores veem pela tela compartilhada | Sem servidor multiusuário nem permissões (ADR 0001) |
| M13 | A Mesa do DM usa os tokens do VTT como atores | O VTT é a fonte da verdade dos tokens (ADR 0006) |
| M14 | Remover a senha do Runas DM: Campanhas e Wiki sem login, token só para o backup | Aplicado no runas-suite (`e226df6`) |
| M15 | Runas Book: usar apenas o token, sem senha | Aplicado no runas-suite (`9e52973`) |

---

## 8. Plano revisado (vigente)

| # | Fase | Onde | Estimativa | Status |
|---|---|---|---|---|
| 0 | Fundações: Electron + Vite + React + TS, formato do mundo, ADRs | RunasVTT | 1 sem | **Concluída** (2026-09-18) |
| 1 | Navegador integrado: abas, sessão persistente, espelho local same-origin, atualização | RunasVTT | 2–3 sem | **Concluída** (2026-09-18). A ponte `runasVTT` foi para a Fase 3, junto do contrato. |
| 2 | Canvas essencial: cenas, grade quadrada/hex, tokens, barras PV/PA/PE, régua, tiles, desenhos, notas | RunasVTT | 3–4 sem | Pendente |
| 3 | Integração: contrato da ponte, exportar→importar, dano no token selecionado, testes no Registro, Mesa sobre tokens | ambos | 2–3 sem | Pendente |
| 4 | Imagem → token: `CHARACTER_VERSION`, migração, editor de token no DM, campo no Tools | runas-suite | 1 sem | Pendente |
| 5 | Vista dos Jogadores (janela sem HUD) | RunasVTT | 1–2 sem | Pendente |
| 6 | Paredes, portas, visão, luz e névoa | RunasVTT | 5–8 sem | Pendente |
| 7 | Áudio local: playlists, loop, fade, canais, sons posicionais | RunasVTT | 1 sem | Pendente |
| 8 | Regiões simples: teleporte, texto, terreno (opcional) | RunasVTT | 2 sem | Pendente |
| 9 | Backup do mundo: exportar `.zip` e snapshot antes de cada sessão | RunasVTT | 3 dias | Pendente |

- **Marcos:** o MVP jogável corresponde às fases 0 a 5 (cerca de 2 a 3 meses). Com visão e luz, cerca de 3,5 a 5 meses.
- **Removidos:** jornal e compêndios, vídeo e A/V, distribuição e rede, nuvem própria do VTT e paridade avançada.

---

## 9. Decisões registradas

| ADR | Decisão | Motivo |
|---|---|---|
| 0001 | Só o mestre usa o VTT, em uma máquina. Sem servidor multiusuário. | M12. Elimina WebSocket, contas e permissões. |
| 0002 | Navegador integrado com espelho local **na mesma origem** dos sites | Preserva IndexedDB e localStorage entre online e offline (seção 4.1) |
| 0003 | O VTT não interpreta `Character`: guarda o envelope opaco e o resumo enviado pelo site | Evita duplicar regras (M11 e regra da suíte) |
| 0004 | Mundo = pasta com `world.json`, `world.db` (SQLite `node:sqlite`) e `assets/` | Backup por cópia, sem módulo nativo, migrações versionadas |
| 0005 | Vista dos Jogadores = janela Electron separada que renderiza a cena sem HUD | M6. Funciona em outro monitor, TV, Discord ou OBS. |
| 0006 | O VTT é a fonte da verdade dos tokens; o token é uma cópia independente da ficha | M13. Evita duas "mesas" divergentes e mantém a regra da Mesa do DM. |
| 0007 | Electron em vez de Tauri | Chromium embutido e controlado para o navegador integrado, e ecossistema TypeScript |

Os ADRs detalhados ficam em [`docs/adr/`](adr/).

---

## 10. Estado atual

Atualizado em 2026-09-18.

### Runas Suite (aplicado e publicado)
- `e226df6`: Runas DM, Campanhas e Wiki sem login; o token só ativa o backup na nuvem. Publicado em `runas-dm.pages.dev`.
- `9e52973`: Runas Book, área DM só com token. Publicado em `runas-book.pages.dev`.
- Secrets na Cloudflare: token novo cadastrado no DM e no Book; `RUNAS_DM_CAMPAIGN_PASSWORD` removido pelo usuário. O mesmo token vale nos dois sites (confirmado pelo usuário).

### RunasVTT (Fases 0 e 1 concluídas)

**Fase 0: fundações**
- Electron 44.4.2 (Node 24.21), electron-vite 5, Vite 7, React 19, TypeScript 5.9 e Vitest 3.
- Mundo em pasta (`world.json`, `world.db` com `node:sqlite` e `assets/`); tela de mundos e esqueleto da mesa.
- ADRs 0001–0007, `AGENTS.md`, README e CI.

**Fase 1: navegador integrado**
- **Abas e interface:** abas em `WebContentsView` no painel lateral (redimensionável, com botão para expandir), barra de endereço, voltar, avançar, recarregar e uma nova aba com atalhos para os 3 sites ou qualquer endereço.
- **Cópia local na mesma origem:** a página continua em `https://runas-*.pages.dev` com internet ou sem ela, e os dados dos sites (IndexedDB) ficam os mesmos.
- **Sessões separadas:** os sites da suíte ficam em `persist:runas-sites`, com cópia local; a web externa fica em `persist:web`, sem interceptação.
- **Indicador de origem:** mostra se a página veio *Online*, da *Cópia local* ou está *Indisponível*.
- **Painel "Funcionamento offline":**
  - *Preparar offline*, com progresso;
  - tamanho da cópia de cada site;
  - *Forçar modo offline*, para testar ou para usar sem rede.
- **Atualização automática** ao abrir, quando a internet volta e a cada 6 h. Arquivos de builds antigos são limpos.
- **Cópia inicial para a primeira execução:** `npm run seed:sites`.
- **Nunca copiados:** `/api/*`, `/cdn-cgi/*`, RSC, POST e respostas com `no-store` ou `set-cookie`.
- **Verificações:**
  - 27 testes unitários;
  - `npm run smoke`;
  - `npm run smoke:browser` contra os sites reais: online, redirecionamento 308, POST (401), cópia de 84 arquivos sem falhas e as 8 páginas principais dos 3 sites abrindo offline sem nenhuma requisição à rede;
  - teste de ponta a ponta da interface no Electron via DevTools Protocol: a página ocupa exatamente a área reservada, e *Preparar offline* seguido de modo offline forçado e recarga abriu o Runas DM da cópia, com as fichas preservadas.

**Importante para o uso:** o navegador do VTT é um perfil separado do Chrome. As fichas e a Wiki que você já tem no Chrome **não aparecem** automaticamente no VTT. Para levá-las, use uma destas opções:
- Runas DM: token de backup → *Backup na nuvem* no Chrome → *Importar da nuvem* no VTT;
- exportação e importação de JSON/ZIP;
- sincronização com o Obsidian.

**Próximo passo:** Fase 2, o canvas essencial (cenas, grade, tokens).

---

## 11. Pendências e riscos

### Mudanças necessárias na Runas Suite (Fases 3 e 4)
- Pacote de contrato `packages/vtt-bridge` (tipos e versão da ponte).
- Tools e DM: detectar `window.runasVTT` e trocar exportar por importar para o VTT.
- DM: Mesa sobre os tokens do VTT; opção de aplicar dano no token selecionado; enviar testes ao Registro.
- Core: imagem de token no `Character`, com `CHARACTER_VERSION`, migração e teste. Tools: campo na ficha avançada. DM: editor de token.
- Revisar os service workers da suíte para convivência com o espelho local do VTT.

### Pendências da Fase 1 que dependem de outras fases ou de você
- **Obsidian por pasta local no Electron:** não dá para automatizar (exige escolher a pasta no diálogo). A permissão `fileSystem` está liberada na sessão da suíte; validar manualmente.
- **Card "Instalar Runas DM" (PWA) aparece dentro do VTT:** esconder quando `window.runasVTT` existir (mudança na suíte, Fase 3).
- **Cloudflare Access não está ativo em `runas-dm.pages.dev`** (a página responde 200 sem login), apesar de a documentação da suíte exigir. O risco é baixo (dados locais, API com token), mas a configuração deve ser conferida no painel da Cloudflare.

### Riscos
- **Espelho same-origin:** validado na Fase 1, inclusive com os service workers dos sites. Resta observar o comportamento quando um site publicar um build novo enquanto o VTT estiver offline por muito tempo.
- **Obsidian no Electron:** permissões da File System Access API.
- **Desempenho de visão e luz** em mapas grandes (Fase 6): mitigar com Web Workers e cache de polígonos.
- **Deriva do contrato da ponte** entre dois repositórios: mitigar com versionamento e testes dos dois lados.
- **Ritmo:** o gargalo é o tempo de teste e revisão do usuário, não a escrita de código.

---

## 12. Histórico de mudanças

| Data | Mudança |
|---|---|
| 2026-09-18 | Pesquisa dos recursos do FoundryVTT (V14) e plano original de 12 fases. |
| 2026-09-18 | Estimativa de prazo e custo; confirmado o funcionamento offline, em LAN e online. |
| 2026-09-18 | Criado o repositório privado `Player07x/RunasVTT`. |
| 2026-09-18 | Revisão do plano pelo usuário (M1–M13): navegador integrado, ponte com os sites, Vista dos Jogadores e remoção das fases 7, 9 e 11 originais e do vídeo. |
| 2026-09-18 | Runas Suite `e226df6`: DM sem senha; Campanhas e Wiki abertas; token só para backup (M14). Publicado. |
| 2026-09-18 | Runas Suite `9e52973`: Book só com token (M15). Publicado. |
| 2026-09-18 | Início da Fase 0: base Electron + React, formato do mundo v1 com SQLite, testes. |
| 2026-09-18 | Criado este documento. |
| 2026-09-18 | Fase 1 concluída: navegador integrado com cópia local na mesma origem, sessões suíte/web separadas, atualização automática, modo offline forçado, cópia inicial (`seed:sites`) e teste contra os sites reais (`smoke:browser`). Correções encontradas nos testes: redirecionamento (troca de `session.fetch` por `net.request`), HEAD offline, assets referenciados por CSS, manifesto e service worker, e área da página com altura zero. |
| 2026-09-18 | Fase 0 concluída: ADRs 0001–0007, AGENTS.md, README, CI, smoke test no Electron e verificação visual (corrigido botão "Mundos" esticado na barra da mesa). |
