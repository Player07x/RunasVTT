import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { extname, join } from "node:path"
import { WORLD_ASSETS_DIR, type AssetKind } from "../shared/world"
import { isAssetPath, type AssetPath } from "../shared/scene"

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "avif"]
export const ALLOWED_EXTENSIONS: Record<AssetKind, readonly string[]> = {
  maps: IMAGE_EXTENSIONS,
  tokens: IMAGE_EXTENSIONS,
  tiles: IMAGE_EXTENSIONS,
  audio: ["mp3", "ogg", "wav", "m4a", "flac", "webm", "opus"],
}
/** Limite por arquivo; mapas grandes em alta resolução cabem com folga. */
export const MAX_ASSET_BYTES = 200 * 1024 * 1024

/**
 * Copia um arquivo para `assets/<tipo>/<sha256>.<ext>`. O nome pelo conteúdo
 * evita duplicatas (importar o mesmo mapa duas vezes grava uma vez) e torna
 * o arquivo imutável, o que permite cache sem risco.
 */
export async function importAsset(worldPath: string, kind: AssetKind, fileName: string, bytes: Uint8Array): Promise<AssetPath> {
  const extension = extname(fileName).slice(1).toLowerCase()
  if (!ALLOWED_EXTENSIONS[kind].includes(extension)) throw new Error(`Formato .${extension || "?"} não suportado. Use: ${ALLOWED_EXTENSIONS[kind].join(", ")}.`)
  if (bytes.byteLength === 0) throw new Error("Arquivo vazio.")
  if (bytes.byteLength > MAX_ASSET_BYTES) throw new Error("Arquivo maior que 200 MB.")
  const hash = createHash("sha256").update(bytes).digest("hex")
  const path = `${kind}/${hash}.${extension === "jpeg" ? "jpg" : extension}`
  const absolute = join(worldPath, WORLD_ASSETS_DIR, path)
  if (!existsSync(absolute)) {
    await mkdir(join(worldPath, WORLD_ASSETS_DIR, kind), { recursive: true })
    await writeFile(absolute, bytes)
  }
  return path
}

/** Caminho absoluto de um asset do mundo, ou `null` se o caminho não for um asset válido. */
export function resolveAssetFile(worldPath: string, path: string): string | null {
  return isAssetPath(path) ? join(worldPath, WORLD_ASSETS_DIR, path) : null
}

const MIME_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif", avif: "image/avif",
  mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", m4a: "audio/mp4", flac: "audio/flac", webm: "audio/webm", opus: "audio/ogg",
}

/**
 * Resposta do protocolo `vtt-asset://`. O nome é o hash do conteúdo, então o
 * arquivo nunca muda: o cache pode ser permanente.
 */
export async function assetResponse(worldPath: string, path: string): Promise<Response> {
  const file = resolveAssetFile(worldPath, path)
  if (!file) return new Response(null, { status: 404 })
  try {
    const body = await readFile(file)
    return new Response(body, { headers: { "content-type": MIME_TYPES[extname(file).slice(1)] ?? "application/octet-stream", "cache-control": "public, max-age=31536000, immutable", "access-control-allow-origin": "*" } })
  } catch {
    return new Response(null, { status: 404 })
  }
}
