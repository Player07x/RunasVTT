# ADR 0020 — O VTT serve o Runas Tools aos jogadores

- **Status:** aceita (2026-09-20) · implementação na Fase 10
- **Revisa:** ADR 0002 (o espelho local dos sites deixa de existir só para o navegador integrado do mestre) e ADR 0009 (o servidor de transmissão passa a servir também o Runas Tools).
- **Serve a:** ADR 0019.

## Contexto
Para o jogador editar a própria ficha, ele precisa do Runas Tools no navegador dele. O caminho evidente seria mandá-lo ao site publicado, `https://runas-tools.pages.dev`, com um token de acesso no fragmento da URL.

Isso não funciona na rede local: o link da Vista dos Jogadores é `http://IP:porta/?k=…` (`player-transmission.ts`), e uma página HTTPS não pode abrir `ws://IP:porta` nem `http://IP:porta` — o navegador bloqueia conteúdo misto. Sobraria o Quick Tunnel (`wss://*.trycloudflare.com`), ou seja: o recurso dependeria de internet e de um túnel efêmero de terceiros até numa mesa presencial, contra o princípio offline-first do projeto.

O VTT já mantém uma cópia local dos três sites (`site-mirror.db`, servida ao navegador integrado por `site-responder.ts`), e o Runas Tools é um site estático (`output: "export"`).

## Decisão
O `PlayerServer` passa a servir o Runas Tools ao jogador, **na mesma origem da Vista dos Jogadores**, a partir do espelho local:

- `GET /tools/*` responde com os arquivos do espelho, exigindo a chave da transmissão, com fallback de rota do export estático.
- No HTML servido, o VTT injeta `<script src="/tools/runas-vtt-seat.js">`, um **shim de `window.runasVTT`** que implementa o mesmo contrato de `RunasVttBridge` (`src/shared/bridge.ts`), com escopo de um assento:

  | Método | No assento |
  |---|---|
  | `importCharacters` | um item; lote é recusado |
  | `getTokens` | só a ficha do próprio assento |
  | `onTokensChanged` | assina `character-changed` do WebSocket |
  | `updateTokenCharacter` | `PUT /seat/character` com `baseRevision` |
  | `postLog` | descartado |

- O transporte do shim é o descrito no ADR 0019: HTTP para ficha, WebSocket para avisos.

O Runas Tools continua detectando a ponte como sempre, por `getRunasVtt(window)`, que já valida o protocolo e o formato. No `runas-suite`, sobram ajustes de interface: "Enviar ao VTT" como ação individual, envio em lote escondido no modo assento e o `galleryEntryId` vinculado ao assento. Exportar, importar JSON e ZIP e criar fichas continuam idênticos.

## Consequências
- **O Tools abre dentro da Vista dos Jogadores**, num painel sobre o mapa, e não numa aba separada. Ele está na mesma origem, então basta um `iframe`; abrir fora tirava o jogador da mesa e, no celular, obrigava a alternar de janela a cada consulta à ficha. O painel continua montado ao ser fechado, para não recarregar a ficha nem perder o que foi digitado. Um link "abrir em outra aba" continua disponível no cabeçalho do painel.
- **Funciona na LAN, sem internet.** O Quick Tunnel volta a ser o que era: opcional, para quem joga à distância.
- **Some o acoplamento de versões.** O jogador usa o Tools que o VTT tem; o app não precisa esperar uma publicação do Cloudflare Pages para mudar o protocolo, nem conviver com um site publicado mais novo que o app instalado.
- **A origem do jogador muda a cada sessão** (`http://IP:porta` ou o endereço do túnel). Consequências aceitas:
  - a galeria local do jogador nasce vazia nessa origem — por isso a ficha vive no assento (ADR 0019) e é recuperada pelo código;
  - o Runas Tools não é instalável como PWA nessa origem (contexto não seguro na LAN), o que não afeta nenhum fluxo da sessão;
  - quem quiser manter a própria galeria continua usando o site publicado fora da sessão e levando a ficha por JSON, como hoje.
- **O espelho vira dependência da sessão:** se ele estiver vazio, o jogador não abre o Tools. A cópia inicial já vai no instalador e é atualizada pelo CI a cada versão (ADR 0018), mas o painel precisa avisar quando o espelho não tiver o Tools.
  - Uma cópia **incompleta** é tão grave quanto uma vazia, e mais difícil de notar: o Tools abre e só quebra na parte que falta. Bloqueado o service worker, o espelho é a única fonte dos pedaços de `next/dynamic`, cujos nomes só aparecem na lista de pré-cache do próprio service worker (`v0.3.3`). Quem mexer em `extractAssetUrls` mantém essa lista descoberta; `site-mirror.test.ts` guarda o formato.
- A superfície servida pela rede cresce: além da página dos jogadores e dos assets da projeção, agora saem os arquivos estáticos do Tools. Continuam protegidos pela chave da transmissão e pelo mesmo `isSafeStaticPath`.
