import { assetUrl, type BrowserState, type DocumentChange, type PlayerDisplay, type PlayerState, type VttApi } from "../../shared/ipc"
import { normalizeDocumentData, type AssetPath } from "../../shared/scene"
import { defaultSettings, normalizeSettings, type AppSettings } from "../../shared/settings"
import { SUITE_SITES } from "../../shared/sites"
import { createWorldManifest, type WorldDocument, type WorldSummary } from "../../shared/world"

/** Na visualização em navegador comum, imagens importadas viram URLs `blob:`. */
const previewAssets = new Map<AssetPath, string>()
let playerAssetEndpoint: { base: string; key: string } | null = null

/** Configura o resolvedor para a página pública, que não tem `window.vtt`. */
export function configurePlayerAssets(base: string, key: string): void {
  playerAssetEndpoint = { base: base.endsWith("/") ? base : `${base}/`, key }
}

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
  const playerListeners = new Set<(value: PlayerState) => void>()
  const player: PlayerState = { enabled: false, port: 30000, key: null, localUrl: null, publicUrl: null, sceneId: null, audio: true, moves: true, bars: "friendly", spectators: 0 }
  let settings = defaultSettings()
  const settingsListeners = new Set<(value: AppSettings) => void>()
  const emitPlayer = () => playerListeners.forEach((listener) => listener({ ...player }))
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
    backup: {
      exportWorld: async () => null,
      importWorld: async () => null,
      snapshots: async () => [],
      createSnapshot: async () => null,
      restoreSnapshot: async () => undefined,
      deleteSnapshot: async () => undefined,
    },
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
    player: {
      state: async () => ({ ...player }),
      onState: (listener) => { playerListeners.add(listener); return () => { playerListeners.delete(listener) } },
      displays: async (): Promise<PlayerDisplay[]> => [{ id: "preview", label: "Esta tela", bounds: { x: 0, y: 0, width: 1280, height: 720 }, workArea: { x: 0, y: 0, width: 1280, height: 720 } }],
      start: async (port) => { player.enabled = true; player.port = port ?? 30000; player.key = "preview"; player.localUrl = `http://localhost:${player.port}/?k=preview`; emitPlayer(); return { ...player } },
      stop: async () => { player.enabled = false; player.key = null; player.localUrl = null; player.publicUrl = null; emitPlayer() },
      openWindow: async () => undefined,
      setScene: async (sceneId) => { player.sceneId = sceneId; emitPlayer() },
      ruler: async () => undefined,
      pullCamera: async () => undefined,
      setBars: async (bars) => { player.bars = bars; emitPlayer() },
      setAudio: async (enabled) => { player.audio = enabled; emitPlayer() },
      setMoves: async (enabled) => { player.moves = enabled; emitPlayer() },
      publicLink: async () => { if (!player.enabled) throw new Error("Ligue a Vista dos Jogadores primeiro."); return player.localUrl ?? "" },
      downloadCloudflared: async () => undefined,
    },
    audio: {
      state: async () => ({ now: Date.now(), sounds: [] }),
      onState: () => () => undefined,
      playPlaylist: async () => undefined,
      stopPlaylist: async () => undefined,
      playTrack: async () => undefined,
      stopTrack: async () => undefined,
      stopAll: async () => undefined,
      ended: async () => undefined,
    },
    vision: { resetExploration: async () => undefined },
    settings: {
      get: async () => structuredClone(settings),
      set: async (value) => { settings = normalizeSettings(value); settingsListeners.forEach((listener) => listener(structuredClone(settings))); return structuredClone(settings) },
      onChange: (listener) => { settingsListeners.add(listener); return () => { settingsListeners.delete(listener) } },
    },
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
  if (playerAssetEndpoint) return `${playerAssetEndpoint.base}${path}?k=${encodeURIComponent(playerAssetEndpoint.key)}`
  return previewAssets.get(path) ?? assetUrl(path)
}
