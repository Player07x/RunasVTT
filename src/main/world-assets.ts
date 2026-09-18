import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, open, readFile, writeFile } from "node:fs/promises"
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

/** Maior trecho servido por requisição com Range aberta (`bytes=N-`). */
const RANGE_CHUNK = 4 * 1024 * 1024

/** Interpreta `bytes=início-fim`; `null` para cabeçalho ausente ou inválido. */
export function parseRange(header: string | null | undefined, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "")
  if (!match || (!match[1] && !match[2])) return null
  let start: number
  let end: number
  if (!match[1]) {
    // Sufixo: os últimos N bytes.
    const suffix = Number(match[2])
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] ? Math.min(Number(match[2]), size - 1) : Math.min(size - 1, start + RANGE_CHUNK - 1)
  }
  return start <= end && start < size ? { start, end } : null
}

/**
 * Resposta do protocolo `vtt-asset://` e da Vista dos Jogadores. O nome é o
 * hash do conteúdo, então o arquivo nunca muda: o cache pode ser permanente.
 * Aceita Range, que o áudio precisa para começar do ponto certo da faixa.
 */
export async function assetResponse(worldPath: string, path: string, range?: string | null): Promise<Response> {
  const file = resolveAssetFile(worldPath, path)
  if (!file) return new Response(null, { status: 404 })
  const headers: Record<string, string> = { "content-type": MIME_TYPES[extname(file).slice(1)] ?? "application/octet-stream", "cache-control": "public, max-age=31536000, immutable", "access-control-allow-origin": "*", "accept-ranges": "bytes" }
  try {
    if (!range) return new Response(await readFile(file), { headers })
    const handle = await open(file, "r")
    try {
      const { size } = await handle.stat()
      const slice = parseRange(range, size)
      if (!slice) return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } })
      const length = slice.end - slice.start + 1
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, slice.start)
      return new Response(buffer, { status: 206, headers: { ...headers, "content-range": `bytes ${slice.start}-${slice.end}/${size}`, "content-length": String(length) } })
    } finally {
      await handle.close()
    }
  } catch {
    return new Response(null, { status: 404 })
  }
}
