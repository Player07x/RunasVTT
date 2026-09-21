import { describe, expect, it } from "vitest"
import { MAX_PLAYER_SEATS, MIN_PLAYER_SEATS, PlayerSession, normalizePlayerCode, normalizeSeatCount } from "../src/main/player-session"

describe("sessão de jogadores", () => {
  it("cria de 1 a 12 assentos e entrega códigos únicos ao mestre", () => {
    const created = PlayerSession.create(3)
    expect(created.session.seatCount).toBe(3)
    expect(Object.keys(created.codes)).toEqual(["player-1", "player-2", "player-3"])
    expect(new Set(Object.values(created.codes)).size).toBe(3)
    expect(created.session.snapshot().seats.every((seat) => !Object.hasOwn(seat, "code"))).toBe(true)
  })

  it("rejeita quantidades fora do limite", () => {
    expect(() => normalizeSeatCount(MIN_PLAYER_SEATS - 1)).toThrow()
    expect(() => normalizeSeatCount(MAX_PLAYER_SEATS + 1)).toThrow()
    expect(() => PlayerSession.create(1.5)).toThrow()
  })

  it("autentica código com caixa, espaços e hífen, sem aceitar valor curto", () => {
    const { session, codes } = PlayerSession.create(1)
    const code = codes["player-1"]!
    expect(normalizePlayerCode(` ${code.slice(0, 4)}-${code.slice(4)} `)).toBe(code)
    expect(session.authenticateCode(` ${code.slice(0, 4)}-${code.slice(4)} `)?.slotId).toBe("player-1")
    expect(session.authenticateCode(code.slice(0, 7))).toBeNull()
    expect(session.authenticateCode("AAAAAAAA")).toBeNull()
  })

  it("emite token efêmero, permite revogar e limpa o assento", () => {
    const { session, codes } = PlayerSession.create(1)
    const slotId = "player-1"
    const token = session.issueAccessToken(slotId)
    expect(session.authenticateAccessToken(token)?.slotId).toBe(slotId)
    expect(session.snapshot().seats[0]!.status).toBe("connected")
    session.revoke(slotId)
    expect(session.authenticateAccessToken(token)).toBeNull()

    const nextCode = session.rotateCode(slotId)
    expect(nextCode).not.toBe(codes[slotId])
    expect(session.authenticateCode(codes[slotId])).toBeNull()
    expect(session.authenticateCode(nextCode)?.slotId).toBe(slotId)

    session.markAttached(slotId, "token-1")
    expect(session.snapshot().seats[0]!.status).toBe("attached")
    session.clearSeat(slotId)
    expect(session.snapshot().seats[0]!).toMatchObject({ status: "available", tokenId: null, revision: 0, lastSeenAt: null })
  })

  it("mantém revisão monotônica e não expõe hashes", () => {
    const { session } = PlayerSession.create(1)
    expect(session.snapshot().seats[0]!).not.toHaveProperty("codeHash")
    expect(session.snapshot().seats[0]!.revision).toBe(0)
    expect(session.bumpRevision("player-1")).toBe(1)
    expect(session.bumpRevision("player-1")).toBe(2)
  })
})
