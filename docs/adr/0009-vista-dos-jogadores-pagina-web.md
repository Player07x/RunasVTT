# ADR 0009 — Vista dos Jogadores como página web

- **Status:** aceita (2026-09-18) · implementação na Fase 5
- **Revisa:** ADR 0001 (passa a existir um servidor, só de leitura) e ADR 0005 (a vista deixa de ser só uma janela local)
- **Revisada por:** ADR 0010 (a câmera dos jogadores não segue mais a do mestre; a régua e os textos de dano passam a ser transmitidos) e ADR 0017 (espectadores podem mover tokens "Jogador").

## Contexto
A transmissão de vídeo do Discord está bloqueada no Brasil, e o usuário prefere que os jogadores assistam por uma **página web**, sem instalar nada e sem depender de um serviço de vídeo. Os jogadores continuam sem interagir com a mesa: só o mestre opera o VTT (ADR 0001).

## Decisão
O RunasVTT inclui um **servidor de transmissão somente leitura**, desligado por padrão, que o mestre liga pelo botão "Vista dos Jogadores".

- **Página:** uma segunda entrada do Vite (ex.: `src/renderer/player.html`) que usa o `SceneView` com `{ editable: false }`. Os dados chegam por WebSocket, em vez de `window.vtt`. A janela local para TV ou monitor abre **essa mesma página**, sem uma segunda implementação.
- **Servidor:** HTTP e WebSocket no processo principal, na porta configurável (padrão 30000). Ele serve apenas o bundle da página, os dados da cena transmitida e os assets que ela usa.
- **Projeção segura:** o servidor **nunca** envia o documento como está. Ele monta uma projeção para jogadores:
  - só a cena transmitida;
  - sem objetos com `hidden: true`;
  - tokens sem `actor` (a ficha nunca sai do VTT);
  - notas sem `url`;
  - nada do Registro.
  - As barras de recurso aparecem conforme a opção "Mostrar barras aos jogadores" (padrão: só nos aliados).
  - Na Fase 6, a névoa também é aplicada na projeção.
- **Assets:** `GET /assets/<tipo>/<arquivo>` só responde a arquivos referenciados pela projeção atual.
- **Acesso:** o link leva uma chave aleatória de 128 bits (`/?k=…`), gerada a cada vez que a transmissão é ligada. Sem a chave, a resposta é 404. Desligar a transmissão ou fechar o mundo derruba todas as conexões.
- **Rede:**
  - **Rede local:** o servidor escuta em `0.0.0.0`, e o painel mostra o link com o IP da máquina e um QR code.
  - **Internet (opcional):** botão "Gerar link público", via *Cloudflare Quick Tunnel* (`cloudflared tunnel --url`), que é gratuito, sem conta e gera um endereço `https://*.trycloudflare.com` novo por sessão. O `cloudflared` é baixado do repositório oficial da Cloudflare só quando o mestre pedir, com confirmação, e verificado antes de executar. Sem ele, a transmissão pela rede local continua funcionando.
- **Câmera:** a opção "Seguir o mestre" (padrão ligada) acompanha a vista do mestre; desligada, cada jogador move e aproxima o mapa à vontade. O mestre também pode "Puxar a câmera" para um ponto.
- **Painel do mestre:** liga e desliga, mostra link, QR code e número de espectadores conectados, e permite escolher a cena transmitida (por padrão, a cena aberta).

## Consequências
- A superfície de ataque cresce, porque o VTT passa a aceitar conexões de rede. Mitigações: desligado por padrão, somente leitura (o servidor ignora qualquer mensagem dos clientes além de ping), chave de acesso, projeção filtrada, assets limitados à projeção, CSP estrita na página e nenhuma ponte `runasVTT`.
- A projeção fica num módulo puro e testado, porque vazamento de informação oculta é o principal risco.
- O Windows pode pedir permissão de firewall ao ligar a transmissão pela primeira vez; o painel deve explicar isso.
- O link público depende de um binário de terceiros (`cloudflared`), baixado sob demanda e opcional.
- Jogadores interagindo (mover o próprio token, rolar dados) continuam fora de escopo e exigiriam outro ADR.
