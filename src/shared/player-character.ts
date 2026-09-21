import type { CharacterSummary } from "./bridge"

/** Documento privado do mundo que sustenta a ficha de um assento. */
export interface SeatCharacterData {
  slotId: string
  tokenId: string | null
  sceneId: string | null
  envelope: unknown
  summary: CharacterSummary
  tokenImage: string | null
  tokenSize: number
  revision: number
  updatedAt: number
  /** Última mutação aceita; evita aplicar duas vezes um retry HTTP. */
  mutationId?: string | null
}
