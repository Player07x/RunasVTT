import type { BrowserState, VttApi } from "../../shared/ipc"
import { SUITE_SITES } from "../../shared/sites"
import { createWorldManifest, type WorldSummary } from "../../shared/world"

/**
 * Fora do Electron (ex.: `vite` aberto num navegador comum) não existe
 * `window.vtt`. Esta implementação em memória deixa a interface utilizável
 * para desenvolvimento visual; nada é gravado em disco e o navegador
 * integrado só simula abas.
 */
function createBrowserPreviewApi(): VttApi {
  const worlds: WorldSummary[] = []
  const listeners = new Set<(state: BrowserState) => void>()
  let nextTab = 1
  const state: BrowserState = {
    tabs: [],
    activeTabId: null,
    forcedOffline: false,
    sites: SUITE_SITES.map((site) => ({ siteId: site.id, label: site.label, origin: site.origin, entries: 0, bytes: 0, lastStoredAt: null, lastSource: null })),
    preparation: { running: false, siteId: null, done: 0, total: 0, failed: 0, finishedAt: null },
  }
  const emit = () => listeners.forEach((listener) => listener(structuredClone(state)))
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
    browser: {
      state: async () => structuredClone(state),
      onState: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      open: async (url) => {
        const id = nextTab++
        const site = SUITE_SITES.find((candidate) => url.startsWith(candidate.origin))
        state.tabs.push({ id, title: site?.label ?? url, url, loading: false, canGoBack: false, canGoForward: false, siteId: site?.id ?? null })
        state.activeTabId = id
        emit()
      },
      activate: async (tabId) => { state.activeTabId = tabId; emit() },
      close: async (tabId) => {
        state.tabs = state.tabs.filter((tab) => tab.id !== tabId)
        if (state.activeTabId === tabId) state.activeTabId = state.tabs.at(-1)?.id ?? null
        emit()
      },
      navigate: async () => undefined,
      command: async () => undefined,
      setBounds: async () => undefined,
      setForcedOffline: async (offline) => { state.forcedOffline = offline; emit() },
      prepareOffline: async () => undefined,
    },
  }
}

export const vtt: VttApi = window.vtt ?? createBrowserPreviewApi()
export const isBrowserPreview = !window.vtt
