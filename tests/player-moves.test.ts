import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { normalizeMoveRequest, validatePlayerMove } from "../src/main/player-moves"
import { PlayerTransmission } from "../src/main/player-transmission"
import { putDocument } from "../src/main/world-documents"
import { WorldStore } from "../src/main/world-store"
import type { DocumentChange } from "../src/shared/ipc"
import type { PlayerWireMessage } from "../src/shared/player"
import type { TokenData } from "../src/shared/scene"
import type { WorldDatabase } from "../src/main/world-database"

let root: string
let store: WorldStore
let database: WorldDatabase

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "runas-vtt-moves-"))
  store = new WorldStore(root)
  const world = await store.create({ title: "Mesa" })
  database = (await store.open(world.id)).database
  putDocument(database, { id: "cena", type: "scene", parentId: null, data: { name: "Cena", width: 1000, height: 600 } })
  putDocument(database, { id: "outra", type: "scene", parentId: null, data: { name: "Outra" } })
  putDocument(database, { id: "parede", type: "wall", parentId: "cena", data: { x1: 500, y1: 0, x2: 500, y2: 600 } })
  putDocument(database, { id: "heroi", type: "token", parentId: "cena", data: { name: "Heroína", x: 150, y: 150, disposition: "player" } })
  putDocument(database, { id: "aliado", type: "token", parentId: "cena", data: { name: "Guarda", x: 250, y: 150, disposition: "friendly" } })
  putDocument(database, { id: "orc", type: "token", parentId: "cena", data: { name: "Orc", x: 350, y: 150, disposition: "hostile" } })
})

afterEach(async () => {
  store.close()
  await rm(root, { recursive: true, force: true })
})

const move = (tokenId: string, x: number, y: number, sceneId: string | null = "cena") => validatePlayerMove(database, sceneId, { tokenId, x, y })

describe("pedido de movimento", () => {
  it("só aceita a forma exata", () => {
    expect(normalizeMoveRequest({ type: "move", tokenId: "heroi", x: 1, y: 2 })).toEqual({ tokenId: "heroi", x: 1, y: 2 })
    expect(normalizeMoveRequest({ type: "put", tokenId: "heroi", x: 1, y: 2 })).toBeNull()
    expect(normalizeMoveRequest({ type: "move", tokenId: "../x", x: 1, y: 2 })).toBeNull()
    expect(normalizeMoveRequest({ type: "move", tokenId: "heroi", x: Number.NaN, y: 2 })).toBeNull()
  })
})

describe("validação do movimento", () => {
  it("move o token Jogador, encaixado na grade", () => {
    const result = move("heroi", 330, 290)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.token.data).toMatchObject({ x: 350, y: 250 })
  })

  it("recusa tokens que não são Jogador, ocultos e travados", () => {
    expect(move("aliado", 250, 250)).toMatchObject({ ok: false, reason: expect.stringMatching(/Jogador/) })
    expect(move("orc", 350, 250)).toMatchObject({ ok: false })
    const heroi = database.get("heroi")!.data as TokenData
    putDocument(database, { id: "heroi", type: "token", parentId: "cena", data: { ...heroi, locked: true } })
    expect(move("heroi", 250, 250)).toMatchObject({ ok: false, reason: expect.stringMatching(/travou/) })
    putDocument(database, { id: "heroi", type: "token", parentId: "cena", data: { ...heroi, hidden: true } })
    expect(move("heroi", 250, 250)).toMatchObject({ ok: false })
  })

  it("não atravessa paredes nem portas fechadas; porta aberta deixa passar", () => {
    expect(move("heroi", 750, 150)).toMatchObject({ ok: false, reason: expect.stringMatching(/parede/) })
    putDocument(database, { id: "parede", type: "wall", parentId: "cena", data: { x1: 500, y1: 0, x2: 500, y2: 600, kind: "door", open: true } })
    expect(move("heroi", 750, 150).ok).toBe(true)
  })

  it("não passa pela junta entre duas paredes nem para em cima delas", () => {
    // Parede dividida em dois trechos que se encontram em (500, 300): o caminho passa exatamente pela junta.
    putDocument(database, { id: "parede", type: "wall", parentId: "cena", data: { x1: 500, y1: 0, x2: 500, y2: 300 } })
    putDocument(database, { id: "parede2", type: "wall", parentId: "cena", data: { x1: 500, y1: 300, x2: 500, y2: 600 } })
    const heroi = database.get("heroi")!.data as TokenData
    putDocument(database, { id: "heroi", type: "token", parentId: "cena", data: { ...heroi, x: 250, y: 300, size: 2 } })
    expect(move("heroi", 800, 300)).toMatchObject({ ok: false })
    // Destino encaixado bem sobre a linha da parede.
    expect(move("heroi", 500, 200)).toMatchObject({ ok: false })
    // Um token que o mestre deixou sobre a parede ainda consegue sair dela.
    putDocument(database, { id: "heroi", type: "token", parentId: "cena", data: { ...heroi, x: 500, y: 200, size: 2 } })
    expect(move("heroi", 300, 200).ok).toBe(true)
  })

  it("não sai do mapa nem de outra cena", () => {
    expect(move("heroi", 1200, 150)).toMatchObject({ ok: false, reason: expect.stringMatching(/fora do mapa/) })
    expect(move("heroi", 250, 150, "outra")).toMatchObject({ ok: false })
    expect(move("heroi", 250, 150, null)).toMatchObject({ ok: false })
  })
})

describe("transmissão", () => {
  function transmission() {
    const committed: DocumentChange[] = []
    const instance = new PlayerTransmission(store, root, () => undefined)
    const internals = instance as unknown as { enabled: boolean; server: { publish(message: PlayerWireMessage): void } }
    internals.server.publish = () => undefined
    internals.enabled = true
    instance.setCommit((change) => committed.push(change))
    instance.setMasterView({ sceneId: "cena", selection: [], center: null, zoom: null })
    instance.refresh()
    return { instance, committed }
  }

  it("grava pelo mesmo caminho das mudanças da mesa e responde ao espectador", () => {
    const { instance, committed } = transmission()
    expect(instance.handleClientMessage({ type: "move", tokenId: "heroi", x: 250, y: 250 })).toEqual({ type: "move-result", tokenId: "heroi", ok: true })
    expect(committed).toHaveLength(1)
    expect((database.get("heroi")!.data as TokenData)).toMatchObject({ x: 250, y: 250 })
    expect(instance.handleClientMessage({ type: "ping" })).toBeNull()
  })

  it("recusa quando o mestre desligou o movimento", () => {
    const { instance, committed } = transmission()
    instance.setMovesEnabled(false)
    expect(instance.handleClientMessage({ type: "move", tokenId: "heroi", x: 250, y: 250 })).toMatchObject({ ok: false, reason: expect.stringMatching(/mestre/) })
    expect(committed).toEqual([])
    expect(instance.state().moves).toBe(false)
  })

  it("limita um cliente autenticado ao token do próprio assento", () => {
    const { instance, committed } = transmission()
    const token = database.get("heroi")!
    putDocument(database, { id: token.id, type: "token", parentId: token.parentId, data: { ...(token.data as TokenData), playerSlotId: "player-2" } })
    expect(instance.handleClientMessage({ type: "move", tokenId: "heroi", x: 250, y: 250 }, { slotId: "player-1", label: "Jogador 1" })).toMatchObject({ ok: false, reason: expect.stringMatching(/outro jogador/) })
    expect(committed).toEqual([])
  })
})
