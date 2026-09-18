import { assetUrl, type BrowserState, type DocumentChange, type VttApi } from "../../shared/ipc"
import { normalizeDocumentData, type AssetPath } from "../../shared/scene"
import { SUITE_SITES } from "../../shared/sites"
import { createWorldManifest, type WorldDocument, type WorldSummary } from "../../shared/world"

/** Na visualização em navegador comum, imagens importadas viram URLs `blob:`. */
const previewAssets = new Map<AssetPath, string>()

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
  const documents = new Map<string, WorldDocument>()
  const documentListeners = new Set<(change: DocumentChange) => void>()
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
    documents: {
      list: async (type, parentId) => [...documents.values()].filter((document) => document.type === type && (parentId === undefined || document.parentId === parentId)),
      put: async (input) => {
        const now = Date.now()
        const existing = documents.get(input.id)
        const document: WorldDocument = { id: input.id, type: input.type, parentId: input.parentId, sort: input.sort ?? existing?.sort ?? now, data: normalizeDocumentData(input.type, input.data), createdAt: existing?.createdAt ?? now, updatedAt: now }
        documents.set(document.id, document)
        documentListeners.forEach((listener) => listener({ kind: "put", document }))
        return document
      },
      remove: async (id) => {
        const ids = [id, ...[...documents.values()].filter((document) => document.parentId === id).map((document) => document.id)]
        ids.forEach((candidate) => documents.delete(candidate))
        documentListeners.forEach((listener) => listener({ kind: "delete", ids }))
      },
      onChange: (listener) => { documentListeners.add(listener); return () => { documentListeners.delete(listener) } },
    },
    table: { report: async () => undefined },
    assets: {
      import: async (kind, fileName, bytes) => {
        const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource))].map((byte) => byte.toString(16).padStart(2, "0")).join("")
        const extension = fileName.split(".").pop()?.toLowerCase() ?? "png"
        const path = `${kind}/${hash}.${extension}`
        previewAssets.set(path, URL.createObjectURL(new Blob([bytes as BlobPart])))
        return path
      },
    },
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

/** URL de um asset do mundo para `<img>` e texturas. */
export function resolveAssetUrl(path: AssetPath): string {
  return previewAssets.get(path) ?? assetUrl(path)
}
