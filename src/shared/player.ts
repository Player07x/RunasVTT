import type { PlayerBarVisibility } from "./ipc"
import type { NoteData, SceneData, TileData, TokenData, DrawingData, AssetPath } from "./scene"
import { isAssetPath } from "./scene"
import type { LogKind } from "./bridge"
import type { WorldDocument } from "./world"
import { cellPixels, isTokenVisible, renderVision, type RenderVision, type SceneVision } from "./vision"
import type { FogData } from "./scene"
import type { AudioState } from "./audio"
import type { PlayerRegion, RegionData } from "./region"

/** Formato sanitizado que atravessa a rede. */
export interface PlayerScene { id: string; data: SceneData }
export interface PlayerTokenData extends Omit<TokenData, "actor" | "bars" | "vision" | "light"> { bars: TokenData["bars"] }
export interface PlayerNoteData extends Omit<NoteData, "url"> {}
export type PlayerChild =
  | { id: string; type: "token"; parentId: string; sort: number; data: PlayerTokenData }
  | { id: string; type: "tile"; parentId: string; sort: number; data: TileData }
  | { id: string; type: "drawing"; parentId: string; sort: number; data: DrawingData }
  | { id: string; type: "note"; parentId: string; sort: number; data: PlayerNoteData }
export interface PlayerProjection {
  scene: PlayerScene | null
  children: PlayerChild[]
  assets: AssetPath[]
  /** Escuridão, luzes e névoa já calculadas; paredes nunca saem do VTT. */
  vision: RenderVision | null
  /** Regiões marcadas como visíveis: só forma, cor e terreno (sem gatilhos nem destinos). */
  regions: PlayerRegion[]
}

/** Régua em coordenadas da cena. */
export interface PlayerRuler { sceneId: string; from: { x: number; y: number }; to: { x: number; y: number } }

/**
 * Mensagens do servidor para a página dos jogadores. A câmera dos jogadores é
 * deles: só muda quando o mestre usa "Puxar a câmera" (`camera`).
 */
export type PlayerWireMessage =
  | { type: "snapshot"; projection: PlayerProjection; ruler: PlayerRuler | null; audio: AudioState | null }
  /** O que está tocando; `null` com o áudio desligado para os jogadores. */
  | { type: "audio"; audio: AudioState | null }
  | { type: "camera"; center: { x: number; y: number }; zoom: number | null }
  | { type: "ruler"; ruler: PlayerRuler | null }
  /** Texto flutuante de dano, cura ou teste sobre um token visível aos jogadores. */
  | { type: "float"; tokenId: string; text: string; kind: LogKind }
  | { type: "pong" }

const COORDINATE_LIMIT = 1_000_000

function point(value: unknown): { x: number; y: number } | null {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : null
  if (!raw || typeof raw.x !== "number" || typeof raw.y !== "number" || !Number.isFinite(raw.x) || !Number.isFinite(raw.y)) return null
  if (Math.abs(raw.x) > COORDINATE_LIMIT || Math.abs(raw.y) > COORDINATE_LIMIT) return null
  return { x: raw.x, y: raw.y }
}

/** Valida a régua vinda da interface antes de ela atravessar a rede. */
export function normalizeRuler(value: unknown): PlayerRuler | null {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : null
  if (!raw || typeof raw.sceneId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(raw.sceneId)) return null
  const from = point(raw.from)
  const to = point(raw.to)
  return from && to ? { sceneId: raw.sceneId, from, to } : null
}
export interface ProjectionInput {
  scene: WorldDocument<SceneData> | null
  children: { tokens: WorldDocument<TokenData>[]; tiles: WorldDocument<TileData>[]; drawings: WorldDocument<DrawingData>[]; notes: WorldDocument<NoteData>[]; regions?: WorldDocument<RegionData>[] }
  bars: PlayerBarVisibility
  /** Visão calculada pelo processo principal (Fase 6). */
  vision?: { vision: SceneVision; fog: FogData | null } | null
}

function visible<T extends WorldDocument>(document: T): boolean { return !(document.data as { hidden?: boolean }).hidden }
function asset(value: string | null): AssetPath | null { return isAssetPath(value) ? value : null }

/** Remove explicitamente os campos privados antes de serializar a projeção. */
export function projectScene(input: ProjectionInput): PlayerProjection {
  if (!input.scene) return { scene: null, children: [], assets: [], vision: null, regions: [] }
  const sight = input.vision?.vision ?? null
  const cell = cellPixels(input.scene.data)
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
    // Com névoa, tokens fora da visão dos aliados nem saem do VTT.
    if (sight && !isTokenVisible(sight, document.id, document.data, cell)) continue
    const { actor: _actor, bars, vision: _vision, light: _light, ...withoutActor } = structuredClone(document.data)
    const visibleBars = input.bars === "all" || (input.bars === "friendly" && document.data.disposition === "friendly") ? bars : []
    if (withoutActor.image) assets.add(withoutActor.image)
    children.push({ id: document.id, type: "token", parentId: input.scene.id, sort: document.sort, data: { ...withoutActor, bars: visibleBars } })
  }
  for (const document of input.children.notes) {
    if (!visible(document)) continue
    const { url: _url, ...withoutUrl } = structuredClone(document.data)
    children.push({ id: document.id, type: "note", parentId: input.scene.id, sort: document.sort, data: withoutUrl })
  }
  const regions: PlayerRegion[] = (input.children.regions ?? []).filter((region) => region.data.visible).map(({ id, data }) => ({
    id, shape: data.shape, x: data.x, y: data.y, width: data.width, height: data.height, color: data.color,
    terrain: data.terrain.enabled ? data.terrain.multiplier : 1,
  }))
  return { scene, children, assets: [...assets], vision: sight ? renderVision(sight, input.vision?.fog ?? null, true) : null, regions }
}
