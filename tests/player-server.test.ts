import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { PlayerServer } from "../src/main/player-server"
import type { PlayerProjection } from "../src/shared/player"

const projection: PlayerProjection = { scene: null, children: [], assets: [], vision: null, regions: [] }
const servers: PlayerServer[] = []

afterEach(async () => { for (const server of servers.splice(0)) await server.stop() })

describe("servidor da Vista dos Jogadores", () => {
  it("exige a chave para a página e serve só o bundle permitido", async () => {
    const root = join(tmpdir(), `runas-vtt-player-${Date.now()}`)
    await mkdir(root, { recursive: true })
    await writeFile(join(root, "player.html"), "<h1>player</h1>")
    const server = new PlayerServer({ staticRoot: root, worldPath: () => null, projection: () => projection, snapshot: () => ({ type: "snapshot", projection, ruler: null, audio: null }), onSpectators: () => undefined })
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
    const server = new PlayerServer({ staticRoot: root, worldPath: () => world, projection: () => ({ scene: null, children: [], assets: [`maps/${hash}.png`], vision: null, regions: [] }), snapshot: () => ({ type: "snapshot", projection, ruler: null, audio: null }), onSpectators: () => undefined })
    servers.push(server)
    await server.start(0, "chave")
    const base = `http://127.0.0.1:${server.addressPort}`
    expect((await fetch(`${base}/assets/maps/${hash}.png?k=chave`)).status).toBe(200)
    expect((await fetch(`${base}/assets/maps/${"b".repeat(64)}.png?k=chave`)).status).toBe(404)
    await rm(root, { recursive: true, force: true })
  })
})
