import { describe, expect, it } from "vitest"
import { WORLD_FORMAT_VERSION, createWorldManifest, parseWorldManifest, worldFolderName } from "../src/shared/world"

describe("formato do mundo", () => {
  it("cria um manifesto normalizado", () => {
    const manifest = createWorldManifest({ title: "  Crônicas   de Ordem  " }, "abc", 100)
    expect(manifest).toEqual({ formatVersion: WORLD_FORMAT_VERSION, id: "abc", title: "Crônicas de Ordem", description: "", rulesetId: "runas-blue", createdAt: 100, updatedAt: 100 })
  })

  it("recusa mundo sem nome", () => {
    expect(() => createWorldManifest({ title: "   " }, "abc", 1)).toThrow()
  })

  it("gera nome de pasta seguro e único", () => {
    expect(worldFolderName("Crônicas: Ordem/Caos?", "0123456789ab")).toBe("cronicas-ordem-caos-01234567")
    expect(worldFolderName("???", "0123456789ab")).toBe("mundo-01234567")
  })

  it("recusa manifesto de versão futura em vez de arriscar corromper o mundo", () => {
    expect(() => parseWorldManifest({ formatVersion: WORLD_FORMAT_VERSION + 1, id: "x", title: "X" })).toThrow(/Atualize o RunasVTT/)
  })

  it("completa campos ausentes de um manifesto válido", () => {
    const manifest = parseWorldManifest({ formatVersion: 1, id: "x", title: "", rulesetId: "desconhecido", createdAt: 5 })
    expect(manifest.title).toBe("Mundo sem nome")
    expect(manifest.rulesetId).toBe("runas-blue")
    expect(manifest.updatedAt).toBe(5)
  })
})
