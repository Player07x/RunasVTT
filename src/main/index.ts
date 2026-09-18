import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { app, BrowserWindow, ipcMain, protocol, shell } from "electron"
import { ASSET_SCHEME, IPC, type AppInfo, type BrowserCommand, type BrowserState, type DocumentChange, type DocumentInput, type Rect } from "../shared/ipc"
import { ASSET_KINDS, type AssetKind, type DocumentType, type NewWorldInput, type WorldSummary } from "../shared/world"
import { BridgeHub } from "./bridge-ipc"
import { BrowserManager, openSiteMirror } from "./browser"
import { runBrowserSmokeTest, runSeedSites } from "./browser-tasks"
import { assetResponse, importAsset } from "./world-assets"
import { deleteDocument, listDocuments, putDocument } from "./world-documents"
import { WorldStore } from "./world-store"

// Precisa acontecer antes de "ready": o esquema dos assets se comporta como
// https (origem própria, fetch e CORS), o que o PixiJS exige para texturas.
protocol.registerSchemesAsPrivileged([{ scheme: ASSET_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }])

const isSmokeTest = process.argv.includes("--smoke")
const isBrowserSmokeTest = process.argv.includes("--smoke-browser")
const isSeed = process.argv.includes("--seed-sites")

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: "#0d0b0c",
    title: "RunasVTT",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })

  window.once("ready-to-show", () => window.show())

  // A interface do VTT nunca navega para fora de si mesma: links abrem no
  // navegador integrado, que tem sessão e regras próprias.
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault()
  })

  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(__dirname, "../renderer/index.html"))
  return window
}

function registerWorldIpc(store: WorldStore): void {
  const summary = (world: { summary: WorldSummary }) => world.summary
  ipcMain.handle(IPC.appInfo, (): AppInfo => ({ version: app.getVersion(), electron: process.versions.electron, worldsRoot: store.root }))
  ipcMain.handle(IPC.listWorlds, () => store.list())
  ipcMain.handle(IPC.createWorld, (_event, input: NewWorldInput) => store.create(input))
  ipcMain.handle(IPC.openWorld, async (_event, id: string) => summary(await store.open(id)))
  ipcMain.handle(IPC.closeWorld, () => store.close())
  ipcMain.handle(IPC.revealWorld, async (_event, id: string) => {
    const world = (await store.list()).find((candidate) => candidate.id === id)
    if (world) await shell.openPath(world.path)
  })
}

/** Ouvintes extras de mudanças (a ponte avisa os sites quando tokens mudam). */
const changeListeners: ((change: DocumentChange) => void)[] = []

function broadcast(change: DocumentChange): void {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(IPC.documentsChanged, change)
  for (const listener of changeListeners) listener(change)
}

function requireOpenWorld(store: WorldStore) {
  const world = store.openWorld
  if (!world) throw new Error("Nenhum mundo aberto.")
  return world
}

function registerDocumentIpc(store: WorldStore): void {
  ipcMain.handle(IPC.documentsList, (_event, type: DocumentType, parentId?: string | null) => listDocuments(requireOpenWorld(store).database, type, parentId))
  ipcMain.handle(IPC.documentsPut, (_event, input: DocumentInput) => {
    const { document, change } = putDocument(requireOpenWorld(store).database, input)
    broadcast(change)
    return document
  })
  ipcMain.handle(IPC.documentsDelete, (_event, id: string) => {
    const change = deleteDocument(requireOpenWorld(store).database, id)
    if (change) broadcast(change)
  })
  ipcMain.handle(IPC.assetsImport, (_event, kind: AssetKind, fileName: string, bytes: Uint8Array) => {
    if (!(ASSET_KINDS as readonly string[]).includes(kind)) throw new Error("Tipo de asset inválido.")
    return importAsset(requireOpenWorld(store).summary.path, kind, String(fileName), bytes)
  })
}

/** Serve `vtt-asset://world/<tipo>/<arquivo>` a partir do mundo aberto; nada fora de `assets/` é acessível. */
function registerAssetProtocol(store: WorldStore): void {
  protocol.handle(ASSET_SCHEME, (request) => {
    const url = new URL(request.url)
    const world = store.openWorld
    if (!world || url.hostname !== "world") return new Response(null, { status: 404 })
    return assetResponse(world.summary.path, decodeURIComponent(url.pathname.slice(1)))
  })
}

function registerBrowserIpc(browser: BrowserManager): void {
  ipcMain.handle(IPC.browserState, () => browser.state())
  ipcMain.handle(IPC.browserOpen, (_event, url: string) => browser.open(url))
  ipcMain.handle(IPC.browserActivate, (_event, id: number) => browser.activate(id))
  ipcMain.handle(IPC.browserClose, (_event, id: number) => browser.close(id))
  ipcMain.handle(IPC.browserNavigate, (_event, id: number, url: string) => browser.navigate(id, url))
  ipcMain.handle(IPC.browserCommand, (_event, id: number, command: BrowserCommand) => browser.command(id, command))
  ipcMain.handle(IPC.browserSetBounds, (_event, bounds: Rect | null) => browser.setBounds(bounds))
  ipcMain.handle(IPC.browserSetForcedOffline, (_event, offline: boolean) => browser.setForcedOffline(offline))
  ipcMain.handle(IPC.browserPrepareOffline, () => browser.prepareOffline())
}

/** `electron . --smoke`: exercita o armazenamento dentro do runtime real do Electron e encerra. */
async function runSmokeTest(): Promise<void> {
  const root = await mkdtemp(join(app.getPath("temp"), "runas-vtt-smoke-"))
  const store = new WorldStore(root)
  try {
    const created = await store.create({ title: "Mundo de Teste" })
    const { database } = await store.open(created.id)
    const now = Date.now()
    database.put({ id: "scene-1", type: "scene", parentId: null, sort: 0, data: { name: "Taverna" }, createdAt: now, updatedAt: now })
    database.put({ id: "token-1", type: "token", parentId: "scene-1", sort: 0, data: { name: "Goblin" }, createdAt: now, updatedAt: now })
    const tokens = database.list("token", "scene-1").length
    database.delete("scene-1")
    const tokensAfterSceneDeleted = database.list("token").length
    const result = { ok: tokens === 1 && tokensAfterSceneDeleted === 0, electron: process.versions.electron, node: process.versions.node, schemaVersion: database.schemaVersion, worlds: (await store.list()).length, tokens, tokensAfterSceneDeleted }
    console.log(`SMOKE ${JSON.stringify(result)}`)
    process.exitCode = result.ok ? 0 : 1
  } catch (error) {
    console.error("SMOKE FAILED", error)
    process.exitCode = 1
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
    app.quit()
  }
}

void app.whenReady().then(() => {
  if (isSmokeTest) { void runSmokeTest(); return }
  if (isBrowserSmokeTest) { void runBrowserSmokeTest().finally(() => app.quit()); return }
  if (isSeed) { void runSeedSites().finally(() => app.quit()); return }

  const store = new WorldStore(join(app.getPath("userData"), "worlds"))
  const mirror = openSiteMirror()
  registerWorldIpc(store)
  registerDocumentIpc(store)
  registerAssetProtocol(store)
  const window = createMainWindow()
  const browser = new BrowserManager(window, mirror, (state: BrowserState) => window.webContents.send(IPC.browserStateChanged, state))
  registerBrowserIpc(browser)
  const bridge = new BridgeHub(store, browser)
  bridge.register()
  changeListeners.push((change) => bridge.onDocumentChange(change))
  app.on("before-quit", () => {
    browser.destroy()
    mirror.close()
    store.close()
  })
})

app.on("window-all-closed", () => app.quit())
