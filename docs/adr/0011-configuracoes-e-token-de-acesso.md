# ADR 0011: Configurações do aplicativo e Token de Acesso nos sites

- **Status:** aceita (2026-09-18)

## Contexto
O usuário pediu atalhos de teclado configuráveis (incluindo mover a câmera com WASD e as setas) e um campo **Token de Acesso**. Esse token deve ser preenchido automaticamente quando o Runas DM, o Runas Tools ou o Runas Book pedirem a "Chave de acesso" dentro do navegador integrado.

Hoje essas telas são o diálogo de backup do DM (campo de senha não controlado) e o desbloqueio da área DM do Book (campo controlado pelo React). O Tools ainda não tem uma, mas a regra vale para ele assim que tiver.

## Decisão
- **Onde ficam:** as configurações são do **aplicativo**, e não do mundo. Ficam em `settings.json`, na pasta de dados do usuário, gravado de forma atômica. O token é cifrado com o `safeStorage` do Electron (DPAPI no Windows). Só na falta de cifra ele é gravado em texto.
- **Quem lê:** só a janela principal do VTT lê ou grava as configurações pelo IPC; o processo principal confere quem enviou.
- **Preenchimento:** o preload da ponte, que só roda nas origens da suíte, observa o DOM. Ao surgir um `input[type=password]` vazio, ele pede o token ao processo principal pelo canal `bridge:access-token`, que confere de novo a aba, o quadro principal e a origem. Em seguida grava o valor pelo setter nativo e dispara `input`/`change`, como faria um gerenciador de senhas. Nos sites da suíte, campos de senha só existem para essa chave.
- **O token não entra na ponte:** `window.runasVTT` não ganhou método para lê-lo. O JavaScript da página só vê o valor do campo, e o formulário **não** é enviado automaticamente.
- **Atalhos:** são gravados como `KeyboardEvent.code`, o que independe do layout (ABNT2 ou US). Cada ação aceita até 2 teclas, e uma tecla nunca fica em duas ações. Os padrões são: WASD e setas para a câmera, Shift + direção para mover a seleção uma célula, F para espelhar o token e P para Desenhar (antes era D, que agora move a câmera).

## Consequências
- Mudar o conjunto de ações exige atualizar `KEY_ACTIONS` em `src/shared/settings.ts`. A normalização dá o padrão às ações novas e descarta as removidas, sem migração.
- Um site da suíte que venha a ter um campo de senha para outra finalidade também seria preenchido. Se isso acontecer, o seletor precisa ficar mais restrito (por exemplo, `autocomplete="current-password"` dentro de um formulário marcado).
