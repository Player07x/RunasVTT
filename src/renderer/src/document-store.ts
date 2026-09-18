import { useSyncExternalStore } from "react"
import type { DocumentChange, DocumentInput } from "../../shared/ipc"
import { SCENE_CHILD_TYPES, type DrawingData, type NoteData, type SceneData, type TileData, type TokenData } from "../../shared/scene"
import type { WorldDocument } from "../../shared/world"
import { vtt } from "./api"

export interface SceneChildren {
  tokens: WorldDocument<TokenData>[]
  tiles: WorldDocument<TileData>[]
  drawings: WorldDocument<DrawingData>[]
  notes: WorldDocument<NoteData>[]
}

const bySort = (a: WorldDocument, b: WorldDocument) => a.sort - b.sort || a.createdAt - b.createdAt

/**
 * Cópia em memória dos documentos do mundo aberto. O processo principal é a
 * fonte da verdade: toda escrita passa por ele e volta como mudança
 * transmitida, que também atualiza outras janelas (Vista dos Jogadores).
 */
export class DocumentStore {
  private readonly documents = new Map<string, WorldDocument>()
  private readonly listeners = new Set<() => void>()
  private version = 0
  private unsubscribe: (() => void) | null = null

  async load(): Promise<void> {
    this.unsubscribe = vtt.documents.onChange((change) => this.apply(change))
    const lists = await Promise.all(["scene", ...SCENE_CHILD_TYPES].map((type) => vtt.documents.list(type as WorldDocument["type"])))
    for (const document of lists.flat()) this.documents.set(document.id, document)
    this.emit()
  }

  dispose(): void {
    this.unsubscribe?.()
    this.listeners.clear()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getVersion = (): number => this.version

  get<T>(id: string): WorldDocument<T> | null {
    return (this.documents.get(id) as WorldDocument<T> | undefined) ?? null
  }

  scenes(): WorldDocument<SceneData>[] {
    return [...this.documents.values()].filter((document) => document.type === "scene").sort(bySort) as WorldDocument<SceneData>[]
  }

  children(sceneId: string): SceneChildren {
    const children = [...this.documents.values()].filter((document) => document.parentId === sceneId).sort(bySort)
    return {
      tokens: children.filter((document) => document.type === "token") as WorldDocument<TokenData>[],
      tiles: children.filter((document) => document.type === "tile") as WorldDocument<TileData>[],
      drawings: children.filter((document) => document.type === "drawing") as WorldDocument<DrawingData>[],
      notes: children.filter((document) => document.type === "note") as WorldDocument<NoteData>[],
    }
  }

  /** Grava e aplica o resultado já normalizado, sem esperar a transmissão. */
  async put(input: DocumentInput): Promise<WorldDocument> {
    const document = await vtt.documents.put(input)
    this.apply({ kind: "put", document })
    return document
  }

  async remove(id: string): Promise<void> {
    await vtt.documents.remove(id)
  }

  apply(change: DocumentChange): void {
    if (change.kind === "put") {
      const current = this.documents.get(change.document.id)
      // A mesma gravação chega duas vezes (resposta e transmissão): ignora a repetida.
      if (current && current.updatedAt > change.document.updatedAt) return
      this.documents.set(change.document.id, change.document)
    } else {
      for (const id of change.ids) this.documents.delete(id)
    }
    this.emit()
  }

  private emit(): void {
    this.version += 1
    for (const listener of this.listeners) listener()
  }
}

/** Re-renderiza o componente a cada mudança nos documentos. */
export function useDocumentsVersion(store: DocumentStore): number {
  return useSyncExternalStore(store.subscribe, store.getVersion)
}

export function newId(): string {
  return crypto.randomUUID().replaceAll("-", "")
}
