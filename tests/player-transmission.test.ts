import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { PlayerTransmission } from "../src/main/player-transmission"
import { putDocument } from "../src/main/world-documents"
import { WorldStore } from "../src/main/world-store"
import type { PlayerWireMessage } from "../src/shared/player"

let root: string
let store: WorldStore
let transmission: PlayerTransmission
let sent: PlayerWireMessage[]

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "runas-vtt-transmission-"))
  store = new WorldStore(root)
  const world = await store.create({ title: "Mesa" })
  const { database } = await store.open(world.id)
  putDocument(database, { id: "cena", type: "scene", parentId: null, data: { name: "Cena" } })
  putDocument(database, { id: "outra", type: "scene", parentId: null, data: { name: "Outra" } })
  putDocument(database, { id: "visivel", type: "token", parentId: "cena", data: { name: "Aliado" } })
  putDocument(database, { id: "oculto", type: "token", parentId: "cena", data: { name: "Emboscada", hidden: true } })
  transmission = new PlayerTransmission(store, root, () => undefined)
  // Sem abrir porta: o teste observa só o que seria enviado aos espectadores.
  sent = []
  const internals = transmission as unknown as { enabled: boolean; server: { publish(message: PlayerWireMessage): void } }
  internals.server.publish = (message) => { sent.push(message) }
  internals.enabled = true
  transmission.setMasterView({ sceneId: "cena", selection: [], center: { x: 10, y: 10 }, zoom: 1 })
  sent = []
})

afterEach(async () => {
  store.close()
  await rm(root, { recursive: true, force: true })
})

describe("transmissão da Vista dos Jogadores", () => {
  it("mover a câmera do mestre não move a dos jogadores; só puxar a câmera", () => {
    transmission.setMasterView({ sceneId: "cena", selection: [], center: { x: 500, y: 300 }, zoom: 2 })
    expect(sent).toEqual([])
    transmission.pullCamera()
    expect(sent).toEqual([{ type: "camera", center: { x: 500, y: 300 }, zoom: 2 }])
  })

  it("a régua do mestre só chega aos jogadores na cena transmitida", () => {
    transmission.setRuler({ sceneId: "outra", from: { x: 0, y: 0 }, to: { x: 1, y: 1 } })
    expect(sent).toEqual([])
    transmission.setRuler({ sceneId: "cena", from: { x: 0, y: 0 }, to: { x: 200, y: 0 } })
    transmission.setRuler(null)
    expect(sent).toEqual([
      { type: "ruler", ruler: { sceneId: "cena", from: { x: 0, y: 0 }, to: { x: 200, y: 0 } } },
      { type: "ruler", ruler: null },
    ])
  })

  it("o dano flutua só sobre tokens que os jogadores veem", () => {
    const log = (tokenId: string) => ({ kind: "put" as const, document: { id: `log-${tokenId}`, type: "log-entry" as const, parentId: null, sort: 0, createdAt: 0, updatedAt: 0, data: { kind: "damage", title: "Dano", detail: "", tokenId, tokenName: "", sceneId: "cena", floatingText: "-9" } } })
    transmission.onDocumentChange(log("oculto"))
    transmission.onDocumentChange(log("visivel"))
    expect(sent).toEqual([{ type: "float", tokenId: "visivel", text: "-9", kind: "damage" }])
  })
})
