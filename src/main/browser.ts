import { copyFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { app, net, session, WebContentsView, type BrowserWindow, type Session } from "electron"
import type { BrowserCommand, BrowserState, BrowserTab, OfflinePreparation, Rect, SiteSource } from "../shared/ipc"
import { SUITE_SITES, suiteSiteFor, type SuiteSiteId } from "../shared/sites"
import { createNetworkFetch } from "./electron-network"
import { SiteMirror } from "./site-mirror"
import { respond, warmSite, type ResponderDeps } from "./site-responder"

/**
 * Sessão persistente dos sites da suíte, com a cópia local (ADR 0002). Os
 * dados deles (fichas, wiki) sobrevivem entre execuções.
 */
export const SITES_PARTITION = "persist:runas-sites"
/** Sessão persistente para o resto da web (YouTube, música…): sem interceptação nenhuma. */
export const WEB_PARTITION = "persist:web"
const MIRROR_FILE = "site-mirror.db"
const SEED_FILE = "site-seed.db"
/** Arquivos que nenhuma atualização completa tocou por este tempo são sobras de builds antigos. */
const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000
/** Intervalo para notar que a internet voltou e para a atualização periódica. */
const CONNECTIVITY_CHECK_MS = 60 * 1000
const PERIODIC_REFRESH_MS = 6 * 60 * 60 * 1000

/** Permissões concedidas às páginas; todo o resto é negado. `fileSystem` atende o Obsidian por pasta local. */
const ALLOWED_PERMISSIONS = new Set(["fileSystem", "clipboard-sanitized-write", "fullscreen"])

/** Caminho da cópia inicial dos sites distribuída com o app, se existir. */
export function bundledSeedPath(): string {
  return app.isPackaged ? join(process.resourcesPath, SEED_FILE) : join(app.getAppPath(), "resources", SEED_FILE)
}

/**
 * Abre a cópia local. Na primeira execução, parte da cópia distribuída com o
 * app para que os sites funcionem offline desde o início (ADR 0002).
 */
export function openSiteMirror(): SiteMirror {
  const path = join(app.getPath("userData"), MIRROR_FILE)
  const seed = bundledSeedPath()
  if (!existsSync(path) && existsSync(seed)) copyFileSync(seed, path)
  return new SiteMirror(path)
}

/** Liga o interceptador de `https` a uma sessão. Devolve as dependências usadas, para testes. */
export function installSiteInterceptor(ses: Session, mirror: SiteMirror, options: Pick<ResponderDeps, "isForcedOffline" | "onServed">): ResponderDeps {
  const deps: ResponderDeps = {
    mirror,
    network: createNetworkFetch(ses),
    ...options,
  }
  ses.protocol.handle("https", (request) => respond(request, deps))
  return deps
}

function hardenSession(ses: Session): void {
  ses.setPermissionRequestHandler((_contents, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)))
  ses.setPermissionCheckHandler((_contents, permission) => ALLOWED_PERMISSIONS.has(permission))
}

