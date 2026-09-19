# ADR 0017: Espectadores movem tokens "Jogador"

- **Status:** aceita (2026-09-18)
- **Revisa:** ADR 0001 e ADR 0009. A Vista dos Jogadores deixa de ser estritamente somente leitura e passa a aceitar um único pedido: mover um token "Jogador".

## Contexto
O usuário pediu que os espectadores possam mover tokens, mas **somente** os marcados como "Jogador", uma categoria nova. Até aqui o servidor de transmissão ignorava tudo o que os clientes mandavam, exceto `ping`. Não há contas: qualquer pessoa com o link pode enviar mensagens.

## Decisão
- **Categoria "Jogador"** (`disposition: "player"`):
  - conta como aliada (`isAlly`) para revelar o mapa, ouvir sons do mapa, disparar regiões "só Jogador e Aliado" e mostrar barras;
  - fichas vindas do Runas Tools passam a entrar como Jogador, e as do DM continuam como Hostil;
  - tem cor verde na borda.
- **Protocolo:**
  - o cliente envia `{ type: "move", tokenId, x, y }`;
  - o servidor responde só a ele com `move-result`;
  - a cena atualizada chega a todos pelo `snapshot` de sempre;
  - `moves` informa se o mestre permite o movimento (opção no painel Jogadores, ligada por padrão).
- **O VTT confere tudo, porque o cliente não é confiável** (`validatePlayerMove`):
  - o token está na cena transmitida, é Jogador e não está oculto nem travado;
  - o destino fica dentro do mapa e é encaixado na grade pelo próprio VTT;
  - nenhuma parede ou porta fechada toca o caminho, inclusive as juntas entre paredes e o ponto de chegada. Assim ninguém atravessa paredes para explorar a névoa.
- **Contra abuso:**
  - quadros do cliente acima de 16 KB derrubam a conexão;
  - no máximo 8 pedidos por segundo por espectador.
- **Mesmo caminho da mesa:** o movimento aceito é gravado por `putDocument` e transmitido por `broadcast`, então a visão, a névoa explorada, as regiões (teleporte e texto), os sons do mapa e a ponte com os sites reagem como a um movimento do mestre.

## Consequências
- **Sem identidade de jogador:** quem tem o link move qualquer token Jogador. Donos por token exigiriam contas, que continuam fora de escopo (ADR 0001).
- **Recusa:** a página devolve o token à posição gravada e mostra o motivo.
- **Bug achado nos testes e corrigido:** `lineBlocked` usava desigualdades estritas e deixava passar pela junta de duas paredes. Tokens e paredes encaixam na mesma grade, então isso aconteceria com frequência. A correção também vale para os sons do mapa.
