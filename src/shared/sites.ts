/**
 * Sites da Runas Suite abertos no navegador integrado (ADR 0002).
 *
 * `warmupPaths` são as rotas copiadas por "Preparar offline"; os assets que
 * elas referenciam são descobertos automaticamente.
 */
export interface SuiteSite {
  id: "tools" | "dm" | "book"
  label: string
  origin: string
  warmupPaths: string[]
}

export const SUITE_SITES: readonly SuiteSite[] = [
  {
    id: "tools",
    label: "Runas Tools",
    origin: "https://runas-tools.pages.dev",
    warmupPaths: ["/", "/calculadora-dano/", "/calculadora-testes/", "/galeria-personagens/", "/cartas-runicas/", "/manifest.webmanifest", "/sw.js"],
  },
  {
    id: "dm",
    label: "Runas DM",
    origin: "https://runas-dm.pages.dev",
    warmupPaths: ["/", "/?view=encounter", "/campaigns", "/wiki", "/manifest.webmanifest", "/sw.js"],
  },
  {
    id: "book",
    label: "Runas Book",
    origin: "https://runas-book.pages.dev",
    warmupPaths: ["/", "/dm/", "/manifest.webmanifest"],
  },
]

export type SuiteSiteId = SuiteSite["id"]

export function suiteSiteFor(url: string): SuiteSite | null {
  try {
    const origin = new URL(url).origin
    return SUITE_SITES.find((site) => site.origin === origin) ?? null
  } catch {
    return null
  }
}
