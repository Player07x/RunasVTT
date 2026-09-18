import type { DocumentChange } from "../shared/ipc"
import { normalizeFog, type FogData, type LightData, type SceneData, type TokenData, type WallData } from "../shared/scene"
import { computeVision, fogLayout, mergeExplored, visibleCells, type SceneVision } from "../shared/vision"
import type { WorldDocument } from "../shared/world"
import type { WorldDatabase } from "./world-database"

export interface SceneVisionState {
  vision: SceneVision
  /** Áreas exploradas; `null` com a névoa ou a exploração desligadas. */
  fog: FogData | null
}

const VISION_TYPES = new Set(["scene", "token", "wall", "light"])
const fogId = (sceneId: string) => `fog-${sceneId}`

/**
 * Visão de cada cena, calculada no processo principal. A exploração acumula
 * a cada mudança de token, parede, luz ou cena, com ou sem transmissão, e
 * fica gravada no mundo (documento `fog`, filho da cena).
 */
export class VisionService {
  private readonly cache = new Map<string, SceneVisionState>()

  constructor(private readonly database: () => WorldDatabase | null) {}

  onDocumentChange(change: DocumentChange): void {
    if (change.kind === "delete") { this.cache.clear(); return }
    const { document } = change
    if (!VISION_TYPES.has(document.type)) return
    const sceneId = document.type === "scene" ? document.id : document.parentId
    if (!sceneId) return
    this.cache.delete(sceneId)
    this.get(sceneId)
  }

  /** Visão atual da cena (calculada na hora se preciso). */
  get(sceneId: string): SceneVisionState | null {
    const cached = this.cache.get(sceneId)
    if (cached) return cached
    const database = this.database()
    const scene = database?.get(sceneId)
    if (!database || !scene || scene.type !== "scene") return null
    const data = scene.data as SceneData
    const tokens = (database.list("token", sceneId) as WorldDocument<TokenData>[]).map((token) => ({ id: token.id, data: token.data }))
    const walls = (database.list("wall", sceneId) as WorldDocument<WallData>[]).map((wall) => wall.data)
    const lights = (database.list("light", sceneId) as WorldDocument<LightData>[]).map((light) => light.data)
    const vision = computeVision(data, tokens, walls, lights)
    let fog: FogData | null = null
    if (data.vision.enabled && data.vision.exploration) {
      const stored = database.get(fogId(sceneId))
      const layout = fogLayout(data)
      const merged = mergeExplored(stored ? normalizeFog(stored.data) : null, layout, visibleCells(vision, layout))
      fog = merged.fog
      if (merged.changed) this.writeFog(database, sceneId, fog, stored?.createdAt)
    }
    const state = { vision, fog }
    this.cache.set(sceneId, state)
    return state
  }

  /** Apaga as áreas exploradas; o que está visível agora volta a contar. */
  resetExploration(sceneId: string): void {
    const database = this.database()
    if (!database) return
    database.delete(fogId(sceneId))
    this.cache.delete(sceneId)
  }

  clear(): void {
    this.cache.clear()
  }

  private writeFog(database: WorldDatabase, sceneId: string, fog: FogData, createdAt?: number): void {
    const now = Date.now()
    database.put({ id: fogId(sceneId), type: "fog", parentId: sceneId, sort: 0, data: fog, createdAt: createdAt ?? now, updatedAt: now })
  }
}
