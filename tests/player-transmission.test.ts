import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { PlayerTransmission, sameSeatCharacter } from "../src/main/player-transmission"
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

  it("anexa a ficha autenticada ao assento e à cena da Mesa", async () => {
    transmission.setMasterView({ sceneId: "cena", selection: [], center: { x: 100, y: 100 }, zoom: 1 })
    const state = await transmission.start(31000 + (Date.now() % 500), 1)
    const server = (transmission as unknown as { server: { addressPort: number } }).server
    const base = `http://127.0.0.1:${server.addressPort}`
    const key = state.key!
    const joined = await fetch(`${base}/seat/join?k=${key}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: state.seats[0]!.code }) })
    expect(joined.status).toBe(200)
    const cookie = joined.headers.get("set-cookie")?.split(";")[0] ?? ""
    const put = await fetch(`${base}/seat/character?k=${key}`, { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({
      character: { envelope: { version: 1, character: { name: "Lia" } }, summary: { name: "Lia", bars: [{ label: "PV", value: 10, max: 10 }] }, source: "tools", tokenImage: null, tokenSize: 1 },
      tokenId: null,
      baseRevision: 0,
      mutationId: "mutation-1",
    }) })
    expect(put.status).toBe(200)
    const body = await put.json() as { character: { revision: number; tokenId: string | null } }
    expect(body.character.revision).toBe(1)
    expect(body.character.tokenId).toMatch(/^seat-token-player-1/)
    expect(store.openWorld?.database.list("seat-character", null)).toHaveLength(1)
    expect(store.openWorld?.database.list("token", "cena").some((document) => (document.data as { playerSlotId?: string }).playerSlotId === "player-1")).toBe(true)
    await transmission.stop()
  })
})

/**
 * A ficha do assento é reescrita a cada gravação do token — e mover no mapa é
 * uma gravação. Subir a revisão nessa hora derrubava o que o jogador estava
 * digitando e fazia o envio seguinte voltar 409. Como o jogador move o próprio
 * token (ADR 0017), ele apagava a própria ficha ao andar.
 */
describe("ficha do assento contra movimento do token", () => {
  /** Um token de jogador com ficha anexada, como o envio do assento cria. */
  function anexarFicha() {
    const database = store.openWorld!.database
    const actor = { envelope: { version: 23, character: { name: "Jogador 1" } }, summary: { name: "Jogador 1", bars: [] }, source: "tools", tokenImage: null, tokenSize: 1 }
    const { change } = putDocument(database, { id: "token-jogador", type: "token", parentId: "cena", data: { name: "Jogador 1", playerSlotId: "player-1", actor, x: 0, y: 0 } })
    transmission.onDocumentChange(change)
    const documento = database.get("seat-character-player-1")
    return { database, actor, revisao: (documento?.data as { revision: number } | undefined)?.revision ?? 0 }
  }

  it("mover o token não muda a ficha nem a revisão", () => {
    const { database, actor, revisao } = anexarFicha()
    expect(revisao).toBeGreaterThan(0)

    // Só a posição muda, como num arraste no mapa.
    const { change } = putDocument(database, { id: "token-jogador", type: "token", parentId: "cena", data: { name: "Jogador 1", playerSlotId: "player-1", actor, x: 320, y: 180 } })
    transmission.onDocumentChange(change)

    const depois = database.get("seat-character-player-1")?.data as { revision: number }
    expect(depois.revision).toBe(revisao)
  })

  it("mas uma alteração de verdade na ficha continua chegando ao jogador", () => {
    const { database, revisao } = anexarFicha()
    const editado = { envelope: { version: 23, character: { name: "Jogador 1 (ferido)" } }, summary: { name: "Jogador 1", bars: [] }, source: "tools", tokenImage: null, tokenSize: 1 }
    const { change } = putDocument(database, { id: "token-jogador", type: "token", parentId: "cena", data: { name: "Jogador 1", playerSlotId: "player-1", actor: editado, x: 320, y: 180 } })
    transmission.onDocumentChange(change)

    const depois = database.get("seat-character-player-1")?.data as { revision: number }
    expect(depois.revision).toBe(revisao + 1)
  })

  const base = {
    slotId: "player-1",
    tokenId: "token-1",
    sceneId: "cena-1",
    envelope: { version: 23, character: { name: "Jogador 1" } },
    summary: { name: "Jogador 1", bars: [{ label: "PV", value: 10, max: 10 }] },
    tokenImage: null,
    tokenSize: 1,
    revision: 4,
    updatedAt: 1000,
    mutationId: "abc",
  }

  it("ignora revisão, horário e mutação: eles mudam a cada gravação", () => {
    expect(sameSeatCharacter(base, { ...base, revision: 99, updatedAt: 5000, mutationId: "outro" })).toBe(true)
  })

  it("reconhece o que pertence de fato à ficha", () => {
    expect(sameSeatCharacter(base, { ...base, envelope: { version: 23, character: { name: "Outro" } } })).toBe(false)
    expect(sameSeatCharacter(base, { ...base, summary: { name: "Jogador 1", bars: [{ label: "PV", value: 3, max: 10 }] } })).toBe(false)
    expect(sameSeatCharacter(base, { ...base, tokenSize: 2 })).toBe(false)
    expect(sameSeatCharacter(base, { ...base, sceneId: "cena-2" })).toBe(false)
    expect(sameSeatCharacter(base, { ...base, tokenId: "token-2" })).toBe(false)
    expect(sameSeatCharacter(base, { ...base, tokenImage: "data:image/png;base64,AA" })).toBe(false)
  })
})
