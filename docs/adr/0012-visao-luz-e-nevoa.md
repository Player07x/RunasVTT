# ADR 0012: Visão, luz e névoa calculadas no processo principal

- **Status:** aceita (2026-09-18) · implementação da Fase 6

## Contexto
A Fase 6 traz paredes, portas, visão dos tokens, luzes e névoa de guerra. A Vista dos Jogadores é uma página na rede (ADR 0009). Se a página recebesse a cena inteira e só escondesse o que está fora da visão, bastaria abrir as ferramentas do navegador para ver tokens e salas escondidos.

## Decisão
- **Geometria compartilhada e pura:** `src/shared/vision.ts` calcula o polígono de visibilidade por raycasting contra as paredes (portas abertas deixam passar), as áreas de luz, o teste de ponto e a rasterização das áreas exploradas. A mesa usa as mesmas funções para a prévia do mestre.
- **A projeção é a fronteira:** com a névoa ligada, o processo principal só envia:
  - tokens cujo centro, ou um ponto perto da borda, esteja visível;
  - as linhas de visão já calculadas, as luzes que tocam alguma delas e a memória do explorado.

  Paredes, portas, visão e luz dos tokens nunca saem do VTT.
- **Quem revela o mapa:** tokens **aliados**, visíveis e com visão. Área visível = alcance no escuro (a partir da borda do token) ∪ (linha de visão ∩ área iluminada). A área iluminada é a cena inteira com "Luz do dia" ligada; sem ela, são as luzes do mapa e as dos tokens.
- **Memória do explorado:** fica numa grade de meia célula, em bits, no documento `fog-<cena>` (tipo `fog`, filho da cena, apagado junto com ela). É acumulada pelo `VisionService` a cada mudança de token, parede, luz ou cena, com ou sem transmissão. Só o processo principal grava esse documento, e a mesa não o carrega.
- **Desenho:** escuridão e névoa são texturas (`RenderTexture`) refeitas só quando a visão muda, com as áreas iluminadas apagadas por blend `erase`. O mestre vê a escuridão a 60% e tem o botão "Ver como os jogadores".
- **Leitura normalizada:** o `WorldDatabase` normaliza o `data` também na leitura. Documentos de versões anteriores ganham os campos novos (visão e luz do token, visão da cena) sem migração.

## Consequências
- O custo do raycasting cresce com o número de paredes vezes o número de observadores e luzes. Ele é aceitável para mapas de mesa (centenas de paredes). Se ficar lento, o próximo passo é filtrar as paredes pela caixa envolvente, o que já é feito para raios limitados, ou usar um Web Worker.
- Paredes não bloqueiam o movimento: só o mestre move tokens (ADR 0001).
- As portas não têm "trancada", porque os jogadores não interagem com elas.
