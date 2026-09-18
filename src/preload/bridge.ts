import { contextBridge, ipcRenderer } from "electron"

/**
 * Ponte `window.runasVTT` para os sites da Runas Suite (ADR 0003).
 *
 * Este preload roda no sandbox e não pode importar outros módulos do app:
 * canais e origens são repetidos aqui e conferidos contra `src/shared` por
 * `tests/bridge-preload.test.ts`. O processo principal confere a origem de
 * novo a cada chamada; esta checagem só evita expor a ponte à toa.
 */
export const BRIDGE_ORIGINS = ["https://runas-tools.pages.dev", "https://runas-dm.pages.dev", "https://runas-book.pages.dev"]
export const BRIDGE_CHANNELS = {
  importCharacters: "bridge:import-characters",
  getTokens: "bridge:get-tokens",
  updateTokenCharacter: "bridge:update-token-character",
  postLog: "bridge:post-log",
  tokensChanged: "bridge:tokens-changed",
  accessToken: "bridge:access-token",
} as const
const PROTOCOL = 1

/**
 * O Electron embrulha erros do processo principal como
 * "Error invoking remote method 'canal': Error: motivo". O site recebe só o motivo.
 */
export function cleanRemoteError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  return new Error(message.replace(/^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/, ""))
}

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  return ipcRenderer.invoke(channel, ...args).catch((error: unknown) => { throw cleanRemoteError(error) })
}

const pageOrigin = (globalThis as { location?: { origin: string } }).location?.origin ?? ""

/**
 * Preenche a "Chave de acesso" dos sites (backup do DM, área DM do Book) com o
 * Token de Acesso das configurações do VTT. Nos sites da suíte, campos de
 * senha só existem para essa chave. O token nunca é exposto ao JavaScript da
 * página: só o valor do campo muda, como faria um gerenciador de senhas.
 */
function autofillAccessKeys(): void {
  // O projeto do preload não carrega os tipos do DOM; este recorte basta.
  interface PasswordInput { value: string; isConnected: boolean; dispatchEvent(event: object): boolean }
  const dom = globalThis as unknown as {
    document: { readyState: string; documentElement: object; querySelectorAll(selector: string): ArrayLike<PasswordInput>; addEventListener(type: string, listener: () => void, options?: object): void }
    HTMLInputElement: { prototype: object }
    MutationObserver: new (callback: () => void) => { observe(target: object, options: object): void }
    Event: new (type: string, init?: object) => object
  }
  const handled = new WeakSet<PasswordInput>()
  const fill = async (input: PasswordInput) => {
    if (handled.has(input)) return
    handled.add(input)
    if (input.value) return
    let token: unknown
    try { token = await ipcRenderer.invoke(BRIDGE_CHANNELS.accessToken) } catch { return }
    if (typeof token !== "string" || !token || input.value || !input.isConnected) return
    // O setter nativo, seguido do evento `input`, é o que o React observa
    // para campos controlados (o do Book) e não controlados (o do DM).
    Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")?.set?.call(input, token)
    input.dispatchEvent(new dom.Event("input", { bubbles: true }))
    input.dispatchEvent(new dom.Event("change", { bubbles: true }))
  }
  const scan = () => { for (const input of Array.from(dom.document.querySelectorAll('input[type="password"]'))) void fill(input) }
  const start = () => {
    scan()
    new dom.MutationObserver(scan).observe(dom.document.documentElement, { childList: true, subtree: true })
  }
  if (dom.document.readyState === "loading") dom.document.addEventListener("DOMContentLoaded", start, { once: true })
  else start()
}

if (BRIDGE_ORIGINS.includes(pageOrigin)) {
  contextBridge.exposeInMainWorld("runasVTT", {
    protocol: PROTOCOL,
    importCharacters: (items: unknown) => invoke(BRIDGE_CHANNELS.importCharacters, items),
    getTokens: () => invoke(BRIDGE_CHANNELS.getTokens),
    updateTokenCharacter: (tokenId: unknown, envelope: unknown, summary: unknown) => invoke(BRIDGE_CHANNELS.updateTokenCharacter, tokenId, envelope, summary),
    postLog: (entry: unknown) => invoke(BRIDGE_CHANNELS.postLog, entry),
    onTokensChanged: (listener: () => void) => {
      const handler = () => listener()
      ipcRenderer.on(BRIDGE_CHANNELS.tokensChanged, handler)
      return () => { ipcRenderer.removeListener(BRIDGE_CHANNELS.tokensChanged, handler) }
    },
  })
  autofillAccessKeys()
}
