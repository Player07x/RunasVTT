import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { PlayerServer } from "../src/main/player-server"
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
