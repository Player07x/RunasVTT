import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { extname, resolve, sep } from "node:path"
import { assetResponse } from "./world-assets"
import type { SiteMirror } from "./site-mirror"
import { mirrorKey, navigationFallbackKeys } from "./mirror-policy"
import { SEAT_BRIDGE_SCRIPT } from "../player/seat-bridge"
import { Readable, type Duplex } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { ReadableStream as WebReadableStream } from "node:stream/web"
import type { AssetPath } from "../shared/scene"
import type { PlayerProjection, PlayerWireMessage } from "../shared/player"
import type { SeatCharacterData } from "../shared/player-character"

export type { PlayerWireMessage }

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
const MAX_FRAME_BYTES = 1024 * 1024
/** Mensagens dos espectadores são pequenas (ping e mover). */
const MAX_CLIENT_FRAME_BYTES = 16 * 1024
/** Mensagens "mover" aceitas por espectador a cada segundo. */
const MOVES_PER_SECOND = 8
const MAX_CONNECTIONS = 24
const MAX_JOIN_BODY_BYTES = 2048
const MAX_CHARACTER_BODY_BYTES = 12 * 1024 * 1024
const SEAT_COOKIE = "runas_seat"
const TOOLS_ORIGIN = "https://runas-tools.pages.dev"
const ASSET_KINDS = new Set(["maps", "tokens", "tiles", "audio"])
const JOIN_ATTEMPTS_PER_MINUTE = 5
const JOIN_WINDOW_MS = 60_000
const CHARACTER_WRITES_PER_MINUTE = 30
const CHARACTER_WRITE_INTERVAL_MS = 2_000

export interface PlayerSeatConnection {
  slotId: string
  label: string
}

export interface JoinedPlayerSeat {
  seat: PlayerSeatConnection
  token: string
}

export interface SeatCharacterWrite {
  character: unknown
  tokenId: string | null
  baseRevision: number
  mutationId: string
}

export type SeatCharacterWriteResult =
  | { ok: true; character: SeatCharacterData }
  | { ok: false; character: SeatCharacterData | null }

interface PlayerServerOptions {
  staticRoot: string
  worldPath: () => string | null
  projection: () => PlayerProjection
  /** Assets que os espectadores podem baixar: os da projeção e os áudios tocando. */
  allowedAssets?: () => readonly AssetPath[]
  snapshot: () => PlayerWireMessage
  onSpectators(count: number): void
  onPlayers?(count: number): void
  joinSeat?(code: string): JoinedPlayerSeat | null
  authenticateSeat?(token: string): PlayerSeatConnection | null
  onSeatConnected?(seat: PlayerSeatConnection): void
  onSeatDisconnected?(seat: PlayerSeatConnection): void
  getSeatCharacter?(seat: PlayerSeatConnection): SeatCharacterData | null
  putSeatCharacter?(seat: PlayerSeatConnection, input: SeatCharacterWrite): SeatCharacterWriteResult | Promise<SeatCharacterWriteResult>
  deleteSeatCharacter?(seat: PlayerSeatConnection): void
  toolsMirror?: SiteMirror
  /** Mensagem de um espectador (além do ping); a resposta vai só para ele. */
  onClientMessage?(message: unknown, seat: PlayerSeatConnection | null): PlayerWireMessage | null
}

interface Client {
  socket: Duplex
  buffer: Buffer
  send(message: PlayerWireMessage): void
  /** Horários das últimas mensagens, para o limite por segundo. */
  recent: number[]
  seat: PlayerSeatConnection | null
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
}

const SEAT_BRIDGE_TAG = '<script src="/tools/runas-vtt-seat.js"></script>'

/**
 * Injeta o shim da ponte logo depois da abertura do `<head>`.
 *
 * A posição importa: o shim repõe `crypto.randomUUID`, que o navegador
 * esconde fora de contexto seguro, e o Runas Tools chama essa função já na
 * hidratação. Antes de `</head>` o shim rodaria depois dos scripts do Tools e
 * o jogador da rede local veria o erro assim mesmo.
 */
