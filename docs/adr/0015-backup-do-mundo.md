# ADR 0015: Backup do mundo em .zip e snapshots por sessão

- **Status:** aceita (2026-09-18) · implementação da Fase 9

## Contexto
A Fase 9 pede exportar o mundo em `.zip` e um snapshot antes de cada sessão. O mundo já é uma pasta autocontida (ADR 0004), mas copiar a pasta com o mundo aberto pode pegar um `world.db` inconsistente (modo WAL). Além disso, desfazer uma sessão inteira exigia uma cópia manual feita antes.

## Decisão
- **Cópia consistente do banco:** `VACUUM INTO`, que funciona com o mundo aberto e em uso e inclui o que ainda está no WAL.
- **Exportar `.zip`:** leva `world.json`, a cópia do `world.db` e todos os assets. Mídia já comprimida vai armazenada; JSON e banco vão com deflate. O ZIP é escrito e lido por um módulo próprio (`src/main/zip.ts`), sem dependência nova, usando `zlib` e `crc32` do Node. Não há ZIP64: o limite é 4 GB por mundo.
- **Importar `.zip`:**
  - só aceita `world.json`, `world.db` e `assets/<tipo>/<sha256>.<ext>`; qualquer outro nome, inclusive com `..`, é recusado;
  - o hash de cada asset precisa conferir com o nome, e o banco precisa ser SQLite;
  - o manifesto e o esquema passam pelas mesmas recusas de versão futura da abertura normal;
  - se o id já existe, o mundo entra como "(cópia)" com id novo;
  - numa falha, só a pasta criada pela própria importação é apagada. Um bug achado no teste chegava a apagar uma pasta existente de mesmo nome.
- **Snapshots:**
  - ficam fora da pasta do mundo, em `%APPDATA%\runas-vtt\snapshots\<id do mundo>`, para que apagar o mundo não os leve junto;
  - guardam só o banco, porque os assets são nomeados pelo hash e nunca são apagados;
  - são criados ao abrir o mundo (início de sessão), manualmente e antes de restaurar;
  - um snapshot igual ao anterior (mesmo SHA-256) é descartado, e são mantidos os 15 mais recentes;
  - restaurar exige o mundo fechado, guarda antes o estado atual (dá para desfazer) e apaga o WAL antigo.

## Consequências
- Um snapshot não protege contra a perda de assets: se alguém apagar arquivos da pasta `assets`, o backup deles é o `.zip`.
- Mundos acima de 4 GB não exportam em `.zip` até existir ZIP64. A mensagem de erro diz isso.
