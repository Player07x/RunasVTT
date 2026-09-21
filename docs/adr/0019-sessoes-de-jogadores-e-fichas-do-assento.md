# ADR 0019 — Sessões de jogadores, assentos e fichas sincronizadas

- **Status:** aceita (2026-09-20) · implementação na Fase 10
- **Revisa:** ADR 0001 (passa a existir identidade de jogador, efêmera, e escrita de ficha pela rede), ADR 0009 (a Vista dos Jogadores ganha um lobby e um canal por assento) e ADR 0017 (o movimento deixa de valer para qualquer token "Jogador" e passa a valer para o token do próprio assento).
- **Depende de:** ADR 0020 (o Runas Tools do jogador é servido pelo próprio VTT).
- **Não reabre:** ADR 0003. Nenhuma regra de ficha entra no VTT.

## Contexto
O usuário pediu que o mestre defina quantos jogadores terá a sessão, que o VTT gere um código por jogador, que o código dê acesso ao Runas Tools no navegador do jogador e que a ficha enviada apareça na Mesa do Runas DM, com alterações visíveis nos dois sentidos em tempo real.

Hoje existe a transmissão (ADR 0009) com uma chave única por sessão, projeção sem `actor` e um único pedido aceito do cliente: mover um token "Jogador" (ADR 0017). Não existe identidade, canal privado nem escrita de ficha pela rede. O `PlayerServer` implementa WebSocket à mão: quadros do cliente limitados a 16 KB, quadros do servidor limitados a 1 MB (`frame()` lança acima disso), sem remontagem de quadros de continuação e sem backpressure. O contrato da ponte já admite envelope de 3 MB e imagem de token de 5 MB.

## Decisão

### Assento, não conta
A identidade é um **assento efêmero** da sessão de transmissão:

```ts
interface PlayerSeat {
  slotId: string            // "player-1"… estável por mundo
  label: string
  codeHash: string
  sessionCookieHash: string | null
  tokenId: string | null
  status: "available" | "connected" | "attached"
  revision: number
  lastSeenAt: number | null
}
```

- O código é mostrado uma vez ao mestre e guardado só como hash, em memória. Nada de código ou cookie vai para o `world.db`.
- Códigos têm no mínimo 40 bits de entropia e são comparados em tempo constante.
- Desligar a transmissão, trocar o código ou fechar o mundo revoga tudo e derruba as conexões.
- O `slotId` persiste no token (`actor.playerSlotId`), então uma sessão nova reaproveita o token do assento anterior.

### A ficha do assento é um documento do mundo
Novo tipo `seat-character` (`parentId: null`) com `{ slotId, envelope, summary, tokenImage, revision, updatedAt }`. É ele que permite ao jogador recuperar a própria ficha com o código, sem depender do IndexedDB do navegador — necessário porque a origem servida pelo VTT muda a cada sessão (ADR 0020).

### Ficha por HTTP; WebSocket só para avisos
O envelope **não** trafega pelo WebSocket. O `PlayerServer` ganha rotas autenticadas por cookie de assento:

| Rota | Autorização | Limites |
|---|---|---|
| `POST /seat/join` `{ code }` | chave da transmissão | 5 tentativas por minuto e por conexão; resposta genérica |
| `GET /seat` | cookie | — |
| `GET /seat/character` | cookie | — |
| `PUT /seat/character` | cookie + `Origin` | 3 MB de envelope, 5 MB de imagem, 1 escrita a cada 2 s, 30 por minuto |
| `DELETE /seat/character` | cookie | — |

`PUT` leva `baseRevision` e `mutationId` e responde `200 { revision }` ou `409 { revision, envelope }`. As rotas `/seat/*` respondem `no-store` e **não** levam `Access-Control-Allow-Origin: *`.

No WebSocket entram apenas duas mensagens curtas, enviadas só ao assento correspondente: `seat-status` e `character-changed { revision }`. O cliente busca a ficha por HTTP ao receber o aviso. Assim o limite de 16 KB por quadro do cliente e o parser atual continuam como estão.

### Anexação e sincronização
- **Jogador → VTT:** o `PUT` valida o cookie, normaliza (`normalizeBridgeCharacter`), **sanitiza os campos de texto rico**, importa a imagem por hash com deduplicação, grava o `seat-character`, cria ou atualiza o token na **cena da Mesa** (`table.sceneId`) com `disposition: "player"` e `playerSlotId`, incrementa a revisão e publica `bridgeTokensChanged`.
- Sem cena aberta na Mesa, a ficha fica guardada no assento e o painel mostra "aguardando cena". Não se cria token numa cena que o Runas DM não lê.
- **Mestre → jogador:** `updateTokenCharacter` passa a incrementar a revisão, espelhar no `seat-character` e avisar o assento.
- **Jogador → mestre:** o Tools grava no IndexedDB como sempre e envia o `PUT` depois de 400 ms de pausa, do blur ou do salvar. Nunca a cada tecla.

### Conflito
Como o envelope é opaco, não há merge possível sem duplicar o domínio. Vale a revisão monotônica: o VTT aceita apenas a revisão corrente, devolve `409` com a versão da mesa e a interface oferece "Usar versão da mesa" ou "Enviar a minha de novo". Ao reconectar, o cliente lê `GET /seat` e `GET /seat/character`, compara e só reenvia o que ainda for compatível.

### Limites e abuso
- `Origin` validado em `/seat/*` e no upgrade do WebSocket.
- Teto de conexões por sessão e quota de escrita e de assets por assento.
- Limite de tentativas **global e por assento**: atrás do Quick Tunnel toda conexão chega como `127.0.0.1`, então limitar por endereço não protege (`CF-Connecting-IP` serve só como reforço).
- Envelopes nunca aparecem em log.
- `validatePlayerMove` passa a exigir que o token movido seja o do assento; espectador sem código não move nada.

## Alternativas consideradas e descartadas
- **Ficha pelo WebSocket, com limite maior:** exigiria remontar quadros de continuação (o Chromium fragmenta mensagens grandes), tratar backpressure e negociar compressão — reescrita do parser para ganhar nada que o HTTP não dê.
- **Jogador no `runas-tools.pages.dev` com o token num fragmento de URL:** uma página HTTPS não abre `ws://IP:porta`, e o link da rede local é HTTP. O recurso passaria a exigir internet e Quick Tunnel até para jogo presencial. Ver ADR 0020.
- **Token criado na cena transmitida:** a Mesa do Runas DM lê `table.sceneId`; com a transmissão fixada em outra cena, a ficha não apareceria na Mesa — justamente o resultado pedido.
- **Contas e servidor multiusuário** (plano original, §6 do `projeto.md`): 4 a 6 semanas só de fundação, credenciais persistentes e regras duplicadas no VTT, contra o ADR 0003.
- **Relay na nuvem ou D1 como fonte da verdade:** quebra o offline-first e transforma o backup privado do Runas DM em requisito.

## Consequências
- O ADR 0001 deixa de valer na letra: o VTT passa a aceitar escrita de ficha pela rede, de clientes autenticados por código. A mitigação é o conjunto acima, mais o fato de a transmissão continuar desligada por padrão.
- A ficha de um jogador é renderizada pela Mesa do Runas DM **dentro do navegador integrado, que expõe `window.runasVTT`**. Conteúdo de terceiro em contexto privilegiado: a sanitização no ingresso é obrigatória e soma-se à do Runas DM, não a substitui.
- O mundo passa a guardar fichas de jogadores (`seat-character`), que entram no backup `.zip` e nos snapshots.
- O painel do mestre ganha a tabela de assentos, com código copiável, estado, ficha e token.
