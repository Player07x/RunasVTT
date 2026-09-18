import type { PlayerBarVisibility } from "./ipc"
import type { NoteData, SceneData, TileData, TokenData, DrawingData, AssetPath } from "./scene"
import { isAssetPath } from "./scene"
import type { WorldDocument } from "./world"

/** Formato sanitizado que atravessa a rede. */
export interface PlayerScene { id: string; data: SceneData }
export interface PlayerTokenData extends Omit<TokenData, "actor" | "bars"> { bars: TokenData["bars"] }
export interface PlayerNoteData extends Omit<NoteData, "url"> {}
export type PlayerChild =
  | { id: string; type: "token"; parentId: string; sort: number; data: PlayerTokenData }
  | { id: string; type: "tile"; parentId: string; sort: number; data: TileData }
  | { id: string; type: "drawing"; parentId: string; sort: number; data: DrawingData }
  | { id: string; type: "note"; parentId: string; sort: number; data: PlayerNoteData }
export interface PlayerProjection { scene: PlayerScene | null; children: PlayerChild[]; assets: AssetPath[] }
export interface ProjectionInput {
  scene: WorldDocument<SceneData> | null
  children: { tokens: WorldDocument<TokenData>[]; tiles: WorldDocument<TileData>[]; drawings: WorldDocument<DrawingData>[]; notes: WorldDocument<NoteData>[] }
  bars: PlayerBarVisibility
}

function visible<T extends WorldDocument>(document: T): boolean { return !(document.data as { hidden?: boolean }).hidden }
function asset(value: string | null): AssetPath | null { return isAssetPath(value) ? value : null }

/** Remove explicitamente os campos privados antes de serializar a projeção. */
export function projectScene(input: ProjectionInput): PlayerProjection {
  if (!input.scene) return { scene: null, children: [], assets: [] }
  const scene: PlayerScene = { id: input.scene.id, data: structuredClone(input.scene.data) }
  const children: PlayerChild[] = []
  const assets = new Set<AssetPath>()
  const background = asset(scene.data.background)
  if (background) assets.add(background)
  for (const document of input.children.tiles) {
    if (!visible(document)) continue
    const data = structuredClone(document.data)
    if (data.image) assets.add(data.image)
    children.push({ id: document.id, type: "tile", parentId: input.scene.id, sort: document.sort, data })
  }
  for (const document of input.children.drawings) {
    if (!visible(document)) continue
    children.push({ id: document.id, type: "drawing", parentId: input.scene.id, sort: document.sort, data: structuredClone(document.data) })
  }
  for (const document of input.children.tokens) {
    if (!visible(document)) continue
    const { actor: _actor, bars, ...withoutActor } = structuredClone(document.data)
    const visibleBars = input.bars === "all" || (input.bars === "friendly" && document.data.disposition === "friendly") ? bars : []
    if (withoutActor.image) assets.add(withoutActor.image)
    children.push({ id: document.id, type: "token", parentId: input.scene.id, sort: document.sort, data: { ...withoutActor, bars: visibleBars } })
  }
  for (const document of input.children.notes) {
    if (!visible(document)) continue
    const { url: _url, ...withoutUrl } = structuredClone(document.data)
    children.push({ id: document.id, type: "note", parentId: input.scene.id, sort: document.sort, data: withoutUrl })
  }
  return { scene, children, assets: [...assets] }
}
