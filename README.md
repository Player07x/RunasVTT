# RunasVTT

Mesa virtual desktop e offline integrada à Runas Suite (Runas Tools, Runas DM e Runas Book). O mestre conduz cenas, tokens, visão, luz e áudio no VTT, e os sites da suíte rodam em um navegador integrado para fichas, testes e dano.

A documentação completa (proposta, plano, estado atual e histórico) fica em [`docs/projeto.md`](docs/projeto.md), e as decisões de arquitetura em [`docs/adr/`](docs/adr/).

## Instalar (Windows)

Baixe o instalador `RunasVTT-Setup-<versão>.exe` da página [Releases](https://github.com/Player07x/RunasVTT/releases) (ou gere-o localmente) e execute. Ele instala só para o seu usuário (não pede administrador), deixa escolher a pasta e cria atalhos na Área de Trabalho e no menu Iniciar. Como o instalador ainda não é assinado, o Windows SmartScreen pode avisar na primeira vez: clique em **Mais informações** → **Executar assim mesmo**.

Para gerar o instalador:

```bash
npm install
npm run seed:sites   # atualiza a cópia inicial dos sites que vai no instalador (precisa de internet)
npm run dist         # build + instalador em dist/RunasVTT-Setup-<versão>.exe
```

### Publicar uma versão

Na `main`, com a árvore limpa:

```bash
npm version patch          # ou minor / major; altera o package.json, faz o commit e cria a tag v<versão>
git push --follow-tags     # a tag dispara o workflow Release, que gera o .exe e publica a Release
```

O workflow roda typecheck, testes, `seed:sites` e smoke antes de empacotar, e anexa o instalador e o `SHA256SUMS.txt`. Tags com hífen (ex.: `v0.2.0-beta.1`) viram pré-release. Para só testar o build, rode o workflow **Release** manualmente na aba Actions: o `.exe` fica como artefato, sem Release. Detalhes no [ADR 0018](docs/adr/0018-releases-no-github.md).

Os mundos, as configurações e os snapshots ficam em `%APPDATA%\runas-vtt`, tanto na versão instalada quanto em desenvolvimento, e desinstalar não os apaga. Não abra as duas versões ao mesmo tempo.

## Desenvolvimento

Requer Node 24+.

```bash
npm install
npm run dev        # abre o app com recarregamento automático
npm test           # testes (Vitest)
npm run typecheck  # TypeScript do processo principal e da interface
npm run smoke      # build + teste do armazenamento e do backup dentro do Electron real
npm run build      # só o build (pasta out/)
npm start          # abre o build da pasta out/
```

Os mundos ficam em `%APPDATA%\runas-vtt\worlds` (Windows).
