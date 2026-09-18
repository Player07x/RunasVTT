# Regras obrigatórias do RunasVTT

Antes de alterar qualquer parte deste projeto, leia integralmente:

1. `docs/projeto.md`: proposta, plano vigente, estado atual e histórico
2. `docs/adr/`: decisões de arquitetura

## Restrições que não podem ser quebradas

- O RunasVTT **não copia regras da Runas Suite** e não depende do `@runas/core`. Fichas são envelopes opacos com o resumo enviado pelo site (ADR 0003).
- Somente o mestre usa o VTT. Não crie servidor para jogadores, contas nem permissões sem um novo ADR (ADR 0001).
- Todo fluxo de mesa funciona **sem internet**.
- A interface do VTT roda com `contextIsolation`, `sandbox` e sem `nodeIntegration`. Acesso a disco e banco só pelo processo principal, via IPC tipado em `src/shared/ipc.ts`.
- A ponte `window.runasVTT` só pode ser exposta às origens da Runas Suite. Sites externos nunca a recebem.
- O espelho local nunca armazena `/api/backup`, `/api/campaign-data`, `/api/book-auth`, `/cdn-cgi/`, autenticação nem payloads RSC (ADR 0002).
- Migrações de `world.db` publicadas nunca são editadas: acrescente a próxima. Mudou o formato do manifesto? Aumente `WORLD_FORMAT_VERSION` e trate a leitura das versões anteriores.
- Mudanças que exijam alterar a Runas Suite seguem o `AGENTS.md` dela (testes no core e typecheck e build de todos os consumidores).

## Ao concluir qualquer trabalho

1. Rode `npm run typecheck`, `npm test` e `npm run smoke`.
2. Atualize `docs/projeto.md`: estado atual, plano e uma linha no Histórico de mudanças.
3. Toda decisão nova ou revertida vira um ADR em `docs/adr/`.
