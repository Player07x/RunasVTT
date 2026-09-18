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

const pageOrigin = (globalThis as { location?: { origin: string } }).location?.origin ?? ""

if (BRIDGE_ORIGINS.includes(pageOrigin)) {
  contextBridge.exposeInMainWorld("runasVTT", {
    protocol: PROTOCOL,
    importCharacters: (items: unknown) => ipcRenderer.invoke(BRIDGE_CHANNELS.importCharacters, items),
    getTokens: () => ipcRenderer.invoke(BRIDGE_CHANNELS.getTokens),
    updateTokenCharacter: (tokenId: unknown, envelope: unknown, summary: unknown) => ipcRenderer.invoke(BRIDGE_CHANNELS.updateTokenCharacter, tokenId, envelope, summary),
    postLog: (entry: unknown) => ipcRenderer.invoke(BRIDGE_CHANNELS.postLog, entry),
    onTokensChanged: (listener: () => void) => {
      const handler = () => listener()
      ipcRenderer.on(BRIDGE_CHANNELS.tokensChanged, handler)
      return () => { ipcRenderer.removeListener(BRIDGE_CHANNELS.tokensChanged, handler) }
    },
  })
}
