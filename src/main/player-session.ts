import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"

/** O limite deliberado da primeira versão do fluxo de assentos. */
export const MIN_PLAYER_SEATS = 1
export const MAX_PLAYER_SEATS = 12

const CODE_BYTES = 8
const TOKEN_BYTES = 32
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

export type PlayerSeatStatus = "available" | "connected" | "attached"

/** Estado privado mantido somente enquanto a transmissão está ligada. */
export interface PlayerSeat {
  slotId: string
  label: string
  codeHash: string
  sessionCookieHash: string | null
  tokenId: string | null
  status: PlayerSeatStatus
  revision: number
  lastSeenAt: number | null
}

export interface PlayerSeatSnapshot {
  slotId: string
  label: string
  status: PlayerSeatStatus
  tokenId: string | null
  revision: number
  lastSeenAt: number | null
}

export interface PlayerSessionSnapshot {
  id: string
  seats: PlayerSeatSnapshot[]
}

export interface CreatedPlayerSession {
  session: PlayerSession
  /** Códigos em texto puro, entregues somente ao mestre no momento da criação. */
  codes: Record<string, string>
}

function randomCode(): string {
  const bytes = randomBytes(CODE_BYTES)
  let code = ""
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length]
  return code
}

function normalizeSecret(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "")
}

/** Aceita `ABCD-EFGH` no lobby e mantém a comparação independente de caixa. */
export function normalizePlayerCode(value: unknown): string | null {
  if (typeof value !== "string") return null
  const normalized = normalizeSecret(value)
  return normalized.length >= 8 ? normalized : null
}

export function hashPlayerSecret(value: string): string {
  return createHash("sha256").update(normalizeSecret(value), "utf8").digest("hex")
}

function matchesSecret(hash: string, value: string): boolean {
  const expected = Buffer.from(hash, "hex")
  const actual = Buffer.from(hashPlayerSecret(value), "hex")
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export function normalizeSeatCount(value: number): number {
  if (!Number.isInteger(value) || value < MIN_PLAYER_SEATS || value > MAX_PLAYER_SEATS) {
    throw new Error(`A sessão precisa ter entre ${MIN_PLAYER_SEATS} e ${MAX_PLAYER_SEATS} jogadores.`)
  }
  return value
}

function seatLabel(index: number): string {
  return `Jogador ${index + 1}`
}

/**
 * Sessão efêmera de jogadores. Ela não conhece o mundo nem o WebSocket: essa
 * separação permite testar autenticação e revogação sem abrir uma porta.
 * Códigos e cookies nunca são persistidos no `world.db`.
 */
export class PlayerSession {
  readonly id: string
  private readonly seatsById = new Map<string, PlayerSeat>()

  private constructor(id: string, seats: PlayerSeat[]) {
    this.id = id
    for (const seat of seats) this.seatsById.set(seat.slotId, seat)
  }

  static create(count: number): CreatedPlayerSession {
    const seatCount = normalizeSeatCount(count)
    const codes: Record<string, string> = {}
    const seats: PlayerSeat[] = []
    for (let index = 0; index < seatCount; index += 1) {
      const slotId = `player-${index + 1}`
      const code = randomCode()
      codes[slotId] = code
      seats.push({
        slotId,
        label: seatLabel(index),
        codeHash: hashPlayerSecret(code),
        sessionCookieHash: null,
        tokenId: null,
        status: "available",
        revision: 0,
        lastSeenAt: null,
      })
    }
    return { session: new PlayerSession(randomUUID(), seats), codes }
  }

  get seatCount(): number { return this.seatsById.size }

  getSeat(slotId: string): PlayerSeat | null {
    return this.seatsById.get(slotId) ?? null
  }

  list(): PlayerSeat[] {
    return [...this.seatsById.values()].map((seat) => ({ ...seat }))
  }

  snapshot(): PlayerSessionSnapshot {
    return {
      id: this.id,
      seats: this.list().map(({ slotId, label, status, tokenId, revision, lastSeenAt }) => ({ slotId, label, status, tokenId, revision, lastSeenAt })),
    }
  }

  authenticateCode(value: unknown): PlayerSeat | null {
    const code = normalizePlayerCode(value)
    if (!code) return null
    for (const seat of this.seatsById.values()) {
      if (matchesSecret(seat.codeHash, code)) return { ...seat }
    }
    return null
  }

  rotateCode(slotId: string): string {
    const seat = this.requireSeat(slotId)
    const code = randomCode()
    seat.codeHash = hashPlayerSecret(code)
    seat.sessionCookieHash = null
    seat.status = seat.tokenId ? "attached" : "available"
    seat.lastSeenAt = null
    return code
  }

  issueAccessToken(slotId: string): string {
    const seat = this.requireSeat(slotId)
    const token = randomBytes(TOKEN_BYTES).toString("hex")
    seat.sessionCookieHash = hashPlayerSecret(token)
    seat.status = "connected"
    seat.lastSeenAt = Date.now()
    return token
  }

  authenticateAccessToken(value: unknown): PlayerSeat | null {
    if (typeof value !== "string" || value.length < 32) return null
    for (const seat of this.seatsById.values()) {
      if (seat.sessionCookieHash && matchesSecret(seat.sessionCookieHash, value)) {
        seat.lastSeenAt = Date.now()
        return { ...seat }
      }
    }
    return null
  }

  markAttached(slotId: string, tokenId: string | null): void {
    const seat = this.requireSeat(slotId)
    seat.tokenId = tokenId
    seat.status = tokenId ? "attached" : seat.sessionCookieHash ? "connected" : "available"
    seat.revision += 1
  }

  clearSeat(slotId: string): void {
    const seat = this.requireSeat(slotId)
    seat.sessionCookieHash = null
    seat.tokenId = null
    seat.status = "available"
    seat.revision = 0
    seat.lastSeenAt = null
  }

  revoke(slotId: string): void {
    const seat = this.requireSeat(slotId)
    seat.sessionCookieHash = null
    seat.status = seat.tokenId ? "attached" : "available"
    seat.lastSeenAt = null
  }

  bumpRevision(slotId: string): number {
    const seat = this.requireSeat(slotId)
    seat.revision += 1
    return seat.revision
  }

  private requireSeat(slotId: string): PlayerSeat {
    const seat = this.seatsById.get(slotId)
    if (!seat) throw new Error("Assento de jogador não encontrado.")
    return seat
  }
}
