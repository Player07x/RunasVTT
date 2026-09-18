import { mkdirSync, rmSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { app, BrowserWindow, session } from "electron"
import { SUITE_SITES } from "../shared/sites"
import { bundledSeedPath, installSiteInterceptor } from "./browser"
import { bypassesMirror } from "./mirror-policy"
import { SiteMirror } from "./site-mirror"
import { warmSite, type ResponseSource } from "./site-responder"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * `electron . --smoke-browser`: valida o navegador integrado contra os sites
 * reais. Usa uma sessão em memória e uma cópia temporária; nada do usuário é
 * tocado. Precisa de internet.
 */
export async function runBrowserSmokeTest(): Promise<void> {
  const dir = await mkdtemp(join(app.getPath("temp"), "runas-vtt-browser-smoke-"))
  const mirror = new SiteMirror(join(dir, "mirror.db"))
  const ses = session.fromPartition(`smoke-${Date.now()}`)
  let offline = false
  const served: { url: string; source: ResponseSource; detail: string }[] = []
  const deps = installSiteInterceptor(ses, mirror, { isForcedOffline: () => offline, onServed: (_site, source, url, request) => served.push({ url, source, detail: `${request.method} dest=${request.headers.get("sec-fetch-dest")} mode=${request.headers.get("sec-fetch-mode")} key=${mirror.has(url)}` }) })
  const window = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { session: ses, sandbox: true, contextIsolation: true } })
  const consoleErrors: string[] = []
  window.webContents.on("console-message", (details) => { if (details.level === "error") consoleErrors.push(details.message.slice(0, 200)) })

  async function visit(url: string) {
    await window.loadURL(url).catch(() => undefined)
    await wait(2500)
    const page = await window.webContents.executeJavaScript("({ title: document.title, text: document.body ? document.body.innerText.length : 0 })") as { title: string; text: number }
    return { url, finalUrl: window.webContents.getURL(), ...page }
  }

  const report: Record<string, unknown> = {}
  try {
    // 1. Online, com redirecionamento de barra final (Pages responde 308).
    report.redirect = await visit("https://runas-tools.pages.dev/galeria-personagens")
    // 2. POST passa direto e o servidor responde (token errado → 401).
    await visit("https://runas-book.pages.dev/")
    report.postStatus = await window.webContents.executeJavaScript(`fetch("/api/book-auth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "token-invalido-de-teste" }) }).then((r) => r.status)`)
    // 3. Preparar offline.
    const warmed: Record<string, unknown> = {}
    for (const site of SUITE_SITES) {
      const result = await warmSite(site, deps)
      warmed[site.id] = { stored: result.stored, failed: result.failed, total: result.total, ...mirror.stats(site.origin) }
    }
    report.warmed = warmed
    // 4. Offline: sem service workers nem Cache Storage, só a cópia do VTT.
    //    Pedidos RSC falham de propósito (nunca são copiados); o Next.js cai
    //    para a navegação de documento, que vem da cópia.
    await ses.clearStorageData({ storages: ["serviceworkers", "cachestorage"] })
    await ses.clearCache()
    offline = true
    served.length = 0
    consoleErrors.length = 0
    const offlinePages = []
    for (const url of ["https://runas-dm.pages.dev/", "https://runas-dm.pages.dev/?view=encounter", "https://runas-dm.pages.dev/wiki", "https://runas-dm.pages.dev/campaigns", "https://runas-tools.pages.dev/", "https://runas-tools.pages.dev/calculadora-dano/", "https://runas-book.pages.dev/", "https://runas-book.pages.dev/dm/"]) {
      offlinePages.push(await visit(url))
    }
    report.offlinePages = offlinePages
    report.offlineServed = { mirror: served.filter((entry) => entry.source === "mirror").length, network: served.filter((entry) => entry.source === "network").length, unavailable: served.filter((entry) => entry.source === "unavailable" && !bypassesMirror({ method: "GET", url: entry.url, headers: new Headers() })).map((entry) => `${entry.url} ${entry.detail}`), expectedBypass: served.filter((entry) => entry.source === "unavailable" && bypassesMirror({ method: "GET", url: entry.url, headers: new Headers() })).length }
    report.offlineConsoleErrors = consoleErrors.slice(0, 10)
    const redirect = report.redirect as { finalUrl: string }
    const ok = redirect.finalUrl.endsWith("/galeria-personagens/")
      && report.postStatus === 401
      && offlinePages.every((page) => page.text > 40)
      && (report.offlineServed as { network: number; unavailable: string[] }).network === 0
      && (report.offlineServed as { unavailable: string[] }).unavailable.length === 0
    console.log(`SMOKE-BROWSER ${JSON.stringify({ ok, ...report }, null, 2)}`)
    process.exitCode = ok ? 0 : 1
  } catch (error) {
    console.error("SMOKE-BROWSER FAILED", error)
    process.exitCode = 1
  } finally {
    window.destroy()
    mirror.close()
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * `electron . --seed-sites`: gera `resources/site-seed.db`, a cópia inicial
 * dos três sites que acompanha o app e é usada na primeira execução.
 */
export async function runSeedSites(): Promise<void> {
  const path = bundledSeedPath()
  mkdirSync(dirname(path), { recursive: true })
  rmSync(path, { force: true })
  const mirror = new SiteMirror(path)
  const ses = session.fromPartition(`seed-${Date.now()}`)
  const deps = installSiteInterceptor(ses, mirror, { isForcedOffline: () => false })
  try {
    for (const site of SUITE_SITES) {
      const result = await warmSite(site, deps)
      console.log(`SEED ${site.id}: ${result.stored} arquivos copiados, ${result.failed} falhas, ${(mirror.stats(site.origin).bytes / 1_048_576).toFixed(1)} MB`)
      if (result.stored === 0) process.exitCode = 1
    }
  } finally {
    mirror.close()
  }
}