export function withSeatBridge(html: string): string {
  if (html.includes("/tools/runas-vtt-seat.js")) return html
  const head = /<head[^>]*>/i.exec(html)
  if (head) {
    const at = head.index + head[0].length
    return `${html.slice(0, at)}${SEAT_BRIDGE_TAG}${html.slice(at)}`
  }
  // Sem `<head>` escrito: antes do primeiro script, ou no começo do documento.
  const script = /<script\b/i.exec(html)
  if (script) return `${html.slice(0, script.index)}${SEAT_BRIDGE_TAG}${html.slice(script.index)}`
  return `${SEAT_BRIDGE_TAG}${html}`
}

function json(res: ServerResponse, status: number, body: unknown, cors = true, extra: Record<string, string> = {}): void {
  const bytes = Buffer.from(JSON.stringify(body))
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": bytes.length, "cache-control": "no-store", ...(cors ? { "access-control-allow-origin": "*" } : {}), ...extra })
  res.end(bytes)
}

function cookie(request: IncomingMessage, name: string): string | null {
  const header = typeof request.headers.cookie === "string" ? request.headers.cookie : ""
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=")
    if (key === name) return decodeURIComponent(value.join("="))
  }
  return null
}

async function requestBody(request: IncomingMessage, limit: number): Promise<Buffer | null> {
  const contentLength = Number(request.headers["content-length"] ?? 0)
  if (Number.isFinite(contentLength) && contentLength > limit) return null
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += value.length
    if (size > limit) return null
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

function isSafeStaticPath(root: string, pathname: string): string | null {
  const relative = pathname.replace(/^\/+/, "")
  if (!relative || relative.includes("\0") || relative.split("/").some((part) => part === "..")) return null
  const target = resolve(root, relative)
  if (target !== root && !target.startsWith(`${root}${sep}`)) return null
  return target
}

function frame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length
  if (length > MAX_FRAME_BYTES) throw new Error("Mensagem WebSocket grande demais.")
  if (length < 126) return Buffer.concat([Buffer.from([0x80 | opcode, length]), payload])
  if (length <= 0xffff) {
    const header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(length, 2)
    return Buffer.concat([header, payload])
  }
  const header = Buffer.alloc(10)
  header[0] = 0x80 | opcode
  header[1] = 127
  header.writeBigUInt64BE(BigInt(length), 2)
  return Buffer.concat([header, payload])
}

function textFrame(value: PlayerWireMessage): Buffer {
  return frame(0x1, Buffer.from(JSON.stringify(value)))
}

/** Servidor mínimo e deliberadamente somente leitura da Vista dos Jogadores. */
export class PlayerServer {
  private server: Server | null = null
  private key = ""
  private clients = new Set<Client>()
  private joinAttempts: number[] = []
  private readonly joinAttemptsByAddress = new Map<string, number[]>()
  private readonly characterWrites = new Map<string, number[]>()

  constructor(private readonly options: PlayerServerOptions) {}

  get listening(): boolean { return this.server?.listening === true }
  get playerCount(): number { return [...this.clients].filter((client) => client.seat !== null).length }
  get spectatorCount(): number { return this.clients.size - this.playerCount }
  get addressPort(): number {
    const address = this.server?.address()
    return address && typeof address === "object" ? address.port : 0
  }

  async start(port: number, key: string): Promise<void> {
    if (this.server) await this.stop()
    this.key = key
    this.joinAttempts = []
    this.joinAttemptsByAddress.clear()
    this.characterWrites.clear()
    const server = createServer((request, response) => { void this.handleRequest(request, response) })
    server.on("upgrade", (request, socket) => this.handleUpgrade(request, socket))
    this.server = server
    await new Promise<void>((resolvePromise, reject) => {
      const onError = (error: Error) => { server.off("listening", onListening); this.server = null; reject(error) }
      const onListening = () => { server.off("error", onError); resolvePromise() }
      server.once("error", onError)
      server.once("listening", onListening)
      server.listen({ host: "0.0.0.0", port })
    })
  }

  async stop(): Promise<void> {
    this.key = ""
    this.joinAttempts = []
    this.joinAttemptsByAddress.clear()
    this.characterWrites.clear()
    for (const client of this.clients) {
      client.socket.end(frame(0x8, Buffer.from([0x03, 0xe9])))
    }
    this.clients.clear()
    this.options.onSpectators(0)
    this.options.onPlayers?.(0)
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
  }

