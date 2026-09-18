import type { NewWorldInput, WorldSummary } from "./world"

/** Canais IPC entre a interface do VTT e o processo principal. */
export const IPC = {
  appInfo: "app:info",
  listWorlds: "worlds:list",
  createWorld: "worlds:create",
  openWorld: "worlds:open",
  closeWorld: "worlds:close",
  revealWorld: "worlds:reveal",
} as const

export interface AppInfo {
  version: string
  electron: string
  worldsRoot: string
}

/**
 * API exposta à interface do VTT como `window.vtt`. Não confundir com a ponte
 * `window.runasVTT`, que só as páginas da Runas Suite recebem (ADR 0003).
 */
export interface VttApi {
  appInfo(): Promise<AppInfo>
  listWorlds(): Promise<WorldSummary[]>
  createWorld(input: NewWorldInput): Promise<WorldSummary>
  openWorld(id: string): Promise<WorldSummary>
  closeWorld(): Promise<void>
  revealWorld(id: string): Promise<void>
}
