# ADR 0005 — Vista dos Jogadores em janela separada, sem HUD

- **Status:** revisada pelo ADR 0009 (2026-09-18): a vista passa a ser uma página web transmitida pelo VTT; a janela local abre essa mesma página. As ferramentas externas abaixo continuam possíveis, mas não são mais o caminho principal.

## Decisão
Uma segunda `BrowserWindow` renderiza a cena ativa do ponto de vista dos jogadores: névoa aplicada, tokens e objetos ocultos escondidos, sem menus, painéis nem fichas. O mestre escolhe o monitor ou a tela cheia. O estado vem do processo principal por IPC. A janela não tem controles de edição.

## Como os jogadores assistem
O VTT só produz a janela limpa; a transmissão fica com ferramentas externas, sem dependência de nenhuma delas:
- **Presencial:** a janela em tela cheia numa TV ou num segundo monitor (HDMI ou Chromecast).
- **Online:** qualquer ferramenta que compartilhe uma janela específica, como Google Meet, Microsoft Teams, Zoom ou Jitsi Meet (gratuito, no navegador, sem conta).
- **Transmissão:** OBS capturando a janela e enviando para YouTube ou Twitch com um link não listado.

A transmissão de vídeo do Discord está bloqueada no Brasil (2026), por isso ele não é citado como caminho. Para a captura funcionar bem em todas essas ferramentas, a janela precisa:
- ter título fixo e reconhecível ("RunasVTT — Vista dos Jogadores"), para ser achada na lista de janelas;
- continuar renderizando quando estiver atrás de outras janelas ou minimizada, sem pausar a animação (`backgroundThrottling: false`);
- permitir tela cheia e escolha do monitor.

Uma alternativa sem ferramenta externa (servir a vista como página web pela rede local ou por túnel) fica fora do escopo atual e exigiria um novo ADR.

## Consequências
- O renderizador do canvas precisa separar a camada de dados da camada de HUD desde a Fase 2.
- A câmera dos jogadores pode seguir a do mestre, ser fixada ou seguir um token.
