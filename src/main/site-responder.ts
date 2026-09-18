import { suiteSiteFor, type SuiteSite } from "../shared/sites"
import { bypassesMirror, extractAssetUrls, isImmutableAsset, isNavigation, isStorableResponse, mirrorKey, navigationFallbackKeys } from "./mirror-policy"
import type { MirroredResponse, SiteMirror } from "./site-mirror"

export type ResponseSource = "network" | "mirror" | "unavailable"

export interface ResponderDeps {
  mirror: SiteMirror
  /** Busca na rede de verdade, sem passar de novo pelo interceptador. */
  network: (request: Request, signal: AbortSignal) => Promise<Response>
  /** Modo offline forçado pelo usuário (ou por testes): nunca toca a rede nos sites da suíte. */
  isForcedOffline: () => boolean
  onServed?: (site: SuiteSite, source: ResponseSource, url: string, request: Request) => void
  navigationTimeoutMs?: number
  resourceTimeoutMs?: number
}

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])

function fromMirror(entry: MirroredResponse): Response {
  return new Response(Buffer.from(entry.body), {
    status: entry.status,
    headers: { "content-type": entry.contentType, "cache-control": "no-cache", "x-runas-vtt-source": "mirror" },
  })
}

function offlineResponse(request: Request): Response {
  if (!isNavigation(request)) return new Response(null, { status: 504, statusText: "Offline" })
  const html = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Sem conexão</title>
<body style="margin:0;display:grid;min-height:100vh;place-items:center;background:#0d0b0c;color:#f3ece8;font-family:'Segoe UI',system-ui,sans-serif">
<div style="max-width:420px;padding:24px;text-align:center"><h1 style="font-size:20px">Sem conexão</h1>
<p style="color:#b8aaa5;line-height:1.6">Esta página ainda não tem cópia local. Quando estiver online, use <strong>Preparar offline</strong> no navegador do RunasVTT.</p></div></body></html>`
  return new Response(html, { status: 503, headers: { "content-type": "text/html; charset=utf-8", "x-runas-vtt-source": "unavailable" } })
}

function lookupMirror(mirror: SiteMirror, request: Request): MirroredResponse | null {
  const key = mirrorKey(request.url)
  const exact = mirror.get(key)
  if (exact || !isNavigation(request)) return exact
  for (const fallback of navigationFallbackKeys(key)) {
    const entry = mirror.get(fallback)
    if (entry) return entry
  }
  return null
}

async function storeAndReturn(mirror: SiteMirror, key: string, response: Response): Promise<Response> {
  if (!isStorableResponse(response.status, response.headers)) return response
  const body = new Uint8Array(await response.arrayBuffer())
  mirror.put(key, response.status, response.headers, body)
  return new Response(NULL_BODY_STATUSES.has(response.status) ? null : body, { status: response.status, statusText: response.statusText, headers: response.headers })
}

/** HEAD confere se algo existe: rede se houver, senão a cópia local sem corpo. Nunca grava. */
async function respondHead(request: Request, key: string, deps: ResponderDeps): Promise<[ResponseSource, Response]> {
  if (!deps.isForcedOffline()) {
    try {
      const response = await deps.network(request, AbortSignal.timeout(deps.resourceTimeoutMs ?? 15000))
      if (response.status < 500) return ["network", response]
    } catch {
      // Sem rede: segue para a cópia local.
    }
  }
  const entry = deps.mirror.get(key)
  return entry
    ? ["mirror", new Response(null, { status: entry.status, headers: { "content-type": entry.contentType, "x-runas-vtt-source": "mirror" } })]
    : ["unavailable", new Response(null, { status: 504, statusText: "Offline" })]
}

/**
 * Atende uma requisição do navegador integrado. Fora das origens da suíte,
 * só repassa à rede. Nas origens da suíte:
 * - assets com hash: cópia local primeiro, rede se faltar;
 * - demais GETs: rede primeiro (com limite de tempo), cópia local se falhar;
 * - backup, autenticação, Cloudflare e RSC: sempre rede, nunca copiados.
 */
export async function respond(request: Request, deps: ResponderDeps): Promise<Response> {
  const site = suiteSiteFor(request.url)
  if (!site) return deps.network(request, new AbortController().signal)
  const served = (source: ResponseSource, response: Response) => { deps.onServed?.(site, source, request.url, request); return response }

  if (bypassesMirror(request)) {
    if (deps.isForcedOffline()) return served("unavailable", new Response(JSON.stringify({ error: "Offline" }), { status: 503, headers: { "content-type": "application/json" } }))
    return served("network", await deps.network(request, new AbortController().signal))
  }

  const key = mirrorKey(request.url)
  if (request.method === "HEAD") return served(...await respondHead(request, key, deps))
  if (isImmutableAsset(request.url)) {
    const cached = deps.mirror.get(key)
    if (cached) return served("mirror", fromMirror(cached))
  }

  if (!deps.isForcedOffline()) {
    const timeout = isNavigation(request) ? deps.navigationTimeoutMs ?? 6000 : deps.resourceTimeoutMs ?? 15000
    try {
      const response = await deps.network(request, AbortSignal.timeout(timeout))
      // Erro do servidor com cópia disponível: a cópia é mais útil que a página de erro.
      if (response.status < 500) return served("network", await storeAndReturn(deps.mirror, key, response))
    } catch {
      // Sem rede ou tempo esgotado: segue para a cópia local.
    }
  }

  const entry = lookupMirror(deps.mirror, request)
  return entry ? served("mirror", fromMirror(entry)) : served("unavailable", offlineResponse(request))
}

export interface WarmupProgress {
  site: SuiteSite
  done: number
  total: number
  stored: number
  failed: number
}

const TEXT_TYPES = ["text/html", "javascript", "text/css", "application/json", "manifest+json"]
const MAX_WARMUP_URLS = 3000

/**
 * "Preparar offline": copia as rotas principais de um site e, recursivamente,
 * todo asset que elas referenciam — inclusive os carregados sob demanda.
 */
export async function warmSite(site: SuiteSite, deps: Pick<ResponderDeps, "mirror" | "network">, onProgress?: (progress: WarmupProgress) => void): Promise<WarmupProgress> {
  const queue = site.warmupPaths.map((path) => new URL(path, site.origin).href)
  const seen = new Set(queue)
  const progress: WarmupProgress = { site, done: 0, total: queue.length, stored: 0, failed: 0 }

  async function visit(url: string): Promise<void> {
    try {
      const response = await deps.network(new Request(url, { headers: { accept: url.endsWith("/") || !/\.[a-z0-9]+$/i.test(new URL(url).pathname) ? "text/html" : "*/*" } }), AbortSignal.timeout(20000))
      if (!isStorableResponse(response.status, response.headers)) { progress.failed += 1; return }
      const body = new Uint8Array(await response.arrayBuffer())
      deps.mirror.put(mirrorKey(url), response.status, response.headers, body)
      progress.stored += 1
      const type = response.headers.get("content-type") ?? ""
      if (!TEXT_TYPES.some((candidate) => type.includes(candidate))) return
      for (const asset of extractAssetUrls(new TextDecoder().decode(body), url)) {
        if (new URL(asset).origin !== site.origin || seen.has(asset) || seen.size >= MAX_WARMUP_URLS) continue
        seen.add(asset)
        queue.push(asset)
        progress.total += 1
      }
    } catch {
      progress.failed += 1
    } finally {
      progress.done += 1
      onProgress?.({ ...progress })
    }
  }

  // Até 6 downloads simultâneos. Cada visita pode acrescentar URLs à fila,
  // então o pool só termina quando não há fila nem download em andamento.
  await new Promise<void>((resolve) => {
    let active = 0
    const pump = () => {
      while (active < 6 && queue.length > 0) {
        const next = queue.shift() as string
        active += 1
        void visit(next).finally(() => { active -= 1; pump() })
      }
      if (active === 0 && queue.length === 0) resolve()
    }
    pump()
  })
  return progress
}
