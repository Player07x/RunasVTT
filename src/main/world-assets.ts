import { createHash } from "node:crypto"
import { createReadStream, existsSync } from "node:fs"
import { mkdir, stat, writeFile } from "node:fs/promises"
import { extname, join } from "node:path"
import { Readable } from "node:stream"
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
 * Interpreta `bytes=início-fim`; `null` para cabeçalho ausente ou inválido.
 *
 * Uma Range aberta (`bytes=N-`) é atendida até o fim do arquivo. Um teto por
 * requisição parece inofensivo, mas quebra faixas longas: o Chromium encerra
 * a mídia com `error` ao chegar no limite do trecho (uma música de 1 h a
 * 130 kbps morre em ~4 min por trecho de 4 MB). O corpo é transmitido por
 * stream, então servir o arquivo inteiro não carrega nada em memória.
 */
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
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
  }
  return start <= end && start < size ? { start, end } : null
}

/** Corpo lido do disco sob demanda, para não carregar um mapa ou uma música inteira em memória. */
function fileStream(file: string, start?: number, end?: number): ReadableStream<Uint8Array> {
  return Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream<Uint8Array>
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
    const { size } = await stat(file)
    if (!range) return new Response(fileStream(file), { headers: { ...headers, "content-length": String(size) } })
    const slice = parseRange(range, size)
    if (!slice) return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } })
    const length = slice.end - slice.start + 1
    return new Response(fileStream(file, slice.start, slice.end), { status: 206, headers: { ...headers, "content-range": `bytes ${slice.start}-${slice.end}/${size}`, "content-length": String(length) } })
  } catch {
    return new Response(null, { status: 404 })
  }
}
