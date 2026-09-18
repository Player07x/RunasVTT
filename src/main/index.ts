import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { app, BrowserWindow, ipcMain, protocol, screen, shell } from "electron"
import { ASSET_SCHEME, IPC, type AppInfo, type BrowserCommand, type BrowserState, type DocumentChange, type DocumentInput, type PlayerBarVisibility, type Rect } from "../shared/ipc"
import { ASSET_KINDS, type AssetKind, type DocumentType, type NewWorldInput, type WorldSummary } from "../shared/world"
import { BridgeHub } from "./bridge-ipc"
import { BrowserManager, openSiteMirror } from "./browser"
import { runBrowserSmokeTest, runSeedSites } from "./browser-tasks"
import { assetResponse, importAsset } from "./world-assets"
import { deleteDocument, listDocuments, putDocument } from "./world-documents"
import { WorldStore } from "./world-store"
import { PlayerTransmission } from "./player-transmission"
import { ensureCloudflared, startCloudflared } from "./cloudflared"

// Precisa acontecer antes de "ready": o esquema dos assets se comporta como
// https (origem própria, fetch e CORS), o que o PixiJS exige para texturas.
protocol.registerSchemesAsPrivileged([{ scheme: ASSET_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }])

const isSmokeTest = process.argv.includes("--smoke")
const isBrowserSmokeTest = process.argv.includes("--smoke-browser")
const isSeed = process.argv.includes("--seed-sites")
const isPlayerServerSmokeTest = process.argv.includes("--smoke-player-server")

let playerTransmission: PlayerTransmission | null = null
let playerWindow: BrowserWindow | null = null
let publicTunnel: ReturnType<typeof startCloudflared> | null = null

function stopPublicTunnel(): void {
  publicTunnel?.process.kill()
  publicTunnel = null
  playerTransmission?.setPublicUrl(null)
}

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

