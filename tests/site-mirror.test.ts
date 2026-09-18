import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { bypassesMirror, extractAssetUrls, isStorableResponse, navigationFallbackKeys } from "../src/main/mirror-policy"
import { SiteMirror } from "../src/main/site-mirror"
import { respond, warmSite, type ResponderDeps } from "../src/main/site-responder"
import { SUITE_SITES } from "../src/shared/sites"

const DM = "https://runas-dm.pages.dev"
const html = (extra = "") => `<html><head><link rel="stylesheet" href="/_next/static/css/app.css"><script src="/_next/static/chunks/main.js"></script>${extra}</head></html>`

function request(url: string, init: RequestInit & { navigation?: boolean } = {}): Request {
  const headers = new Headers(init.headers)
  if (init.navigation) headers.set("sec-fetch-dest", "document")
  return new Request(url, { ...init, headers })
}

let dir: string
let mirror: SiteMirror
let online: boolean
let calls: string[]
let pages: Record<string, { body: string; type: string; status?: number; headers?: Record<string, string> }>

function deps(overrides: Partial<ResponderDeps> = {}): ResponderDeps {
  return {
    mirror,
    isForcedOffline: () => false,
    network: async (req) => {
      calls.push(req.url)
      if (!online) throw new TypeError("net::ERR_INTERNET_DISCONNECTED")
      const page = pages[req.url]
      if (!page) return new Response("não encontrado", { status: 404 })
      return new Response(page.body, { status: page.status ?? 200, headers: { "content-type": page.type, ...page.headers } })
    },
    ...overrides,
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "runas-vtt-mirror-"))
  mirror = new SiteMirror(join(dir, "mirror.db"))
  online = true
  calls = []
  pages = {
    [`${DM}/`]: { body: html(), type: "text/html; charset=utf-8" },
    [`${DM}/wiki`]: { body: html(), type: "text/html; charset=utf-8" },
    [`${DM}/_next/static/css/app.css`]: { body: "body{background:url(/_next/static/media/bg.webp)}", type: "text/css" },
    [`${DM}/_next/static/chunks/main.js`]: { body: 'import("/_next/static/chunks/lazy-dialog.js")', type: "text/javascript" },
    [`${DM}/_next/static/chunks/lazy-dialog.js`]: { body: "export default 1", type: "text/javascript" },
    [`${DM}/_next/static/media/bg.webp`]: { body: "webp", type: "image/webp" },
    [`${DM}/manifest.webmanifest`]: { body: '{"icons":[{"src":"/icon-192.png"}]}', type: "application/manifest+json" },
    [`${DM}/icon-192.png`]: { body: "png", type: "image/png" },
  }
})

afterEach(async () => {
  mirror.close()
  await rm(dir, { recursive: true, force: true })
})

