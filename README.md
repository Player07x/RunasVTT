# RunasVTT

Mesa virtual desktop e offline integrada à Runas Suite (Runas Tools, Runas DM e Runas Book). O mestre conduz cenas, tokens, visão, luz e áudio no VTT, e os sites da suíte rodam em um navegador integrado para fichas, testes e dano.

A documentação completa (proposta, plano, estado atual e histórico) fica em [`docs/projeto.md`](docs/projeto.md), e as decisões de arquitetura em [`docs/adr/`](docs/adr/).

## Desenvolvimento

Requer Node 24+.

```bash
npm install
npm run dev        # abre o app com recarregamento automático
npm test           # testes (Vitest)
npm run typecheck  # TypeScript do processo principal e da interface
npm run smoke      # build + teste do armazenamento dentro do Electron real
```

Os mundos ficam em `%APPDATA%\RunasVTT\worlds` (Windows).
