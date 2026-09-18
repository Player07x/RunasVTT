# ADR 0007 — Electron em vez de Tauri

- **Status:** aceita (2026-09-18)

## Decisão
Usar Electron (Chromium e Node embutidos).

## Motivos
- O navegador integrado precisa de um motor fixo e conhecido. O Tauri usa o WebView do sistema, diferente em cada plataforma e sem a mesma API de interceptação e de sessões.
- Interceptação de requisições (`protocol.handle`, `session`), `WebContentsView` e preloads por origem são recursos maduros no Electron.
- Todo o ecossistema da Runas Suite é TypeScript e Node.

## Consequências
- O instalador fica maior (cerca de 100 MB). É aceitável para um app desktop de uso pessoal.
