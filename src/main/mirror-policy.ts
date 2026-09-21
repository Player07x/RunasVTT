/**
 * Regras puras da cópia local dos sites (ADR 0002). Sem dependência do
 * Electron para que sejam testáveis.
 */

/** Rotas que nunca entram na cópia local: backup, autenticação e Cloudflare. */
const NEVER_MIRRORED_PREFIXES = ["/api/", "/cdn-cgi/"]

export interface RequestInfo {
  method: string
  url: string
  headers: { get(name: string): string | null }
}

/** Requisições que vão direto à rede, sem ler nem gravar a cópia local. */
export function bypassesMirror(request: RequestInfo): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return true
  const url = new URL(request.url)
  if (NEVER_MIRRORED_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return true
  // Payloads RSC pertencem a um único build e nunca podem ser servidos de cópia.
  if (url.searchParams.has("_rsc")) return true
  if (request.headers.get("rsc") === "1" || request.headers.get("next-router-prefetch")) return true
  return false
}

/**
 * Assets com hash no nome não mudam de conteúdo: a cópia local é servida
 * primeiro, sem esperar a rede.
 */
export function isImmutableAsset(url: string): boolean {
  return new URL(url).pathname.startsWith("/_next/static/")
}

export function isNavigation(request: RequestInfo): boolean {
  const destination = request.headers.get("sec-fetch-dest")
  if (destination) return destination === "document"
  return (request.headers.get("accept") ?? "").includes("text/html")
}

/** Só respostas completas e reutilizáveis são gravadas. */
export function isStorableResponse(status: number, headers: { get(name: string): string | null }): boolean {
  if (status !== 200) return false
  if ((headers.get("cache-control") ?? "").includes("no-store")) return false
  if (headers.get("set-cookie")) return false
  return true
}

/** Chave da cópia local: a URL sem fragmento. */
export function mirrorKey(url: string): string {
  const parsed = new URL(url)
  parsed.hash = ""
  return parsed.href
}

/**
 * Chaves alternativas para uma navegação sem cópia exata: sem query string
 * (`/?view=encounter` → `/`) e com ou sem a barra final.
 */
export function navigationFallbackKeys(url: string): string[] {
  const parsed = new URL(url)
  parsed.hash = ""
  const keys = new Set<string>()
  const withoutQuery = new URL(parsed.href)
  withoutQuery.search = ""
  for (const candidate of [parsed, withoutQuery]) {
    keys.add(candidate.href)
    const toggled = new URL(candidate.href)
    toggled.pathname = candidate.pathname.endsWith("/") && candidate.pathname !== "/" ? candidate.pathname.slice(0, -1) : `${candidate.pathname}/`
    if (toggled.pathname !== "//") keys.add(toggled.href)
  }
  keys.delete(parsed.href)
  return [...keys]
}

/**
 * Arquivos do build, por caminho absoluto (`"/_next/static/…"`) ou relativo
 * (`"./_next/static/…"`).
 *
 * O caminho relativo é o formato da lista de pré-cache do service worker do
 * Runas Tools, e é a única lista completa dos pedaços que ele carrega sob
 * demanda: os nomes dos chunks do `import()` são montados em tempo de
 * execução e não aparecem escritos em nenhum outro arquivo. Sem eles na cópia
 * local, a ficha do jogador não abre (ADR 0020).
 */
const ASSET_PATTERN = /["'(]((?:\.{1,2})?\/(?:_next\/static|_vinext_fonts)\/[^"'()\s\\]+?\.(?:js|mjs|css|woff2?|otf|ttf|png|jpe?g|webp|svg|gif|ico|json))["')]/g
const ROOT_FILE_PATTERN = /(?:href|src)=["'](\/[^"'#?\s]+\.(?:png|webp|svg|ico|otf|woff2?|webmanifest|json))["']/g
/** Ícones do manifesto: `"src": "/icon-192.png"` ou `"./icon-192.png"`. */
const MANIFEST_SRC_PATTERN = /"src"\s*:\s*"((?:\.{0,2}\/)?[^"#?\s:]+\.(?:png|webp|svg|ico))"/g
/** Imagens e fontes de CSS: `url(/fundo.webp)`, `url("../media/x.woff2")`. */
const CSS_URL_PATTERN = /url\(\s*["']?((?:\.{0,2}\/)[^"'()\s]+?\.(?:png|jpe?g|webp|svg|gif|ico|otf|ttf|woff2?))["']?\s*\)/g
/** Caminhos relativos em código, como a lista de pré-cache de um service worker: `"./Norse.otf"`. */
const RELATIVE_FILE_PATTERN = /["'](\.\/[^"'\s]+\.(?:png|jpe?g|webp|svg|ico|otf|ttf|woff2?|webmanifest))["']/g

/**
 * Encontra assets referenciados por HTML, CSS ou JavaScript, inclusive os
 * carregados sob demanda, para que "Preparar offline" copie também telas que
 * ainda não foram abertas.
 */
export function extractAssetUrls(text: string, baseUrl: string): string[] {
  const found = new Set<string>()
  for (const pattern of [ASSET_PATTERN, ROOT_FILE_PATTERN, MANIFEST_SRC_PATTERN, CSS_URL_PATTERN, RELATIVE_FILE_PATTERN]) {
    for (const match of text.matchAll(pattern)) {
      const path = match[1]
      if (path) found.add(new URL(path, baseUrl).href)
    }
  }
  return [...found]
}
