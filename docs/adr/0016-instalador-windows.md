# ADR 0016: Instalador para Windows (.exe) com electron-builder

- **Status:** aceita (2026-09-18)
- **Revisa:** M7 do plano ("distribuição não é necessária no momento"), por pedido do usuário

## Contexto
Com as Fases 0 a 9 concluídas, o usuário pediu um `.exe` para instalar e abrir o RunasVTT sem o terminal. Até aqui o app só rodava da pasta do projeto (`npm run dev` ou `npm start`).

## Decisão
- **electron-builder, alvo NSIS, x64:** o instalador é por usuário, sem pedir administrador. Deixa escolher a pasta e cria atalhos na Área de Trabalho e no menu Iniciar. O artefato é `dist/RunasVTT-Setup-<versão>.exe`, gerado por `npm run dist`.
- **O que vai no pacote:** só a pasta `out/` (o electron-vite já embute as dependências da interface) dentro do `app.asar`, mais `resources/site-seed.db` como recurso extra. Esse arquivo é a cópia inicial dos três sites, que o app lê em `process.resourcesPath` para funcionar offline desde a primeira abertura. Não há módulo nativo: o SQLite é o `node:sqlite` do próprio Electron.
- **Mesma pasta de dados no instalado e em desenvolvimento:** o processo principal fixa `userData` em `%APPDATA%\runas-vtt`. Sem isso, o nome do produto ("RunasVTT") mudaria a pasta, e os mundos, as configurações e a cópia dos sites "sumiriam" na versão instalada. `--user-data-dir` continua valendo para testes isolados.
- **Desinstalar não apaga os dados:** `deleteAppDataOnUninstall: false`, então mundos e snapshots ficam.
- **Ícone:** `build/icon.png`, a runa "R" da interface, gerada por `npm run icon`.
- **Sem assinatura de código por enquanto:** o Windows SmartScreen avisa na primeira execução ("Mais informações" → "Executar assim mesmo"). Assinar exige um certificado pago.

## Consequências
- Antes de gerar um instalador para distribuir, rode `npm run seed:sites` para a cópia inicial dos sites estar atual.
- Não há atualização automática: uma versão nova é um instalador novo, instalado por cima, com os dados preservados.
- A versão instalada e a de desenvolvimento não devem ficar abertas ao mesmo tempo: usam a mesma pasta de dados e a mesma porta da Vista dos Jogadores.
