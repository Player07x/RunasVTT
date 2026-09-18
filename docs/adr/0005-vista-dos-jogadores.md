# ADR 0005 — Vista dos Jogadores em janela separada, sem HUD

- **Status:** aceita (2026-09-18) · implementação na Fase 5

## Decisão
Uma segunda `BrowserWindow` renderiza a cena ativa do ponto de vista dos jogadores: névoa aplicada, tokens e objetos ocultos escondidos, sem menus, painéis nem fichas. O mestre escolhe o monitor ou a tela cheia, e a janela pode ser capturada pelo Discord ou pelo OBS. O estado vem do processo principal por IPC. A janela não tem controles de edição.

## Consequências
- O renderizador do canvas precisa separar a camada de dados da camada de HUD desde a Fase 2.
- A câmera dos jogadores pode seguir a do mestre, ser fixada ou seguir um token.
