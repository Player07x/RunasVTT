import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { extname, resolve, sep } from "node:path"
import { assetResponse } from "./world-assets"
import type { Duplex } from "node:stream"
import type { AssetPath } from "../shared/scene"
import type { PlayerProjection, PlayerWireMessage } from "../shared/player"

export type { PlayerWireMessage }

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
const MAX_FRAME_BYTES = 1024 * 1024
/** Mensagens dos espectadores são pequenas (ping e mover). */
const MAX_CLIENT_FRAME_BYTES = 16 * 1024
/** Mensagens "mover" aceitas por espectador a cada segundo. */
const MOVES_PER_SECOND = 8
const ASSET_KINDS = new Set(["maps", "tokens", "tiles", "audio"])


interface PlayerServerOptions {
  staticRoot: string
  worldPath: () => string | null
  projection: () => PlayerProjection
  /** Assets que os espectadores podem baixar: os da projeção e os áudios tocando. */
  allowedAssets?: () => readonly AssetPath[]
  snapshot: () => PlayerWireMessage
  onSpectators(count: number): void
  /** Mensagem de um espectador (além do ping); a resposta vai só para ele. */
  onClientMessage?(message: unknown): PlayerWireMessage | null
}

interface Client {
  socket: Duplex
  buffer: Buffer
  send(message: PlayerWireMessage): void
  /** Horários das últimas mensagens, para o limite por segundo. */
  recent: number[]
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

function json(res: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body))
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": bytes.length, "cache-control": "no-store", "access-control-allow-origin": "*" })
  res.end(bytes)
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

  constructor(private readonly options: PlayerServerOptions) {}

  get listening(): boolean { return this.server?.listening === true }
  get spectatorCount(): number { return this.clients.size }
  get addressPort(): number {
    const address = this.server?.address()
    return address && typeof address === "object" ? address.port : 0
  }

  async start(port: number, key: string): Promise<void> {
    if (this.server) await this.stop()
    this.key = key
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
    for (const client of this.clients) {
      client.socket.end(frame(0x8, Buffer.from([0x03, 0xe9])))
    }
    this.clients.clear()
    this.options.onSpectators(0)
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
  }

  publish(message: PlayerWireMessage): void {
    for (const client of this.clients) client.send(message)
  }

  private authorized(request: IncomingMessage): boolean {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`)
    return Boolean(this.key) && url.searchParams.get("k") === this.key
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405, { allow: "GET, HEAD" }); response.end(); return }
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`)
    const staticBundleAsset = url.pathname.startsWith("/assets/") && url.pathname.split("/").filter(Boolean).length === 2
    const refererKey = typeof request.headers.referer === "string" ? (() => { try { return new URL(request.headers.referer).searchParams.get("k") } catch { return null } })() : null
    if (!this.authorized(request) && !(staticBundleAsset && refererKey === this.key && Boolean(this.key))) { response.writeHead(404); response.end(); return }
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
        if (request.method === "HEAD" || !result.body) { response.end(); return }
        response.end(Buffer.from(await result.arrayBuffer()))
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

  private handleUpgrade(request: IncomingMessage, socket: Duplex): void {
    if (!this.authorized(request)) { socket.destroy(); return }
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`)
    if (url.pathname !== "/socket" || request.headers.upgrade?.toLowerCase() !== "websocket") { socket.destroy(); return }
    const nonce = request.headers["sec-websocket-key"]
    if (typeof nonce !== "string") { socket.destroy(); return }
    const accept = createHash("sha1").update(`${nonce}${WS_GUID}`).digest("base64")
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    const client: Client = {
      socket,
      buffer: Buffer.alloc(0),
      send: (message) => { if (!socket.destroyed) socket.write(textFrame(message)) },
      recent: [],
    }
    this.clients.add(client)
    this.options.onSpectators(this.clients.size)
    // Quem chega recebe o estado completo agora, e não a última mensagem
    // enviada (que pode ser só uma régua ou um movimento de câmera).
    client.send(this.options.snapshot())
    socket.on("data", (chunk) => this.readFrames(client, chunk))
    const remove = () => { if (this.clients.delete(client)) this.options.onSpectators(this.clients.size) }
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
        const reply = this.options.onClientMessage?.(message)
        if (reply) client.send(reply)
      } catch { /* clientes não controlam o estado e mensagens inválidas são ignoradas */ }
    }
  }
}