describe("política da cópia local", () => {
  it("nunca copia backup, autenticação, Cloudflare, RSC nem escrita", () => {
    expect(bypassesMirror(request(`${DM}/api/backup`))).toBe(true)
    expect(bypassesMirror(request(`${DM}/api/campaign-data`))).toBe(true)
    expect(bypassesMirror(request("https://runas-book.pages.dev/api/book-auth"))).toBe(true)
    expect(bypassesMirror(request(`${DM}/cdn-cgi/access/login`))).toBe(true)
    expect(bypassesMirror(request(`${DM}/wiki?_rsc=abc`))).toBe(true)
    expect(bypassesMirror(request(`${DM}/wiki`, { headers: { RSC: "1" } }))).toBe(true)
    expect(bypassesMirror(request(`${DM}/`, { method: "POST", body: "x" }))).toBe(true)
    expect(bypassesMirror(request(`${DM}/wiki`))).toBe(false)
  })

  it("só grava respostas 200 reutilizáveis", () => {
    expect(isStorableResponse(200, new Headers())).toBe(true)
    expect(isStorableResponse(404, new Headers())).toBe(false)
    expect(isStorableResponse(302, new Headers())).toBe(false)
    expect(isStorableResponse(200, new Headers({ "cache-control": "no-store" }))).toBe(false)
    expect(isStorableResponse(200, new Headers({ "set-cookie": "a=1" }))).toBe(false)
  })

  it("oferece alternativas de navegação sem query e com/sem barra final", () => {
    expect(navigationFallbackKeys(`${DM}/?view=encounter`)).toEqual([`${DM}/`])
    expect(navigationFallbackKeys("https://runas-tools.pages.dev/galeria-personagens")).toEqual(["https://runas-tools.pages.dev/galeria-personagens/"])
  })

  it("encontra assets em HTML, CSS e JavaScript, inclusive imports sob demanda", () => {
    expect(extractAssetUrls(html('<link rel="icon" href="/favicon.svg">'), `${DM}/`).sort()).toEqual([
      `${DM}/_next/static/chunks/main.js`, `${DM}/_next/static/css/app.css`, `${DM}/favicon.svg`,
    ].sort())
    expect(extractAssetUrls('import("/_next/static/chunks/lazy-dialog.js")', `${DM}/x.js`)).toEqual([`${DM}/_next/static/chunks/lazy-dialog.js`])
  })

  it("encontra imagens de CSS, ícones relativos do manifesto e o pré-cache do service worker", () => {
    expect(extractAssetUrls('.shell{background:url("/runas-red-tree-bg.webp")}@font-face{src:url(../media/geist.woff2)}', `${DM}/_next/static/css/index.css`).sort()).toEqual([
      `${DM}/_next/static/media/geist.woff2`, `${DM}/runas-red-tree-bg.webp`,
    ])
    const tools = "https://runas-tools.pages.dev"
    expect(extractAssetUrls('{"icons":[{"src":"./icon-512.png"}]}', `${tools}/manifest.webmanifest`)).toEqual([`${tools}/icon-512.png`])
    expect(extractAssetUrls('const APP_SHELL = ["./", "./Norse.otf", "./runic-card-back.webp"]', `${tools}/sw.js`).sort()).toEqual([`${tools}/Norse.otf`, `${tools}/runic-card-back.webp`])
  })
})

