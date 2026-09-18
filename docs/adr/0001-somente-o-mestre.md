# ADR 0001 — Somente o mestre usa o RunasVTT

- **Status:** aceita (2026-09-18) · revisada pelo ADR 0009: existe um servidor de transmissão **somente leitura** para a Vista dos Jogadores; os jogadores continuam sem operar a mesa

## Contexto
O FoundryVTT é um servidor multiusuário: cada jogador entra pelo navegador, com papéis e permissões por documento. O usuário definiu que os jogadores acompanham a sessão pela tela compartilhada.

## Decisão
O RunasVTT é um aplicativo de um único operador, o mestre, em uma única máquina. Não existe servidor HTTP/WebSocket para jogadores, contas, papéis nem propriedade por documento. Os jogadores veem a Vista dos Jogadores (ADR 0005).

## Consequências
- A persistência e a lógica ficam no processo principal do Electron e são acessadas por IPC.
- Não há sincronização entre clientes nem resolução de conflitos.
- Suportar jogadores remotos no futuro exigirá um novo ADR (servidor, permissões e o que cada jogador pode ver).