  publish(message: PlayerWireMessage): void {
    for (const client of this.clients) client.send(message)
  }

  publishToSeat(slotId: string, message: PlayerWireMessage): void {
    for (const client of this.clients) if (client.seat?.slotId === slotId) client.send(message)
  }

  private authorized(request: IncomingMessage): boolean {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`)
    return this.authorizedUrl(url)
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`)
    if (request.method === "POST" && url.pathname === "/seat/join") {
      await this.handleJoin(request, response, url)
      return
    }
    const seatCharacterPath = url.pathname === "/seat/character"
    if (request.method !== "GET" && request.method !== "HEAD" && !(seatCharacterPath && (request.method === "PUT" || request.method === "DELETE"))) { response.writeHead(405, { allow: "GET, HEAD, POST, PUT, DELETE" }); response.end(); return }
    const staticBundleAsset = url.pathname.startsWith("/assets/") && url.pathname.split("/").filter(Boolean).length === 2
    const refererKey = typeof request.headers.referer === "string" ? (() => { try { return new URL(request.headers.referer).searchParams.get("k") } catch { return null } })() : null
    const seat = this.seatForRequest(request)
    const toolsReferer = this.hasToolsReferer(request)
    const seatPath = url.pathname === "/seat" || url.pathname === "/seat/character"
    const toolsPath = this.isToolsRequest(url.pathname) || this.isToolsAssetRequest(request, url.pathname)
    if (!this.validOrigin(request) && (seatPath || toolsPath)) { response.writeHead(403, { "cache-control": "no-store" }); response.end(); return }
    if (!this.authorized(request) && !(staticBundleAsset && refererKey === this.key && Boolean(this.key)) && !(seat && (seatPath || toolsPath || toolsReferer))) { response.writeHead(404); response.end(); return }
    if (url.pathname === "/seat") {
      if (!seat) { response.writeHead(401, { "cache-control": "no-store" }); response.end(); return }
      json(response, 200, { seat }, false)
      return
    }
    if (url.pathname === "/seat/character") {
      await this.handleSeatCharacter(request, response, seat)
      return
    }
    if (this.isToolsRequest(url.pathname) || this.isToolsAssetRequest(request, url.pathname)) {
      if (!seat) { response.writeHead(401, { "cache-control": "no-store" }); response.end(); return }
      await this.serveTools(request, response, url)
      return
    }
    if (url.pathname.startsWith("/assets/")) {
      const parts = url.pathname.split("/").filter(Boolean)
      // Assets do not go through the static bundle path. They are served only
      // when the current projection (or audio playing now) references the exact hash-named file.
      const allowed = this.options.allowedAssets?.() ?? this.options.projection().assets
      if (parts.length === 3 && ASSET_KINDS.has(parts[1]!) && allowed.includes(`${parts[1]}/${parts[2]}` as AssetPath)) {
        const worldPath = this.options.worldPath()
        if (!worldPath) { response.writeHead(404); response.end(); return }
        const range = typeof request.headers.range === "string" ? request.headers.range : null
        const result = await assetResponse(worldPath, `${parts[1]}/${parts[2]}`, range)
        response.writeHead(result.status, Object.fromEntries(result.headers.entries()))
        if (request.method === "HEAD" || !result.body) { await result.body?.cancel(); response.end(); return }
        // Transmitido por stream: uma música de 1 h não pode virar um Buffer na memória do processo.
        await pipeline(Readable.fromWeb(result.body as WebReadableStream<Uint8Array>), response).catch(() => undefined)
        return
      }
    }
    const relative = url.pathname === "/" || url.pathname === "/player.html" ? "player.html" : url.pathname.replace(/^\//, "")
    const target = isSafeStaticPath(this.options.staticRoot, relative)
    if (!target) { response.writeHead(404); response.end(); return }
    try {
      const file = await stat(target)
      if (!file.isFile()) throw new Error("not a file")
      response.writeHead(200, { "content-type": CONTENT_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream", "content-length": file.size, "cache-control": relative === "player.html" ? "no-store" : "public, max-age=31536000, immutable", "access-control-allow-origin": "*" })
      if (request.method === "HEAD") { response.end(); return }
      createReadStream(target).pipe(response)
    } catch {
      response.writeHead(404)
      response.end()
    }
  }

  private async handleJoin(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (!this.authorizedUrl(url)) { response.writeHead(404); response.end(); return }
    if (!this.validOrigin(request)) { response.writeHead(403, { "cache-control": "no-store" }); response.end(); return }
    if (!this.allowJoinAttempt(request)) { json(response, 429, { error: "Tente novamente em alguns instantes." }, false, { "retry-after": "60" }); return }
    const body = await requestBody(request, MAX_JOIN_BODY_BYTES)
    if (!body) { json(response, 413, { error: "Pedido grande demais." }, false); return }
    let code: unknown
    try { code = (JSON.parse(body.toString("utf8")) as { code?: unknown }).code } catch { code = null }
    if (typeof code !== "string" || code.length > 128 || !this.options.joinSeat) { json(response, 401, { error: "Código inválido." }, false); return }
    const joined = this.options.joinSeat(code)
    if (!joined) { json(response, 401, { error: "Código inválido." }, false); return }
    const value = encodeURIComponent(joined.token)
    json(response, 200, { seat: joined.seat }, false, { "set-cookie": `${SEAT_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400` })
  }

  private async handleSeatCharacter(request: IncomingMessage, response: ServerResponse, seat: PlayerSeatConnection | null): Promise<void> {
    if (!seat) { response.writeHead(401, { "cache-control": "no-store" }); response.end(); return }
    if (request.method === "GET") {
      const character = this.options.getSeatCharacter?.(seat) ?? null
      json(response, 200, { character }, false)
      return
    }
    if (request.method === "DELETE") {
      this.options.deleteSeatCharacter?.(seat)
      json(response, 200, { ok: true }, false)
      return
    }
    if (request.method !== "PUT") { response.writeHead(405, { allow: "GET, PUT, DELETE" }); response.end(); return }
    if (!this.allowCharacterWrite(seat)) { json(response, 429, { error: "Aguarde antes de enviar outra alteração." }, false, { "retry-after": "2" }); return }
    const body = await requestBody(request, MAX_CHARACTER_BODY_BYTES)
    if (!body) { json(response, 413, { error: "Ficha grande demais." }, false); return }
    let raw: Record<string, unknown>
    try {
      const parsed = JSON.parse(body.toString("utf8"))
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("objeto")
      raw = parsed as Record<string, unknown>
    } catch {
      json(response, 400, { error: "Ficha inválida." }, false)
      return
    }
    const baseRevision = typeof raw.baseRevision === "number" && Number.isInteger(raw.baseRevision) && raw.baseRevision >= 0 ? raw.baseRevision : -1
    const mutationId = typeof raw.mutationId === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(raw.mutationId) ? raw.mutationId : ""
    const tokenId = raw.tokenId === null || typeof raw.tokenId === "string" ? raw.tokenId : null
    if (baseRevision < 0 || !mutationId || !this.options.putSeatCharacter) { json(response, 400, { error: "Mutação inválida." }, false); return }
    try {
      const result = await this.options.putSeatCharacter(seat, { character: raw.character, tokenId, baseRevision, mutationId })
      if (!result.ok) { json(response, 409, { error: "A ficha mudou na mesa.", character: result.character }, false); return }
      json(response, 200, { character: result.character }, false)
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : "Ficha inválida." }, false)
    }
  }