/** Aceita "runas-dm.pages.dev/wiki" e completa com https://. Só http(s) é permitido. */
export function normalizeAddress(input: string): string | null {
  const value = input.trim()
  if (!value) return null
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`
  try {
    const url = new URL(candidate)
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null
  } catch {
    return null
  }
}

/**
 * Navegador integrado: abas em `WebContentsView` sobre a janela do VTT,
 * posicionadas na área que a interface reserva para elas.
 */
export class BrowserManager {
  private readonly ses: Session
  private readonly tabs = new Map<number, WebContentsView>()
  /** Abas na sessão da suíte (true) ou da web (false); a sessão de uma aba nunca muda. */
  private readonly suiteTabs = new Map<number, boolean>()
  private order: number[] = []
  private activeTabId: number | null = null
  private bounds: Rect | null = null
  private forcedOffline = false
  private lastSource = new Map<SuiteSiteId, SiteSource>()
  private preparation: OfflinePreparation = { running: false, siteId: null, done: 0, total: 0, failed: 0, finishedAt: null }
  private readonly deps: ResponderDeps
  private stateTimer: NodeJS.Timeout | null = null
  private connectivityTimer: NodeJS.Timeout | null = null
  private wasOnline = false
  private lastRefreshAt = 0

  constructor(private readonly window: BrowserWindow, private readonly mirror: SiteMirror, private readonly emit: (state: BrowserState) => void) {
    this.ses = session.fromPartition(SITES_PARTITION)
    hardenSession(this.ses)
    hardenSession(session.fromPartition(WEB_PARTITION))
    this.deps = installSiteInterceptor(this.ses, mirror, {
      isForcedOffline: () => this.forcedOffline,
      onServed: (site, source) => {
        if (this.lastSource.get(site.id) === source) return
        this.lastSource.set(site.id, source)
        this.scheduleState()
      },
    })
    window.on("resize", () => this.layout())
    this.watchConnectivity()
  }

  /**
   * Mantém a cópia local em dia sem intervenção: atualiza ao abrir o app,
   * quando a internet volta e a cada 6 horas online.
   */
  private watchConnectivity(): void {
    const check = () => {
      const online = net.isOnline()
      const reconnected = online && !this.wasOnline
      const due = online && Date.now() - this.lastRefreshAt > PERIODIC_REFRESH_MS
      this.wasOnline = online
      if ((reconnected || due) && !this.forcedOffline) void this.prepareOffline()
    }
    // Pequena espera para não disputar a rede com a abertura da janela.
    const tick = () => {
      check()
      this.connectivityTimer = setTimeout(tick, CONNECTIVITY_CHECK_MS)
    }
    this.connectivityTimer = setTimeout(tick, 5000)
  }

  state(): BrowserState {
    return {
      tabs: this.order.map((id) => this.describe(id)).filter((tab): tab is BrowserTab => tab !== null),
      activeTabId: this.activeTabId,
      forcedOffline: this.forcedOffline,
      sites: SUITE_SITES.map((site) => ({ siteId: site.id, label: site.label, origin: site.origin, ...this.mirror.stats(site.origin), lastSource: this.lastSource.get(site.id) ?? null })),
      preparation: { ...this.preparation },
    }
  }

  open(address: string): void {
    const url = normalizeAddress(address)
    if (!url) return
    const isSuiteTab = Boolean(suiteSiteFor(url))
    const view = new WebContentsView({
      webPreferences: { partition: isSuiteTab ? SITES_PARTITION : WEB_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    const contents = view.webContents
    const id = contents.id
    this.tabs.set(id, view)
    this.suiteTabs.set(id, isSuiteTab)
    this.order.push(id)
    contents.setWindowOpenHandler(({ url: target }) => {
      if (normalizeAddress(target)) this.open(target)
      return { action: "deny" }
    })
    // Um clique que cruza a fronteira suíte ↔ web abre em nova aba, na sessão
    // certa. Redirecionamentos (ex.: login) não passam por aqui e seguem na aba.
    contents.on("will-navigate", (event, target) => {
      if (!normalizeAddress(target)) { event.preventDefault(); return }
      if (Boolean(suiteSiteFor(target)) !== isSuiteTab) { event.preventDefault(); this.open(target) }
    })
    for (const event of ["did-start-loading", "did-stop-loading", "page-title-updated", "did-navigate", "did-navigate-in-page"] as const) {
      contents.on(event as "did-start-loading", () => this.scheduleState())
    }
    void contents.loadURL(url).catch(() => undefined)
    this.activate(id)
  }

  activate(tabId: number): void {
    if (!this.tabs.has(tabId)) return
    this.activeTabId = tabId
    this.layout()
    this.scheduleState()
  }

  close(tabId: number): void {
    const view = this.tabs.get(tabId)
    if (!view) return
    this.window.contentView.removeChildView(view)
    view.webContents.close()
    this.tabs.delete(tabId)
    this.suiteTabs.delete(tabId)
    const index = this.order.indexOf(tabId)
    this.order = this.order.filter((id) => id !== tabId)
    if (this.activeTabId === tabId) this.activeTabId = this.order[Math.min(index, this.order.length - 1)] ?? null
    this.layout()
    this.scheduleState()
  }

  navigate(tabId: number, address: string): void {
    const url = normalizeAddress(address)
    const view = this.tabs.get(tabId)
    if (!url || !view) return
    if (Boolean(suiteSiteFor(url)) !== this.suiteTabs.get(tabId)) { this.open(url); return }
    void view.webContents.loadURL(url).catch(() => undefined)
  }

  command(tabId: number, command: BrowserCommand): void {
    const contents = this.tabs.get(tabId)?.webContents
    if (!contents) return
    if (command === "back" && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
    if (command === "forward" && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
    if (command === "reload") contents.reload()
  }

  setBounds(bounds: Rect | null): void {
    this.bounds = bounds
    this.layout()
  }

  setForcedOffline(offline: boolean): void {
    this.forcedOffline = offline
    this.scheduleState()
  }

  async prepareOffline(): Promise<void> {
    if (this.preparation.running) return
    this.preparation = { running: true, siteId: null, done: 0, total: 0, failed: 0, finishedAt: null }
    this.scheduleState()
    const startedAt = Date.now()
    let done = 0
    let total = 0
    let failed = 0
    for (const site of SUITE_SITES) {
      const result = await warmSite(site, this.deps, (progress) => {
        this.preparation = { running: true, siteId: site.id, done: done + progress.done, total: total + progress.total, failed: failed + progress.failed, finishedAt: null }
        this.scheduleState()
      })
      done += result.done
      total += result.total
      failed += result.failed
      // Só limpa depois de uma atualização completa do site: um download
      // interrompido nunca apaga a cópia que ainda funciona.
      if (result.failed === 0) this.mirror.prune(site.origin, startedAt - STALE_AFTER_MS)
    }
    this.lastRefreshAt = Date.now()
    this.preparation = { running: false, siteId: null, done, total, failed, finishedAt: Date.now() }
    this.scheduleState()
  }

  destroy(): void {
    if (this.connectivityTimer) clearTimeout(this.connectivityTimer)
    for (const id of [...this.order]) this.close(id)
  }

  /** Mostra só a aba ativa, e só quando a interface reservou uma área para ela. */
  private layout(): void {
    for (const [id, view] of this.tabs) {
      const visible = id === this.activeTabId && this.bounds !== null && this.bounds.width > 0 && this.bounds.height > 0
      if (visible) {
        this.window.contentView.addChildView(view)
        view.setBounds({ x: Math.round(this.bounds!.x), y: Math.round(this.bounds!.y), width: Math.round(this.bounds!.width), height: Math.round(this.bounds!.height) })
      } else {
        this.window.contentView.removeChildView(view)
      }
    }
  }

  private describe(id: number): BrowserTab | null {
    const contents = this.tabs.get(id)?.webContents
    if (!contents || contents.isDestroyed()) return null
    const url = contents.getURL()
    return {
      id,
      title: contents.getTitle() || url,
      url,
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      siteId: suiteSiteFor(url)?.id ?? null,
    }
  }

  /** Agrupa várias mudanças seguidas em um único envio para a interface. */
  private scheduleState(): void {
    if (this.stateTimer) return
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null
      if (!this.window.isDestroyed()) this.emit(this.state())
    }, 50)
  }
}
