# ADR 0013: Áudio local decidido no processo principal e tocado em cada tela

- **Status:** aceita (2026-09-18) · implementação da Fase 7
- **Revisa:** M5 do plano ("só áudio local"). Com a Vista dos Jogadores como página na rede (ADR 0009), os jogadores remotos também precisam ouvir.

## Contexto
A Fase 7 foi planejada quando todos estariam na mesma sala ou numa chamada com a tela compartilhada. Desde o ADR 0009, os jogadores assistem de casa pela página transmitida: se o áudio tocasse só no computador do mestre, eles não ouviriam nada.

## Decisão
- **Dados no mundo:**
  - `playlist` (sem pai): canal Música, Ambiente ou Efeitos; modo sequencial, aleatório ou mesa de sons; volume, fade e repetição.
  - `track` (filho da playlist): arquivo, volume e loop.
  - `sound` (filho da cena): ponto, alcance, volume, se paredes abafam e se está desligado.

  Os arquivos são importados para `assets/audio` pelo hash, como os mapas.
- **Quem decide o que toca:** o `AudioService`, no processo principal. A reprodução não é gravada: ao reabrir o mundo, nada toca.
  - Cada som em execução tem uma chave de instância e o horário de início.
  - Os sons do mapa tocam enquanto algum aliado com visão estiver no alcance, sem parede no caminho quando "paredes abafam" estiver ligado. O volume cai linearmente com a distância do aliado mais próximo.
- **Quem toca:** o `AudioEngine`, igual na mesa e na página dos jogadores.
  - Cria um `<audio>` por som, com fade por rampa de volume.
  - Posiciona a faixa pelo relógio do processo principal, compensando a diferença de relógio de cada tela. Assim, quem entra depois ouve do mesmo ponto.
  - Só a mesa avisa quando uma faixa termina, e é isso que avança a playlist.
- **Range nos assets:** `vtt-asset://` e o servidor dos jogadores respondem 206 a pedidos por faixa de bytes. Sem isso, o navegador não consegue pular para o meio da música.
- **Jogadores:**
  - o áudio vai na transmissão por padrão (opção "Tocar o áudio também para os jogadores");
  - o servidor só serve os arquivos que estão tocando;
  - a página pede um clique em "Ativar som" (política de autoplay dos navegadores) e tem um volume próprio.
- **Volumes do mestre:** geral e por canal, ficam nas configurações do aplicativo, e não no mundo.

## Consequências
- Sons do mapa só "ouvem" pelos aliados. Sem aliado com visão na cena, eles ficam em silêncio, mesmo para o mestre.
- A sincronia é boa para música e ambiente (erro de menos de 1,5 s, com reposicionamento), mas não é feita para ritmo exato entre telas.
- Se a mesa estiver fechada, ninguém avisa o fim das faixas e a playlist não avança. Isso é coerente com "só o mestre opera o VTT" (ADR 0001).