/** A tela local da Vista usa exatamente a página pública, sem preload. */
function openPlayerWindow(): void {
  if (!playerTransmission?.isEnabled) throw new Error("Ligue a Vista dos Jogadores primeiro.")
  const url = playerTransmission.localWindowUrl()
  if (!url) throw new Error("A Vista dos Jogadores ainda não está pronta.")
  if (playerWindow && !playerWindow.isDestroyed()) {
    playerWindow.show()
    playerWindow.focus()
    void playerWindow.loadURL(url)
    return
  }
  playerWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 640,
    minHeight: 360,
    title: "RunasVTT — Vista dos Jogadores",
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#080707",
    webPreferences: {
      // A página WebSocket é a mesma que os jogadores abrem. Ela não recebe
      // `window.vtt` nem a ponte `window.runasVTT`.
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  playerWindow.once("ready-to-show", () => playerWindow?.show())
  playerWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  playerWindow.webContents.on("will-navigate", (event, destination) => {
    if (!destination.startsWith("http://127.0.0.1:")) event.preventDefault()
  })
  playerWindow.on("closed", () => { playerWindow = null })
  void playerWindow.loadURL(url)
}

function registerWorldIpc(store: WorldStore): void {
  const summary = (world: { summary: WorldSummary }) => world.summary
  ipcMain.handle(IPC.appInfo, (): AppInfo => ({ version: app.getVersion(), electron: process.versions.electron, worldsRoot: store.root }))
  ipcMain.handle(IPC.listWorlds, () => store.list())
  ipcMain.handle(IPC.createWorld, (_event, input: NewWorldInput) => store.create(input))
  ipcMain.handle(IPC.openWorld, async (_event, id: string) => {
    stopPublicTunnel()
    await playerTransmission?.closeWorld()
    if (playerWindow && !playerWindow.isDestroyed()) { playerWindow.close(); playerWindow = null }
    return summary(await store.open(id))
  })
  ipcMain.handle(IPC.closeWorld, async () => {
    stopPublicTunnel()
    await playerTransmission?.closeWorld()
    if (playerWindow && !playerWindow.isDestroyed()) { playerWindow.close(); playerWindow = null }
    store.close()
  })
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

function registerPlayerIpc(transmission: PlayerTransmission, userData: string): void {
  ipcMain.handle(IPC.playerState, () => transmission.state())
  ipcMain.handle(IPC.playerDisplays, () => screen.getAllDisplays().map((display) => ({
    id: String(display.id),
    label: `Tela ${display.id}`,
    bounds: display.bounds,
    workArea: display.workArea,
  })))
  ipcMain.handle(IPC.playerStart, async (_event, port?: unknown) => transmission.start(port === undefined ? 30000 : Number(port)))
  ipcMain.handle(IPC.playerStop, async () => {
    stopPublicTunnel()
    await transmission.stop()
    if (playerWindow && !playerWindow.isDestroyed()) { playerWindow.close(); playerWindow = null }
  })
  ipcMain.handle(IPC.playerOpenWindow, () => openPlayerWindow())
  ipcMain.handle(IPC.playerSetScene, (_event, sceneId: unknown) => transmission.setScene(typeof sceneId === "string" ? sceneId : null))
  ipcMain.handle(IPC.playerSetFollowMaster, (_event, follow: unknown) => transmission.setFollowMaster(Boolean(follow)))
  ipcMain.handle(IPC.playerPullCamera, () => transmission.pullCamera())
  ipcMain.handle(IPC.playerSetBars, (_event, bars: unknown) => {
    if (bars !== "friendly" && bars !== "all" && bars !== "none") throw new Error("Opção de barras inválida.")
    transmission.setBars(bars as PlayerBarVisibility)
  })
  // A geração do túnel é adicionada ao módulo de distribuição opcional. Por
  // enquanto estes canais deixam a interface explicar que ele é opt-in.
  ipcMain.handle(IPC.playerPublicLink, async () => {
    if (!transmission.isEnabled) throw new Error("Ligue a Vista dos Jogadores primeiro.")
    stopPublicTunnel()
    const binary = await ensureCloudflared(userData)
    const tunnel = startCloudflared(binary, transmission.currentPort)
    publicTunnel = tunnel
    try {
      const url = await tunnel.url
      if (publicTunnel !== tunnel) throw new Error("O túnel público foi substituído.")
      transmission.setPublicUrl(url)
      return url
    } catch (error) {
      if (publicTunnel === tunnel) publicTunnel = null
      tunnel.process.kill()
      throw error
    }
  })
  ipcMain.handle(IPC.playerDownloadCloudflared, () => ensureCloudflared(userData))
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

/** Modo manual para abrir a página em outro navegador durante a validação. */
async function runPlayerServerSmokeTest(): Promise<void> {
  const root = await mkdtemp(join(app.getPath("temp"), "runas-vtt-player-smoke-"))
  const store = new WorldStore(root)
  const transmission = new PlayerTransmission(store, join(__dirname, "../renderer"), (state) => console.log(`PLAYER_STATE ${JSON.stringify(state)}`))
  try {
    const world = await store.create({ title: "Transmissão de teste" })
    const opened = await store.open(world.id)
    putDocument(opened.database, { id: "scene-smoke", type: "scene", parentId: null, sort: 0, data: { name: "Cena de teste", width: 1000, height: 700, backgroundColor: "#1a1516" } })
    putDocument(opened.database, { id: "token-smoke", type: "token", parentId: "scene-smoke", sort: 0, data: { name: "Visível", x: 500, y: 350, disposition: "friendly", bars: [{ label: "PV", value: 10, max: 10, color: "#c76561" }] } })
    transmission.setMasterView({ sceneId: "scene-smoke", selection: [], center: { x: 500, y: 350 }, zoom: 0.8 })
    const state = await transmission.start(30000)
    console.log(`PLAYER_SERVER ${JSON.stringify({ url: state.localUrl, key: state.key })}`)
    const cleanup = async () => { await transmission.stop(); store.close(); await rm(root, { recursive: true, force: true }); app.quit() }
    process.once("SIGINT", () => { void cleanup() })
    setTimeout(() => { void cleanup() }, 120_000)
  } catch (error) {
    console.error("PLAYER SERVER SMOKE FAILED", error)
    await transmission.stop()
    store.close()
    await rm(root, { recursive: true, force: true })
    app.exit(1)
  }
}

void app.whenReady().then(() => {
  if (isSmokeTest) { void runSmokeTest(); return }
  if (isBrowserSmokeTest) { void runBrowserSmokeTest().finally(() => app.quit()); return }
  if (isSeed) { void runSeedSites().finally(() => app.quit()); return }
  if (isPlayerServerSmokeTest) { void runPlayerServerSmokeTest(); return }

  const store = new WorldStore(join(app.getPath("userData"), "worlds"))
  const mirror = openSiteMirror()
  playerTransmission = new PlayerTransmission(store, join(__dirname, "../renderer"), (state) => {
    for (const current of BrowserWindow.getAllWindows()) current.webContents.send(IPC.playerStateChanged, state)
  })
  registerWorldIpc(store)
  registerDocumentIpc(store)
  registerAssetProtocol(store)
  const window = createMainWindow()
  const browser = new BrowserManager(window, mirror, (state: BrowserState) => window.webContents.send(IPC.browserStateChanged, state))
  registerBrowserIpc(browser)
  registerPlayerIpc(playerTransmission, app.getPath("userData"))
  const bridge = new BridgeHub(store, browser, (change) => {
    broadcast(change)
  }, (report) => playerTransmission?.setMasterView(report))
  bridge.register()
  changeListeners.push((change) => bridge.onDocumentChange(change))
  changeListeners.push((change) => playerTransmission?.onDocumentChange(change))
  app.on("before-quit", () => {
    stopPublicTunnel()
    void playerTransmission?.stop()
    if (playerWindow && !playerWindow.isDestroyed()) playerWindow.destroy()
    browser.destroy()
    mirror.close()
    store.close()
  })
})

app.on("window-all-closed", () => app.quit())
