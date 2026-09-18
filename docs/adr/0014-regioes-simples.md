# ADR 0014: Regiões simples com gatilhos no processo principal

- **Status:** aceita (2026-09-18) · implementação da Fase 8

## Contexto
A Fase 8 pede uma versão simples das regiões do FoundryVTT: teleporte, texto e terreno difícil. Só o mestre move tokens (ADR 0001), mas as consequências também chegam aos jogadores: o token some de um lugar e aparece em outro, e o texto aparece na tela deles.

## Decisão
- **Documento `region`** (filho da cena): retângulo ou elipse, nome, cor, "visível aos jogadores", ativa e quem dispara (só aliados ou qualquer token). Os comportamentos são:
  - **Teleporte:** leva ao centro de outra região, na mesma cena ou em outra, com o token encaixado na grade.
  - **Texto:** grava no Registro e sobe sobre o token, reaproveitando `postLog`. Assim, aparece na mesa e, para tokens visíveis, na Vista dos Jogadores. A opção "Só uma vez" desliga o texto depois de mostrar.
  - **Terreno difícil:** multiplicador que a régua aplica ao trecho dentro da região.
- **Gatilhos no processo principal (`RegionService`):**
  - guarda em que regiões o centro de cada token está e dispara ao **entrar**, qualquer que seja a origem do movimento (arrastar na mesa, teclado ou a ponte com os sites);
  - token recém-criado e região desenhada por cima de um token não disparam;
  - a chegada de um teleporte não dispara a região de destino, o que evita ricochete entre portais.
- **Jogadores:** recebem só as regiões visíveis, com forma, cor e multiplicador de terreno. Destinos, mensagens e regiões ocultas nunca saem do VTT. A régua do mestre conta todo terreno difícil; a dos jogadores conta só o das regiões visíveis.

## Consequências
- O terreno é aproximado por 64 amostras ao longo da linha da régua, com precisão de centésimos de célula. O VTT não impede movimentos: só o mestre move, e a régua informa o custo.
- Os gatilhos não têm "ao sair" nem "a cada turno", que dependeriam de combate no VTT (o combate é delegado à Mesa do DM, ADR 0006).
