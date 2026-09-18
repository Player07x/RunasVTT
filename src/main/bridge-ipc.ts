import { ipcMain, type IpcMainInvokeEvent } from "electron"
import { IPC, type DocumentChange, type TableReport } from "../shared/ipc"
import { suiteSiteFor } from "../shared/sites"
import { importCharacters, listBridgeTokens, postLog, updateTokenCharacter, type TableState } from "./bridge-service"
import type { BrowserManager } from "./browser"
import type { WorldStore } from "./world-store"

/**
 * Liga a ponte `window.runasVTT` ao mundo aberto. A mesa informa cena,
 * seleção e centro da vista; os sites da suíte leem tokens e enviam fichas,
 * danos e testes.
 */
export class BridgeHub {
  private table: TableState = { sceneId: null, selection: [], center: null }

  constructor(
    private readonly store: WorldStore,
    private readonly browser: BrowserManager,
    private readonly emitChange?: (change: DocumentChange) => void,
    private readonly onTableChange?: (report: TableReport) => void,
  ) {}

  register(): void {
    ipcMain.handle(IPC.tableReport, (_event, report: TableReport) => this.report(report))
    ipcMain.handle(IPC.bridgeImportCharacters, async (event, items: unknown) => {
      const world = this.requireWorld(event)
      const { tokenIds, changes } = await importCharacters(world.database, world.summary.path, this.table, items)
      this.publish(changes)
      return { tokenIds }
    })
    ipcMain.handle(IPC.bridgeGetTokens, (event) => listBridgeTokens(this.requireWorld(event).database, this.table))
    ipcMain.handle(IPC.bridgeUpdateTokenCharacter, (event, tokenId: unknown, envelope: unknown, summary: unknown) => {
      this.publish([updateTokenCharacter(this.requireWorld(event).database, tokenId, envelope, summary)])
    })
    ipcMain.handle(IPC.bridgePostLog, (event, entry: unknown) => {
      this.publish(postLog(this.requireWorld(event).database, this.table, entry))
    })
  }

  /** Mudanças vindas da mesa (arrastar, excluir) também avisam os sites. */
  onDocumentChange(change: DocumentChange): void {
    if (change.kind === "delete" || change.document.type === "token" || change.document.type === "scene") this.browser.notifySuiteTabs(IPC.bridgeTokensChanged)
  }

  private report(report: TableReport): void {
    const sceneId = typeof report?.sceneId === "string" ? report.sceneId : null
    const selection = Array.isArray(report?.selection) ? report.selection.filter((id): id is string => typeof id === "string").slice(0, 200) : []
    const center = report?.center && Number.isFinite(report.center.x) && Number.isFinite(report.center.y) ? { x: report.center.x, y: report.center.y } : null
    const changed = sceneId !== this.table.sceneId || selection.join() !== this.table.selection.join()
    const zoom = typeof report?.zoom === "number" && Number.isFinite(report.zoom) ? Math.max(0.08, Math.min(5, report.zoom)) : null
    this.table = { sceneId, selection, center, zoom }
    this.onTableChange?.({ sceneId, selection, center, zoom })
    if (changed) this.browser.notifySuiteTabs(IPC.bridgeTokensChanged)
  }

  /**
   * Só o quadro principal de uma aba da suíte, numa origem da suíte, fala
   * com a ponte. O preload já não se expõe fora dessas origens; esta
   * checagem vale mesmo se uma página tentar invocar os canais por conta.
   */
  private requireWorld(event: IpcMainInvokeEvent) {
    const frame = event.senderFrame
    if (!frame || frame.parent !== null || !suiteSiteFor(frame.url) || !this.browser.isSuiteTab(event.sender.id)) throw new Error("Origem não autorizada.")
    const world = this.store.openWorld
    if (!world) throw new Error("Abra um mundo no RunasVTT.")
    return world
  }

  private publish(changes: DocumentChange[]): void {
    for (const change of changes) {
      this.emitChange?.(change)
      this.onDocumentChange(change)
    }
  }
}
