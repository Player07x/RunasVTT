import type { DocumentChange, DocumentInput } from "../shared/ipc"
import { isSceneChildType, normalizeDocumentData } from "../shared/scene"
import { isDocumentType, type DocumentType, type WorldDocument } from "../shared/world"
import type { WorldDatabase } from "./world-database"

const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Único caminho de escrita dos documentos: valida, normaliza, grava e
 * devolve a mudança para ser transmitida a todas as janelas (mesa hoje,
 * Vista dos Jogadores na Fase 5).
 */
export function putDocument(database: WorldDatabase, input: DocumentInput, now = Date.now()): { document: WorldDocument; change: DocumentChange } {
  if (!isDocumentType(input.type)) throw new Error("Tipo de documento inválido.")
  if (typeof input.id !== "string" || !DOCUMENT_ID.test(input.id)) throw new Error("Id de documento inválido.")
  const parentId = input.parentId ?? null
  if (isSceneChildType(input.type)) {
    const parent = parentId ? database.get(parentId) : null
    if (parent?.type !== "scene") throw new Error("Este objeto precisa pertencer a uma cena.")
  } else if (input.type === "scene" && parentId !== null) {
    throw new Error("Cenas não pertencem a outro documento.")
  }
  const existing = database.get(input.id)
  if (existing && existing.type !== input.type) throw new Error("O id já pertence a outro tipo de documento.")
  const document: WorldDocument = {
    id: input.id,
    type: input.type,
    parentId,
    sort: typeof input.sort === "number" && Number.isFinite(input.sort) ? input.sort : existing?.sort ?? now,
    data: normalizeDocumentData(input.type, input.data),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  database.put(document)
  return { document, change: { kind: "put", document } }
}

export function deleteDocument(database: WorldDatabase, id: string): DocumentChange | null {
  const ids = database.descendantIds(id)
  if (ids.length === 0) return null
  database.delete(id)
  return { kind: "delete", ids }
}

export function listDocuments(database: WorldDatabase, type: DocumentType, parentId?: string | null): WorldDocument[] {
  if (!isDocumentType(type)) throw new Error("Tipo de documento inválido.")
  return database.list(type, parentId)
}
