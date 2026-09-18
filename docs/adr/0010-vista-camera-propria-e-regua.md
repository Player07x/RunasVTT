# ADR 0010: Vista dos Jogadores com câmera própria, régua e textos de dano

- **Status:** aceita (2026-09-18)
- **Revisa:** ADR 0009, no item "Câmera" (a opção "Seguir o mestre", ligada por padrão, deixa de existir)

## Contexto
Ao usar a Fase 5, o usuário pediu que a câmera dos jogadores **não** acompanhe a do mestre: o mestre precisa olhar outras partes do mapa (preparar um encontro, conferir um token oculto) sem arrastar a tela de todo mundo. Também pediu que:
- a régua do mestre apareça para os espectadores;
- os espectadores possam medir com a própria régua, sem que ela apareça para o mestre;
- os textos flutuantes de dano apareçam também para os espectadores.

## Decisão
- **Câmera:** cada espectador controla a própria câmera: arrasta o mapa com o botão esquerdo, usa a roda do mouse e as teclas WASD ou as setas. O servidor não repassa mais a câmera do mestre. A única forma de mover a câmera dos jogadores é o botão **Puxar a câmera**, que envia uma mensagem `camera` explícita.
- **Régua do mestre:** a régua da **ferramenta Régua** é repassada como `ruler` (cena, início e fim), com no máximo cerca de 20 atualizações por segundo, e só quando é medida na cena transmitida. A régua automática que aparece ao arrastar um token **não** é repassada, porque revelaria o movimento de um token oculto.
- **Régua do espectador:** é local e fica só na página dele. Nenhuma mensagem sai do espectador, e o servidor continua somente leitura (ignora tudo além de `ping`).
- **Textos de dano:** uma entrada nova do Registro com `tokenId` e `floatingText` vira a mensagem `float`, **somente** se o token estiver na projeção atual. Token oculto não gera texto.
- **Quem conecta** recebe sempre um `snapshot` completo (projeção + régua atual), nunca a última mensagem enviada. Antes, um espectador que entrava depois de um movimento de câmera recebia só a câmera, sem a cena.

## Consequências
- A mensagem `snapshot` deixou de carregar câmera e `followMaster`. O tipo `PlayerWireMessage` passou para `src/shared/player.ts` e é compartilhado entre o servidor e a página.
- A validação da régua (`normalizeRuler`) e a regra de visibilidade do texto de dano ficam no processo principal e têm testes, pois fazem parte da fronteira de segurança da projeção.
