import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { AudioService } from "../src/main/audio-service"
import { assetResponse, parseRange } from "../src/main/world-assets"
import { WorldDatabase } from "../src/main/world-database"
import { putDocument } from "../src/main/world-documents"
import { mixedVolume, playbackOffset, type AudioState } from "../src/shared/audio"

const audio = (letter: string) => `audio/${letter.repeat(64)}.mp3`

let dir: string
let database: WorldDatabase
let service: AudioService
let clock: number
let emitted: AudioState[]

const put = (input: Parameters<typeof putDocument>[1]) => service.onDocumentChange(putDocument(database, input).change)
const keys = () => service.get().sounds.map((sound) => sound.trackId ?? sound.key)

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "runas-vtt-audio-"))
  database = new WorldDatabase(join(dir, "world.db"))
  clock = 1000
  emitted = []
  service = new AudioService(() => database, () => "cena", (state) => emitted.push(state), () => clock)
  put({ id: "cena", type: "scene", parentId: null, data: { name: "Taverna", width: 1000, height: 600 } })
  put({ id: "musica", type: "playlist", parentId: null, data: { name: "Taverna", channel: "music", repeat: false } })
  put({ id: "f1", type: "track", parentId: "musica", sort: 1, data: { name: "Abertura", audio: audio("a") } })
  put({ id: "f2", type: "track", parentId: "musica", sort: 2, data: { name: "Brinde", audio: audio("b") } })
  put({ id: "efeitos", type: "playlist", parentId: null, data: { name: "Efeitos", channel: "effects", mode: "soundboard" } })
  put({ id: "trovao", type: "track", parentId: "efeitos", data: { name: "Trovão", audio: audio("c") } })
})

afterEach(async () => {
  database.close()
  await rm(dir, { recursive: true, force: true })
})

describe("playlists", () => {
  it("tocam em sequência e param no fim sem repetição", () => {
    service.playPlaylist("musica")
    expect(keys()).toEqual(["f1"])
    const first = service.get().sounds[0]!
    expect(first).toMatchObject({ channel: "music", loop: false, startedAt: 1000, label: "Taverna · Abertura" })
    clock = 5000
    service.ended(first.key)
    expect(keys()).toEqual(["f2"])
    service.ended(service.get().sounds[0]!.key)
    expect(keys()).toEqual([])
  })

  it("recomeçam com repetição e ignoram o aviso de uma instância antiga", () => {
    put({ id: "musica", type: "playlist", parentId: null, data: { name: "Taverna", channel: "music", repeat: true } })
    service.playPlaylist("musica")
    const first = service.get().sounds[0]!.key
    service.ended(first)
    service.ended(first)
    expect(keys()).toEqual(["f2"])
    service.ended(service.get().sounds[0]!.key)
    expect(keys()).toEqual(["f1"])
  })

  it("a mesa de sons toca cada clique como um som novo, sobrepostos", () => {
    service.playTrack("trovao")
    service.playTrack("trovao")
    const sounds = service.get().sounds
    expect(sounds).toHaveLength(2)
    expect(new Set(sounds.map((sound) => sound.key)).size).toBe(2)
    expect(sounds[0]!.channel).toBe("effects")
    service.stopPlaylist("efeitos")
    expect(keys()).toEqual([])
  })

  it("apagar a faixa que toca para o som", () => {
    service.playPlaylist("musica")
    database.delete("f1")
    service.onDocumentChange({ kind: "delete", ids: ["f1"] })
    expect(keys()).toEqual([])
  })

  it("avisa a interface só quando o estado muda", () => {
    const before = emitted.length
    service.refresh()
    expect(emitted.length).toBe(before)
    service.playPlaylist("musica")
    expect(emitted.length).toBe(before + 1)
  })
})

describe("sons do mapa", () => {
  beforeEach(() => {
    put({ id: "fogueira", type: "sound", parentId: "cena", data: { x: 500, y: 300, radius: 3, audio: audio("d"), volume: 1 } })
  })

  it("tocam mais alto quanto mais perto o aliado está", () => {
    put({ id: "heroi", type: "token", parentId: "cena", data: { x: 650, y: 300, disposition: "friendly" } })
    const sound = service.get().sounds[0]!
    expect(sound).toMatchObject({ key: "snd:fogueira", channel: "ambient", loop: true, volume: 0.5 })
    put({ id: "heroi", type: "token", parentId: "cena", data: { x: 900, y: 300, disposition: "friendly" } })
    expect(service.get().sounds).toEqual([])
  })

  it("inimigos não ouvem, e a parede abafa", () => {
    put({ id: "orc", type: "token", parentId: "cena", data: { x: 550, y: 300, disposition: "hostile" } })
    expect(service.get().sounds).toEqual([])
    put({ id: "heroi", type: "token", parentId: "cena", data: { x: 650, y: 300, disposition: "friendly" } })
    put({ id: "parede", type: "wall", parentId: "cena", data: { x1: 600, y1: 0, x2: 600, y2: 600 } })
    expect(service.get().sounds).toEqual([])
    put({ id: "parede", type: "wall", parentId: "cena", data: { x1: 600, y1: 0, x2: 600, y2: 600, kind: "door", open: true } })
    expect(service.get().sounds).toHaveLength(1)
  })
})

describe("reprodução sincronizada", () => {
  it("calcula o ponto da faixa compensando o relógio de quem ouve", () => {
    // O jogador está 2 s adiantado; a faixa começou há 10 s no VTT.
    expect(playbackOffset({ startedAt: 0, loop: false }, 12_000, 2_000, 60)).toBe(10)
    expect(playbackOffset({ startedAt: 0, loop: true }, 70_000, 0, 60)).toBe(10)
    expect(playbackOffset({ startedAt: 0, loop: false }, 70_000, 0, 60)).toBeNull()
  })

  it("combina o volume do som com o do canal e o geral", () => {
    expect(mixedVolume({ volume: 0.5, channel: "music" }, { master: 0.5, music: 0.8, ambient: 1, effects: 1 })).toBeCloseTo(0.2)
  })
})

describe("Range nos assets", () => {
  it("interpreta os formatos de Range", () => {
    expect(parseRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 })
    expect(parseRange("bytes=900-", 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange("bytes=2000-", 1000)).toBeNull()
    expect(parseRange("itens=0-1", 1000)).toBeNull()
  })

  it("atende uma Range aberta até o fim, por maior que seja o arquivo", () => {
    // Um teto por requisição encerra a mídia com `error` ao chegar no limite:
    // uma música de 1 h morria em ~4 min quando o trecho era de 4 MB.
    const size = 64 * 1024 * 1024
    expect(parseRange("bytes=0-", size)).toEqual({ start: 0, end: size - 1 })
    expect(parseRange("bytes=8388608-", size)).toEqual({ start: 8_388_608, end: size - 1 })
  })

  it("responde 206 com o trecho pedido", async () => {
    const path = audio("e")
    await writeFile(join(dir, "dummy"), "")
    const { mkdir } = await import("node:fs/promises")
    await mkdir(join(dir, "assets", "audio"), { recursive: true })
    await writeFile(join(dir, "assets", path), Buffer.from("0123456789"))
    const response = await assetResponse(dir, path, "bytes=2-5")
    expect(response.status).toBe(206)
    expect(response.headers.get("content-range")).toBe("bytes 2-5/10")
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("2345")
    expect((await assetResponse(dir, path)).headers.get("accept-ranges")).toBe("bytes")
  })
})
