# RunasVTT

Mesa virtual desktop e offline integrada à Runas Suite (Runas Tools, Runas DM e Runas Book). O mestre conduz cenas, tokens, visão, luz e áudio no VTT, e os sites da suíte rodam em um navegador integrado para fichas, testes e dano.

A documentação completa (proposta, plano, estado atual e histórico) fica em [`docs/projeto.md`](docs/projeto.md), e as decisões de arquitetura em [`docs/adr/`](docs/adr/).

## Instalar (Windows)

Baixe ou gere o instalador `RunasVTT-Setup-<versão>.exe` e execute. Ele instala só para o seu usuário (não pede administrador), deixa escolher a pasta e cria atalhos na Área de Trabalho e no menu Iniciar. Como o instalador ainda não é assinado, o Windows SmartScreen pode avisar na primeira vez: clique em **Mais informações** → **Executar assim mesmo**.

Para gerar o instalador:

```bash
npm install
npm run seed:sites   # atualiza a cópia inicial dos sites que vai no instalador (precisa de internet)
npm run dist         # build + instalador em dist/RunasVTT-Setup-<versão>.exe
```

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
