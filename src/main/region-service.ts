import { snapTokenCenter } from "../shared/grid"
import type { DocumentChange } from "../shared/ipc"
import { regionCenter, regionContains, triggersRegion, type RegionData } from "../shared/region"
import type { SceneData, TokenData } from "../shared/scene"
import type { WorldDocument } from "../shared/world"
import { postLog } from "./bridge-service"
import type { WorldDatabase } from "./world-database"
import { putDocument } from "./world-documents"

/**
 * Gatilhos das regiões (Fase 8). Guarda em que regiões cada token está e,
 * quando ele entra numa região ativa, dispara texto e teleporte. Tokens
 * recém-criados e regiões desenhadas por cima de tokens não disparam nada.
 */
export class RegionService {
  /** Token → regiões em que o centro dele está. */
  private readonly inside = new Map<string, Set<string>>()
  /** Tokens que acabaram de ser teleportados: a chegada não dispara o destino. */
  private readonly arrived = new Set<string>()
  private loaded = false

  constructor(private readonly database: () => WorldDatabase | null, private readonly publish: (changes: DocumentChange[]) => void) {}

  clear(): void {
    this.inside.clear()
    this.arrived.clear()
    this.loaded = false
  }

  onDocumentChange(change: DocumentChange): void {
    const database = this.database()
    if (!database) return
    if (!this.loaded) this.load(database)
    if (change.kind === "delete") {
      const removed = new Set(change.ids)
      for (const id of change.ids) this.inside.delete(id)
      for (const regions of this.inside.values()) for (const id of regions) if (removed.has(id)) regions.delete(id)
      return
    }
    const { document } = change
    if (document.type === "token") this.onToken(database, document as WorldDocument<TokenData>)
    else if (document.type === "region" && document.parentId) this.recompute(database, document.parentId)
  }

  /** Estado inicial sem disparar: onde cada token está agora. */
  private load(database: WorldDatabase): void {
    this.loaded = true
    for (const scene of database.list("scene", null)) this.recompute(database, scene.id)
  }

  private recompute(database: WorldDatabase, sceneId: string): void {
    const regions = this.regions(database, sceneId)
    for (const token of database.list("token", sceneId) as WorldDocument<TokenData>[]) this.inside.set(token.id, this.containing(regions, token.data))
  }

  private onToken(database: WorldDatabase, token: WorldDocument<TokenData>): void {
    if (!token.parentId) return
    const regions = this.regions(database, token.parentId)
    const now = this.containing(regions, token.data)
    const before = this.inside.get(token.id)
    this.inside.set(token.id, now)
    if (!before || this.arrived.delete(token.id)) return
    for (const region of regions) {
      if (!now.has(region.id) || before.has(region.id)) continue
      const data = region.data
      if (!data.enabled || !triggersRegion(data, token.data.disposition)) continue
      if (data.text.enabled && data.text.message.trim()) this.showText(database, token, region)
      if (data.teleport.enabled && this.teleport(database, token, region)) return
    }
  }

  private showText(database: WorldDatabase, token: WorldDocument<TokenData>, region: WorldDocument<RegionData>): void {
    const message = region.data.text.message.trim()
    const changes = postLog(database, { sceneId: token.parentId, selection: [], center: null }, { kind: "info", title: region.data.name, detail: message, tokenId: token.id, floatingText: message.slice(0, 40) })
    // "Só uma vez": depois de disparar, o texto se desliga sozinho.
    if (region.data.text.once) changes.push(putDocument(database, { id: region.id, type: "region", parentId: region.parentId, data: { ...region.data, text: { ...region.data.text, enabled: false } } }).change)
    this.publish(changes)
  }

  /** Leva o token ao centro da região de destino (mesma cena ou outra). */
  private teleport(database: WorldDatabase, token: WorldDocument<TokenData>, source: WorldDocument<RegionData>): boolean {
    const targetId = source.data.teleport.regionId
    const target = targetId ? database.get(targetId) : null
    if (!target || target.type !== "region" || !target.parentId || target.id === source.id) return false
    const scene = database.get(target.parentId)
    if (!scene || scene.type !== "scene") return false
    const destination = snapTokenCenter(regionCenter(target.data as RegionData), token.data.size, (scene.data as SceneData).grid)
    this.arrived.add(token.id)
    this.publish([putDocument(database, { id: token.id, type: "token", parentId: scene.id, data: { ...token.data, ...destination } }).change])
    return true
  }

  private regions(database: WorldDatabase, sceneId: string): WorldDocument<RegionData>[] {
    return database.list("region", sceneId) as WorldDocument<RegionData>[]
  }

  private containing(regions: WorldDocument<RegionData>[], token: TokenData): Set<string> {
    return new Set(regions.filter((region) => regionContains(region.data, token)).map((region) => region.id))
  }
}
