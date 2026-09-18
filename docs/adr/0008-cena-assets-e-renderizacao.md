# ADR 0008 — Cena, assets e renderização

- **Status:** aceita (2026-09-18) · implementada na Fase 2

## Decisões
- **Documentos da cena.** `scene`, `token`, `tile`, `drawing` e `note` usam a tabela genérica de documentos (ADR 0004). Objetos da cena têm `parentId` = cena, e excluir a cena exclui tudo o que ela contém. Os formatos ficam em `src/shared/scene.ts`, e o processo principal **normaliza todo `data` antes de gravar** (`putDocument`): valores fora de faixa são limitados, cores e enumerações inválidas voltam ao padrão, e um caminho de imagem que não seja um asset do mundo vira `null`.
- **Coordenadas em pixels da cena.** Tokens e notas são posicionados pelo centro, o que funciona igual para grade quadrada, hexagonal e sem grade. Tiles e desenhos são posicionados pelo canto superior esquerdo.
- **Grade.** Os tipos são `square`, `hex-rows`, `hex-cols` e `none`, e a matemática fica em `src/shared/grid.ts`, com testes. Na grade quadrada, token de tamanho ímpar encaixa no centro da célula e de tamanho par no vértice. As diagonais podem valer 1, alternar 1 e 2, ou seguir a distância real.
- **Assets.**
  - O arquivo é importado pela interface como bytes (via IPC) e gravado como `assets/<tipo>/<sha256>.<ext>`: importar o mesmo arquivo duas vezes não duplica.
  - O protocolo privilegiado `vtt-asset://world/<tipo>/<arquivo>` lê do disco e responde com `cache-control: immutable` e `access-control-allow-origin: *`. O WebGL exige CORS, porque a interface é `file://` e o asset é outra origem, e a imagem é carregada com `crossOrigin = "anonymous"`.
  - `net.fetch(file://…)` dentro do handler falhou com `ERR_FILE_NOT_FOUND` no Electron 44, então a leitura é direta com `readFile`. Áudio grande (Fase 7) precisará de respostas parciais (`Range`).
- **Renderização.**
  - PixiJS 8 com `pixi.js/unsafe-eval`, o módulo oficial para CSP estrita; a interface continua sem `unsafe-eval`.
  - `SceneView` é imperativo e não depende de React nem do processo principal: recebe documentos e devolve intenções (`onPut`, `onRemove`). O modo `editable: false` já omite objetos ocultos e toda interação, e será o renderizador da Vista dos Jogadores (ADR 0005).
- **Fluxo de escrita.** Interface → `documents.put` → processo principal (valida, normaliza, grava) → transmissão `documents:changed` para todas as janelas. A interface aplica a resposta imediatamente e ignora a transmissão repetida.

## Consequências
- Uma segunda janela (Vista dos Jogadores) recebe as mesmas mudanças sem código novo de sincronização.
- Ainda não há desfazer/refazer, redimensionamento com alças nem rotação pelo mouse (a rotação é pelo painel).