  private authorizedUrl(url: URL): boolean {
    return Boolean(this.key) && url.searchParams.get("k") === this.key
  }

  private validOrigin(request: IncomingMessage): boolean {
    const origin = typeof request.headers.origin === "string" ? request.headers.origin : ""
    if (!origin) return true
    try {
      const protocol = typeof request.headers["x-forwarded-proto"] === "string" ? request.headers["x-forwarded-proto"].split(",")[0]!.trim() : "http"
      const expected = new URL(`${protocol}://${request.headers.host ?? "localhost"}`)
      const actual = new URL(origin)
      return actual.protocol === expected.protocol && actual.host === expected.host
    } catch { return false }
  }

  private allowJoinAttempt(request: IncomingMessage): boolean {
    const now = Date.now()
    this.joinAttempts = this.joinAttempts.filter((at) => now - at < JOIN_WINDOW_MS)
    const address = typeof request.headers["cf-connecting-ip"] === "string"
      ? request.headers["cf-connecting-ip"]
      : request.socket.remoteAddress ?? "unknown"
    const attempts = (this.joinAttemptsByAddress.get(address) ?? []).filter((at) => now - at < JOIN_WINDOW_MS)
    if (this.joinAttempts.length >= JOIN_ATTEMPTS_PER_MINUTE || attempts.length >= JOIN_ATTEMPTS_PER_MINUTE) return false
    this.joinAttempts.push(now)
    attempts.push(now)
    this.joinAttemptsByAddress.set(address, attempts)
    return true
  }

