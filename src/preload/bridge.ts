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
}
