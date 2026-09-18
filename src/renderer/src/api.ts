import type { VttApi } from "../../shared/ipc"
import { createWorldManifest, type WorldSummary } from "../../shared/world"

/**
 * Fora do Electron (ex.: `vite` aberto num navegador comum) não existe
 * `window.vtt`. Esta implementação em memória deixa a interface utilizável
 * para desenvolvimento visual; nada é gravado em disco.
 */
function createBrowserPreviewApi(): VttApi {
  const worlds: WorldSummary[] = []
  return {
    appInfo: async () => ({ version: "dev", electron: "—", worldsRoot: "(memória do navegador)" }),
    listWorlds: async () => [...worlds].sort((a, b) => b.updatedAt - a.updatedAt),
    createWorld: async (input) => {
      const manifest = createWorldManifest(input, crypto.randomUUID(), Date.now())
      const world = { ...manifest, path: `memória/${manifest.id}` }
      worlds.push(world)
      return world
    },
    openWorld: async (id) => {
      const world = worlds.find((candidate) => candidate.id === id)
      if (!world) throw new Error("Mundo não encontrado.")
      world.updatedAt = Date.now()
      return world
    },
    closeWorld: async () => undefined,
    revealWorld: async () => undefined,
  }
}

export const vtt: VttApi = window.vtt ?? createBrowserPreviewApi()
export const isBrowserPreview = !window.vtt
