# ADR 0004 — Mundo é uma pasta com SQLite nativo do Node

- **Status:** aceita (2026-09-18) · implementada na Fase 0

## Decisão
- Cada mundo é uma pasta com `world.json` (manifesto), `world.db` (SQLite) e `assets/{maps,tokens,tiles,audio}`.
- O banco usa `node:sqlite` (`DatabaseSync`), embutido no Node 24 do Electron 44. Não há módulo nativo para compilar.
- Uma tabela genérica `documents(id, type, parent_id, sort, data JSON, created_at, updated_at)`. A exclusão em cascata segue `parent_id`.
- As migrações ficam em `src/main/world-database.ts`, numeradas por `PRAGMA user_version`. Migrações publicadas nunca são editadas.
- `formatVersion` (manifesto) e `user_version` (banco) mais novos que os suportados são **recusados**.

## Consequências
- Copiar a pasta é um backup completo.
- Um novo tipo de documento não exige migração estrutural, só um tipo de `data`.
- O `node:sqlite` ainda é marcado como experimental no Node 24. Se a API mudar, o isolamento em `WorldDatabase` limita o impacto.
