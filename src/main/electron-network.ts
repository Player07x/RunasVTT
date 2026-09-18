import { net, type Session } from "electron"

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])
/** Cabeçalhos que o Chromium define sozinho; repassá-los faz `setHeader` falhar. */
const UNSETTABLE_HEADERS = new Set(["host", "connection", "content-length", "keep-alive", "transfer-encoding", "upgrade", "expect", "te", "trailer", "proxy-connection"])
/**
 * `net` já entrega o corpo descompactado. Manter estes cabeçalhos faria o
 * Chromium tentar descompactar de novo e corromper a resposta.
 */
const DROPPED_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding"])

/**
 * Busca na rede pela sessão dos sites, sem passar pelo interceptador.
 *
 * Usa `net.request` em vez de `session.fetch` porque só ele informa um
 * redirecionamento: `fetch` com `redirect: "manual"` aborta e, com
 * `"follow"`, esconde a URL final. Aqui o redirecionamento volta ao
 * navegador como 3xx, e a barra de endereço mostra a URL certa.
 */
export function createNetworkFetch(ses: Session): (request: Request, signal: AbortSignal) => Promise<Response> {
  return async (request, signal) => {
    const body = request.method === "GET" || request.method === "HEAD" ? null : Buffer.from(await request.arrayBuffer())
    return new Promise<Response>((resolve, reject) => {
      const outgoing = net.request({ method: request.method, url: request.url, session: ses, redirect: "manual", useSessionCookies: true, bypassCustomProtocolHandlers: true })
      request.headers.forEach((value, name) => {
        if (UNSETTABLE_HEADERS.has(name.toLowerCase())) return
        try { outgoing.setHeader(name, value) } catch { /* cabeçalho recusado pelo Chromium */ }
      })
      const abort = () => { outgoing.abort(); reject(signal.reason ?? new Error("Abortado")) }
      if (signal.aborted) { abort(); return }
      signal.addEventListener("abort", abort, { once: true })

      outgoing.on("redirect", (status, _method, location) => {
        signal.removeEventListener("abort", abort)
        outgoing.abort()
        resolve(new Response(null, { status, headers: { location } }))
      })
      outgoing.on("response", (incoming) => {
        const headers = new Headers()
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) continue
          for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item)
        }
        const hasBody = !NULL_BODY_STATUSES.has(incoming.statusCode) && request.method !== "HEAD"
        const stream = hasBody
          ? new ReadableStream<Uint8Array>({
            start(controller) {
              incoming.on("data", (chunk) => controller.enqueue(new Uint8Array(chunk)))
              incoming.on("end", () => { signal.removeEventListener("abort", abort); controller.close() })
              incoming.on("error", (error: Error) => controller.error(error))
            },
            cancel() { outgoing.abort() },
          })
          : null
        if (!hasBody) signal.removeEventListener("abort", abort)
        resolve(new Response(stream, { status: incoming.statusCode, statusText: incoming.statusMessage, headers }))
      })
      outgoing.on("error", (error) => { signal.removeEventListener("abort", abort); reject(error) })
      if (body) outgoing.write(body)
      outgoing.end()
    })
  }
}