describe("respond", () => {
  it("online: busca na rede e guarda a cópia; offline: serve a cópia", async () => {
    const online1 = await respond(request(`${DM}/wiki`, { navigation: true }), deps())
    expect(online1.status).toBe(200)
    expect(await online1.text()).toContain("main.js")
    online = false
    const offline = await respond(request(`${DM}/wiki`, { navigation: true }), deps())
    expect(offline.headers.get("x-runas-vtt-source")).toBe("mirror")
    expect(await offline.text()).toContain("main.js")
  })

  it("offline sem cópia exata: navegação usa a rota sem query", async () => {
    await respond(request(`${DM}/`, { navigation: true }), deps())
    online = false
    const response = await respond(request(`${DM}/?view=encounter`, { navigation: true }), deps())
    expect(response.headers.get("x-runas-vtt-source")).toBe("mirror")
  })

  it("offline sem cópia nenhuma: página explicativa para navegação e 504 para recurso", async () => {
    online = false
    const page = await respond(request(`${DM}/campaigns`, { navigation: true }), deps())
    expect(page.status).toBe(503)
    expect(await page.text()).toContain("Preparar offline")
    expect((await respond(request(`${DM}/_next/static/chunks/x.js`), deps())).status).toBe(504)
  })

  it("assets com hash vêm da cópia sem tocar a rede", async () => {
    await respond(request(`${DM}/_next/static/chunks/main.js`), deps())
    calls = []
    const response = await respond(request(`${DM}/_next/static/chunks/main.js`), deps())
    expect(response.headers.get("x-runas-vtt-source")).toBe("mirror")
    expect(calls).toEqual([])
  })

  it("modo offline forçado nunca chama a rede para os sites da suíte", async () => {
    await respond(request(`${DM}/wiki`, { navigation: true }), deps())
    calls = []
    const response = await respond(request(`${DM}/wiki`, { navigation: true }), deps({ isForcedOffline: () => true }))
    expect(response.headers.get("x-runas-vtt-source")).toBe("mirror")
    expect((await respond(request(`${DM}/api/backup`), deps({ isForcedOffline: () => true }))).status).toBe(503)
    expect(calls).toEqual([])
  })

  it("o backup nunca é copiado nem servido da cópia", async () => {
    pages[`${DM}/api/backup`] = { body: '{"state":1}', type: "application/json" }
    await respond(request(`${DM}/api/backup`), deps())
    expect(mirror.has(`${DM}/api/backup`)).toBe(false)
  })

  it("sites de fora da suíte passam direto, sem cópia", async () => {
    pages["https://www.youtube.com/"] = { body: "yt", type: "text/html" }
    await respond(request("https://www.youtube.com/", { navigation: true }), deps())
    expect(mirror.has("https://www.youtube.com/")).toBe(false)
  })

  it("HEAD offline responde pela cópia, sem corpo e sem gravar", async () => {
    await respond(request(`${DM}/wiki`, { navigation: true }), deps())
    online = false
    const hit = await respond(request(`${DM}/wiki`, { method: "HEAD" }), deps())
    expect(hit.status).toBe(200)
    expect(hit.headers.get("x-runas-vtt-source")).toBe("mirror")
    expect((await respond(request(`${DM}/nada`, { method: "HEAD" }), deps())).status).toBe(504)
  })

  it("redirecionamentos passam ao navegador sem ser gravados", async () => {
    const network: ResponderDeps["network"] = async () => new Response(null, { status: 308, headers: { location: "/galeria/" } })
    const response = await respond(request("https://runas-tools.pages.dev/galeria", { navigation: true }), deps({ network }))
    expect(response.status).toBe(308)
    expect(response.headers.get("location")).toBe("/galeria/")
    expect(mirror.has("https://runas-tools.pages.dev/galeria")).toBe(false)
  })

  it("erro 5xx com cópia disponível serve a cópia", async () => {
    await respond(request(`${DM}/wiki`, { navigation: true }), deps())
    pages[`${DM}/wiki`] = { body: "erro", type: "text/html", status: 502 }
    const response = await respond(request(`${DM}/wiki`, { navigation: true }), deps())
    expect(response.headers.get("x-runas-vtt-source")).toBe("mirror")
  })
})

describe("warmSite", () => {
  it("copia rotas e todos os assets referenciados, recursivamente", async () => {
    const dm = { ...SUITE_SITES.find((site) => site.id === "dm")!, warmupPaths: ["/", "/wiki", "/manifest.webmanifest"] }
    const result = await warmSite(dm, deps())
    for (const url of ["/", "/wiki", "/_next/static/css/app.css", "/_next/static/chunks/main.js", "/_next/static/chunks/lazy-dialog.js", "/_next/static/media/bg.webp", "/manifest.webmanifest", "/icon-192.png"]) {
      expect(mirror.has(`${DM}${url}`), url).toBe(true)
    }
    expect(result.failed).toBe(0)
    expect(result.done).toBe(result.total)
  })
})

describe("SiteMirror.prune", () => {
  it("remove só arquivos antigos da origem indicada", () => {
    mirror.put(`${DM}/_next/static/chunks/antigo.js`, 200, new Headers({ "content-type": "text/javascript" }), new Uint8Array([1]))
    mirror.put("https://runas-tools.pages.dev/", 200, new Headers(), new Uint8Array([1]))
    const cutoff = Date.now() + 1
    expect(mirror.prune(DM, cutoff)).toBe(1)
    expect(mirror.has(`${DM}/_next/static/chunks/antigo.js`)).toBe(false)
    expect(mirror.has("https://runas-tools.pages.dev/")).toBe(true)
  })
})
