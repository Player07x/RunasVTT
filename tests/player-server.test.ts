import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runInNewContext } from "node:vm"
import { PlayerServer, withSeatBridge } from "../src/main/player-server"
import { SEAT_BRIDGE_SCRIPT } from "../src/player/seat-bridge"
import type { PlayerProjection } from "../src/shared/player"
import { SiteMirror } from "../src/main/site-mirror"

const projection: PlayerProjection = { scene: null, children: [], assets: [], vision: null, regions: [] }
const servers: PlayerServer[] = []
const mirrors: SiteMirror[] = []

afterEach(async () => { for (const server of servers.splice(0)) await server.stop(); for (const mirror of mirrors.splice(0)) mirror.close() })

describe("servidor da Vista dos Jogadores", () => {
  it("exige a chave para a página e serve só o bundle permitido", async () => {
    const root = join(tmpdir(), `runas-vtt-player-${Date.now()}`)
    await mkdir(root, { recursive: true })
    await writeFile(join(root, "player.html"), "<h1>player</h1>")
    const server = new PlayerServer({ staticRoot: root, worldPath: () => null, projection: () => projection, snapshot: () => ({ type: "snapshot", projection, ruler: null, audio: null, moves: false }), onSpectators: () => undefined })
    servers.push(server)
    await server.start(0, "chave")
    const base = `http://127.0.0.1:${server.addressPort}`
    expect((await fetch(`${base}/`)).status).toBe(404)
    expect((await fetch(`${base}/?k=chave`)).status).toBe(200)
    expect((await fetch(`${base}/player.html?k=errada`)).status).toBe(404)
    await rm(root, { recursive: true, force: true })
  })

  it("serve somente assets que a projeção atual referencia", async () => {
    const root = join(tmpdir(), `runas-vtt-player-assets-${Date.now()}`)
    const world = join(root, "world")
    const hash = "a".repeat(64)
    await mkdir(join(world, "assets", "maps"), { recursive: true })
    await writeFile(join(world, "assets", "maps", `${hash}.png`), Buffer.from([1, 2, 3]))
    const server = new PlayerServer({ staticRoot: root, worldPath: () => world, projection: () => ({ scene: null, children: [], assets: [`maps/${hash}.png`], vision: null, regions: [] }), snapshot: () => ({ type: "snapshot", projection, ruler: null, audio: null, moves: false }), onSpectators: () => undefined })
    servers.push(server)
    await server.start(0, "chave")
    const base = `http://127.0.0.1:${server.addressPort}`
    expect((await fetch(`${base}/assets/maps/${hash}.png?k=chave`)).status).toBe(200)
    expect((await fetch(`${base}/assets/maps/${"b".repeat(64)}.png?k=chave`)).status).toBe(404)
    await rm(root, { recursive: true, force: true })
  })

  it("faz o ingresso por código, grava cookie HttpOnly e protege o Tools", async () => {
    const root = join(tmpdir(), `runas-vtt-player-seat-${Date.now()}`)
    await mkdir(root, { recursive: true })
    await writeFile(join(root, "player.html"), "<h1>player</h1>")
    const mirror = new SiteMirror(join(root, "mirror.db"))
    mirror.put("https://runas-tools.pages.dev/", 200, new Headers({ "content-type": "text/html; charset=utf-8" }), new TextEncoder().encode("<html><head></head><body><h1>tools</h1></body></html>"))
    mirror.put("https://runas-tools.pages.dev/_next/static/app.js", 200, new Headers({ "content-type": "text/javascript" }), new TextEncoder().encode("console.log('tools')"))
    mirrors.push(mirror)
    const server = new PlayerServer({
      staticRoot: root,
      toolsMirror: mirror,
      worldPath: () => null,
      projection: () => projection,
      snapshot: () => ({ type: "snapshot", projection, ruler: null, audio: null, moves: false }),
      onSpectators: () => undefined,
      joinSeat: (code) => code === "ABCD-EFGH" ? { seat: { slotId: "player-1", label: "Jogador 1" }, token: "token-secreto" } : null,
      authenticateSeat: (token) => token === "token-secreto" ? { slotId: "player-1", label: "Jogador 1" } : null,
    })
    servers.push(server)
    await server.start(0, "chave")
    const base = `http://127.0.0.1:${server.addressPort}`
    expect((await fetch(`${base}/tools/?k=chave`)).status).toBe(401)
    const joined = await fetch(`${base}/seat/join?k=chave`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "ABCD-EFGH" }) })
    expect(joined.status).toBe(200)
    const setCookie = joined.headers.get("set-cookie")
    expect(setCookie).toContain("runas_seat=token-secreto")
    expect(setCookie).toContain("HttpOnly")
    const cookie = setCookie?.split(";")[0]
    expect((await fetch(`${base}/seat?k=chave`, { headers: { cookie: cookie ?? "" } })).status).toBe(200)
    const tools = await fetch(`${base}/tools/?k=chave`, { headers: { cookie: cookie ?? "" } })
    expect(tools.status).toBe(200)
    const toolsHtml = await tools.text()
    expect(toolsHtml).toContain("tools")
    expect(toolsHtml).toContain("/tools/runas-vtt-seat.js")
    const bridge = await fetch(`${base}/tools/runas-vtt-seat.js`, { headers: { cookie: cookie ?? "", referer: `${base}/tools/?k=chave` } })
    expect(bridge.status).toBe(200)
    expect(await bridge.text()).toContain("window.runasVTT")
    const toolAsset = await fetch(`${base}/_next/static/app.js`, { headers: { cookie: cookie ?? "", referer: `${base}/tools/?k=chave` } })
    expect(toolAsset.status).toBe(200)
    expect(await toolAsset.text()).toContain("console.log")
    // Depois da primeira navegação o Next pode remover ?k=; o cookie do
    // assento continua sendo a autorização da origem /tools.
    expect((await fetch(`${base}/tools/`, { headers: { cookie: cookie ?? "" } })).status).toBe(200)
    expect((await fetch(`${base}/_next/static/app.js`, { headers: { cookie: cookie ?? "", referer: `${base}/tools/` } })).status).toBe(200)
    expect((await fetch(`${base}/sw.js`, { headers: { cookie: cookie ?? "", referer: `${base}/tools/` } })).status).toBe(404)
    expect((await fetch(`${base}/tools/`, { headers: { cookie: cookie ?? "", origin: "https://evil.example" } })).status).toBe(403)
    mirror.close()
    mirrors.splice(mirrors.indexOf(mirror), 1)
    await rm(root, { recursive: true, force: true })
  })
})