  private allowCharacterWrite(seat: PlayerSeatConnection): boolean {
    const now = Date.now()
    const attempts = (this.characterWrites.get(seat.slotId) ?? []).filter((at) => now - at < JOIN_WINDOW_MS)
    const last = attempts.at(-1)
    if (attempts.length >= CHARACTER_WRITES_PER_MINUTE || (last !== undefined && now - last < CHARACTER_WRITE_INTERVAL_MS)) return false
    attempts.push(now)
    this.characterWrites.set(seat.slotId, attempts)
    return true
  }

  private seatForRequest(request: IncomingMessage): PlayerSeatConnection | null {
    const token = cookie(request, SEAT_COOKIE)
    return token && this.options.authenticateSeat ? this.options.authenticateSeat(token) : null
  }

  private isToolsRequest(pathname: string): boolean {
    return pathname === "/tools" || pathname === "/tools/" || pathname.startsWith("/tools/")
  }

  /** Next export usa caminhos absolutos; o referer mantém esses assets dentro do Tools. */
  private isToolsAssetRequest(request: IncomingMessage, pathname: string): boolean {
    if (pathname.startsWith("/assets/") || pathname === "/socket" || pathname.startsWith("/seat")) return false
    return this.hasToolsReferer(request)
  }

  private hasToolsReferer(request: IncomingMessage): boolean {
    const referer = typeof request.headers.referer === "string" ? request.headers.referer : ""
    try { return new URL(referer).pathname.startsWith("/tools") } catch { return false }
  }

