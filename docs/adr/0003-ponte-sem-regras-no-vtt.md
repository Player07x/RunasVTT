# ADR 0003 — Ponte `runasVTT`; o VTT não interpreta regras

- **Status:** aceita (2026-09-18) · implementação na Fase 3

## Contexto
A Runas Suite proíbe copiar regras fora do `@runas/core`. O usuário quer que os sites façam fichas, testes e dano, e que o VTT apenas receba os resultados.

## Decisão
- O VTT **não depende do `@runas/core`** e não lê o formato `Character`.
- Uma ficha importada é guardada no token como **envelope opaco** (`{ version, character }`, exatamente como o site exporta), junto com um **resumo** calculado pelo site: nome, barras de recurso (PV, PA, PE, com atual e máximo) e imagem do token.
- A ponte `window.runasVTT` é exposta por um preload **somente** nas origens da Runas Suite. Operações previstas:
  - `importCharacter(envelope, summary, tokenImage)`;
  - `getSelectedTokens()` e `onSelectionChange()`;
  - `getTokenCharacter(tokenId)` e `updateTokenCharacter(tokenId, envelope, summary)`;
  - `postLog(entry)`, para testes e danos no Registro.
- O contrato é versionado em um pacote de tipos, sugerido `runas-suite/packages/vtt-bridge`, e cada chamada informa a versão.

## Consequências
- Mudanças de regra nunca exigem atualizar o VTT.
- O VTT depende do site para recalcular o resumo, e um token só muda por ação do site.