/**
 * O assento vive em `http://IP:porta`, que não é contexto seguro, e o
 * navegador esconde `crypto.randomUUID` aí. Só `127.0.0.1` escapa — por isso
 * a janela local do mestre funcionava e o jogador da rede local recebia
 * "crypto.randomUUID is not a function" ao importar uma ficha.
 */
describe("shim do assento", () => {
  /** Roda o script do shim num contexto sem `randomUUID`, como o do jogador. */
  function run(crypto: Record<string, unknown>): Record<string, unknown> {
    const context = { crypto, window: {} as Record<string, unknown>, location: { search: "", protocol: "http:", host: "192.168.0.2:30000" }, URLSearchParams, Set, Uint8Array, Object, WebSocket: class {}, fetch: async () => new Response(), setInterval: () => 0, clearInterval: () => undefined }
    runInNewContext(SEAT_BRIDGE_SCRIPT, context)
    return context.crypto
  }

  const getRandomValues = (array: Uint8Array) => { for (let index = 0; index < array.length; index += 1) array[index] = (index * 37 + 11) % 256; return array }

  it("repõe crypto.randomUUID com um UUID v4 válido fora de contexto seguro", () => {
    const crypto = run({ getRandomValues })
    expect(typeof crypto.randomUUID).toBe("function")
    expect((crypto.randomUUID as () => string)()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it("não substitui a implementação nativa quando ela existe", () => {
    const native = () => "nativo"
    expect(run({ getRandomValues, randomUUID: native }).randomUUID).toBe(native)
  })
})

describe("injeção do shim no HTML do Tools", () => {
  it("entra no começo do head, antes dos scripts do Tools", () => {
    const html = '<!doctype html><html><head><script src="/_next/static/chunks/app.js"></script></head><body></body></html>'
    const injected = withSeatBridge(html)
    expect(injected.indexOf("runas-vtt-seat.js")).toBeLessThan(injected.indexOf("/_next/static/chunks/app.js"))
    expect(injected).toContain('<head><script src="/tools/runas-vtt-seat.js"></script>')
  })

  it("aceita atributos no head, não injeta duas vezes e tem saída sem head", () => {
    expect(withSeatBridge('<head lang="pt-BR"><title>x</title></head>')).toContain('<head lang="pt-BR"><script src="/tools/runas-vtt-seat.js"></script>')
    const once = withSeatBridge("<head></head>")
    expect(withSeatBridge(once)).toBe(once)
    expect(withSeatBridge('<body><script src="/app.js"></script></body>')).toContain('<body><script src="/tools/runas-vtt-seat.js"></script><script src="/app.js">')
  })
})
