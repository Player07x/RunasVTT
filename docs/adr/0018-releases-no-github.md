# ADR 0018: Instalador publicado em Releases do GitHub

- **Status:** aceita (2026-09-19)
- **Complementa:** ADR 0016 (instalador Windows)

## Contexto
O instalador só existia na máquina de quem rodava `npm run dist`, e a cópia inicial dos sites (`resources/site-seed.db`) dependia de alguém lembrar de rodar `npm run seed:sites` antes. O usuário pediu que os executáveis ficassem disponíveis em "Releases" no GitHub.

## Decisão
- **Workflow `.github/workflows/release.yml`, disparado por tag `v*`:** roda num runner `windows-latest` e executa `npm ci`, typecheck, testes, `npm run seed:sites` (cópia dos sites sempre atual, feita no próprio CI), `electron . --smoke` e `electron-builder --win nsis --publish never`. Depois cria a Release com `gh release create`, com o `RunasVTT-Setup-<versão>.exe`, um `SHA256SUMS.txt` e notas geradas a partir dos commits.
- **A tag precisa bater com o `package.json`:** o workflow falha se `v<versão>` não for a versão do pacote. A versão é criada por `npm version patch|minor|major`, que altera o `package.json`, faz o commit (`chore: versão X`, definido no `.npmrc`) e cria a tag.
- **Tags com hífen (`v0.2.0-beta.1`) viram pré-release.**
- **Execução manual (`workflow_dispatch`)** gera o instalador só como artefato do workflow, guardado por 14 dias, sem criar Release. Serve para testar um build antes de versionar.
- **O electron-builder não publica sozinho** (`--publish never`): a Release é criada pelo `gh`, e o electron-builder não precisa de token.
- **Sem atualização automática nem assinatura de código,** como no ADR 0016.

## Consequências
- Para publicar uma versão: `npm version patch` e `git push --follow-tags` na `main`.
- O repositório passou a ser público (2026-09-19), então qualquer pessoa pode baixar os instaladores. Nada que seja segredo pode entrar no código, nos testes ou nos documentos.
- A cópia inicial reflete os sites publicados no momento do build da Release.
- Se um site da suíte estiver fora do ar durante o build, `seed:sites` falha e a Release não é criada. Nesse caso, rode o workflow de novo com "Re-run jobs".
