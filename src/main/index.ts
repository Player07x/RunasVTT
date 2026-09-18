import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { app, BrowserWindow, ipcMain, shell } from "electron"
import { IPC, type AppInfo } from "../shared/ipc"
import type { NewWorldInput, WorldSummary } from "../shared/world"
import { WorldStore } from "./world-store"

const isSmokeTest = process.argv.includes("--smoke")

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

  // A janela do VTT nunca navega para fora da própria interface. Sites abrem
  // no navegador integrado (Fase 1) ou, por enquanto, no navegador do sistema.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: "deny" }
  })
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault()
  })

  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(__dirname, "../renderer/index.html"))
  return window
}

function registerIpc(store: WorldStore): void {
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
  const store = new WorldStore(join(app.getPath("userData"), "worlds"))
  registerIpc(store)
  createMainWindow()
  app.on("before-quit", () => store.close())
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow() })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
