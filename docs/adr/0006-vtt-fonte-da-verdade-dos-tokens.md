# ADR 0006 — O VTT é a fonte da verdade do estado dos tokens

- **Status:** aceita (2026-09-18) · implementação na Fase 3

## Contexto
A Mesa do Runas DM mantém cópias independentes das fichas para o combate. Dentro do VTT, os tokens também são cópias. Duas mesas gerariam PVs divergentes para a mesma criatura.

## Decisão
Dentro do VTT, a Mesa do Runas DM opera sobre os tokens da cena, lidos e gravados pela ponte (ADR 0003). O token continua sendo uma cópia independente da ficha de origem: dano no token não altera o Bestiário. Isso mantém a regra atual da Mesa.

## Consequências
- O Runas DM precisa de um modo "Mesa no VTT", com atores vindos da ponte.
- Fora do VTT, a Mesa do DM funciona exatamente como hoje.