  private async serveTools(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (url.pathname === "/tools/runas-vtt-seat.js") {
      const body = Buffer.from(SEAT_BRIDGE_SCRIPT)
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "content-length": body.length, "cache-control": "no-store" })
      if (request.method === "HEAD") { response.end(); return }
      response.end(body)
      return
    }
    // O site espelhado pode conter o registro de service worker do Tools, mas
    // ele nunca deve controlar a origem inteira do VTT (nem cachear /seat/*).
    if (url.pathname === "/sw.js" || url.pathname === "/tools/sw.js") {
      response.writeHead(404, { "cache-control": "no-store" }); response.end(); return
    }
    const mirror = this.options.toolsMirror
    if (!mirror) { response.writeHead(503, { "cache-control": "no-store" }); response.end(); return }
    const path = this.isToolsRequest(url.pathname) ? (url.pathname.slice("/tools".length) || "/") : url.pathname
    const original = new URL(path.startsWith("/") ? path : `/${path}`, TOOLS_ORIGIN)
    const query = new URLSearchParams(url.search)
    query.delete("k")
    original.search = query.toString() ? `?${query.toString()}` : ""
    const key = mirrorKey(original.href)
    let entry = mirror.get(key)
    if (!entry && typeof request.headers.accept === "string" && request.headers.accept.includes("text/html")) {
      for (const fallback of navigationFallbackKeys(key)) {
        entry = mirror.get(fallback)
        if (entry) break
      }
    }
    if (!entry) { response.writeHead(404, { "cache-control": "no-store" }); response.end(); return }
    let body = Buffer.from(entry.body)
    if (entry.contentType.includes("text/html")) {
      body = Buffer.from(withSeatBridge(body.toString("utf8")))
    }
    response.writeHead(entry.status, { "content-type": entry.contentType, "content-length": body.length, "cache-control": "no-cache", "x-runas-vtt-source": "mirror" })
    if (request.method === "HEAD") { response.end(); return }
    response.end(body)
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex): void {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`)
    if (url.pathname !== "/socket" || request.headers.upgrade?.toLowerCase() !== "websocket") { socket.destroy(); return }
    const seat = this.seatForRequest(request)
    if ((!this.authorized(request) && !seat) || !this.validOrigin(request)) { socket.destroy(); return }
    const nonce = request.headers["sec-websocket-key"]
    if (typeof nonce !== "string") { socket.destroy(); return }
    if (this.clients.size >= MAX_CONNECTIONS) { socket.destroy(); return }
    const accept = createHash("sha1").update(`${nonce}${WS_GUID}`).digest("base64")
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    const client: Client = {
      socket,
      buffer: Buffer.alloc(0),
      send: (message) => { if (!socket.destroyed) socket.write(textFrame(message)) },
      recent: [],
      seat,
    }
    this.clients.add(client)
    this.options.onSpectators(this.spectatorCount)
    this.options.onPlayers?.(this.playerCount)
    if (seat) this.options.onSeatConnected?.(seat)
    // Quem chega recebe o estado completo agora, e não a última mensagem
    // enviada (que pode ser só uma régua ou um movimento de câmera).
    client.send(this.options.snapshot())
    if (seat) client.send({ type: "seat-status", seat })
    socket.on("data", (chunk) => this.readFrames(client, chunk))
    const remove = () => {
      if (!this.clients.delete(client)) return
      this.options.onSpectators(this.spectatorCount)
      this.options.onPlayers?.(this.playerCount)
      if (client.seat) this.options.onSeatDisconnected?.(client.seat)
    }
    socket.once("close", remove)
    socket.once("error", remove)
  }

  private readFrames(client: Client, chunk: Buffer): void {
    client.buffer = Buffer.concat([client.buffer, chunk])
    while (client.buffer.length >= 2) {
      const first = client.buffer[0]!
      const second = client.buffer[1]!
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let length = second & 0x7f
      let offset = 2
      if (length === 126) { if (client.buffer.length < 4) return; length = client.buffer.readUInt16BE(2); offset = 4 }
      else if (length === 127) { if (client.buffer.length < 10) return; const long = client.buffer.readBigUInt64BE(2); if (long > BigInt(MAX_FRAME_BYTES)) { client.socket.destroy(); return }; length = Number(long); offset = 10 }
      if (!masked || length > MAX_CLIENT_FRAME_BYTES) { client.socket.destroy(); return }
      if (client.buffer.length < offset + 4 + length) return
      const mask = client.buffer.subarray(offset, offset + 4)
      offset += 4
      const payload = Buffer.from(client.buffer.subarray(offset, offset + length))
      for (let index = 0; index < payload.length; index += 1) {
        const maskByte = mask[index % 4]
        const value = payload[index]
        if (maskByte !== undefined && value !== undefined) payload[index] = value ^ maskByte
      }
      client.buffer = client.buffer.subarray(offset + length)
      if (opcode === 0x8) { client.socket.end(frame(0x8, payload.subarray(0, 125))); return }
      if (opcode === 0x9) { client.socket.write(frame(0xA, payload)); continue }
      if (opcode !== 0x1) continue
      try {
        const message = JSON.parse(payload.toString("utf8")) as { type?: unknown; tokenId?: unknown }
        if (message.type === "ping") { client.socket.write(textFrame({ type: "pong" })); continue }
        const now = Date.now()
        client.recent = client.recent.filter((at) => now - at < 1000)
        if (client.recent.length >= MOVES_PER_SECOND) {
          client.send({ type: "move-result", tokenId: typeof message.tokenId === "string" ? message.tokenId.slice(0, 64) : "", ok: false, reason: "Devagar: muitos movimentos seguidos." })
          continue
        }
        client.recent.push(now)
        const reply = this.options.onClientMessage?.(message, client.seat)
        if (reply) client.send(reply)
      } catch { /* clientes não controlam o estado e mensagens inválidas são ignoradas */ }
    }
  }
}
