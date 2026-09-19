import { snapTokenCenter } from "../shared/grid"
import type { SceneData, TokenData, WallData } from "../shared/scene"
import { lineBlocked, sightSegments } from "../shared/vision"
import type { WorldDocument } from "../shared/world"
import type { WorldDatabase } from "./world-database"

/** Pedido de um espectador para mover um token "Jogador". */
export interface MoveRequest {
  tokenId: string
  x: number
  y: number
}

export type MoveResult = { ok: true; token: WorldDocument<TokenData> } | { ok: false; reason: string }

/** Aceita só `{ type: "move", tokenId, x, y }` com valores sãos; o resto é ignorado. */
export function normalizeMoveRequest(value: unknown): MoveRequest | null {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : null
  if (!raw || raw.type !== "move") return null
  if (typeof raw.tokenId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(raw.tokenId)) return null
  if (typeof raw.x !== "number" || typeof raw.y !== "number" || !Number.isFinite(raw.x) || !Number.isFinite(raw.y)) return null
  return { tokenId: raw.tokenId, x: raw.x, y: raw.y }
}

/**
 * Valida o movimento pedido pela Vista dos Jogadores (ADR 0017). O VTT é a
 * fonte da verdade: o destino é encaixado aqui, e o espectador não atravessa
 * paredes nem portas fechadas (o que também o impediria de explorar a névoa).
 */
export function validatePlayerMove(database: WorldDatabase, sceneId: string | null, request: MoveRequest): MoveResult {
  const document = database.get(request.tokenId)
  if (!sceneId || !document || document.type !== "token" || document.parentId !== sceneId) return { ok: false, reason: "Este token não está na cena transmitida." }
  const token = document as WorldDocument<TokenData>
  if (token.data.disposition !== "player" || token.data.hidden) return { ok: false, reason: "Só tokens de Jogador podem ser movidos." }
  if (token.data.locked) return { ok: false, reason: "O mestre travou este token." }
  const scene = database.get(sceneId)
  if (!scene || scene.type !== "scene") return { ok: false, reason: "Cena não encontrada." }
  const data = scene.data as SceneData
  if (request.x < 0 || request.y < 0 || request.x > data.width || request.y > data.height) return { ok: false, reason: "O destino fica fora do mapa." }
  const destination = snapTokenCenter({ x: request.x, y: request.y }, token.data.size, data.grid)
  const walls = sightSegments((database.list("wall", sceneId) as WorldDocument<WallData>[]).map((wall) => wall.data))
  if (lineBlocked(token.data, destination, walls)) return { ok: false, reason: "Uma parede ou porta fechada bloqueia o caminho." }
  return { ok: true, token: { ...token, data: { ...token.data, x: destination.x, y: destination.y } } }
}
