import { describe, expect, it, vi } from "vitest"
import { BRIDGE_PROTOCOL } from "../src/shared/bridge"
import { IPC } from "../src/shared/ipc"
import { SUITE_SITES } from "../src/shared/sites"

vi.mock("electron", () => ({ contextBridge: { exposeInMainWorld: vi.fn() }, ipcRenderer: {} }))
vi.stubGlobal("location", { origin: "https://exemplo.com" })

describe("preload da ponte", () => {
  it("repete exatamente os canais, as origens e o protocolo definidos em src/shared", async () => {
    const { BRIDGE_CHANNELS, BRIDGE_ORIGINS } = await import("../src/preload/bridge")
    expect(BRIDGE_ORIGINS).toEqual(SUITE_SITES.map((site) => site.origin))
    expect(BRIDGE_CHANNELS).toEqual({
      importCharacters: IPC.bridgeImportCharacters,
      getTokens: IPC.bridgeGetTokens,
      updateTokenCharacter: IPC.bridgeUpdateTokenCharacter,
      postLog: IPC.bridgePostLog,
      tokensChanged: IPC.bridgeTokensChanged,
    })
    const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/preload/bridge.ts", import.meta.url), "utf8"))
    expect(source).toContain(`const PROTOCOL = ${BRIDGE_PROTOCOL}`)
  })

  it("não expõe a ponte fora das origens da suíte", async () => {
    const electron = await import("electron")
    expect(electron.contextBridge.exposeInMainWorld).not.toHaveBeenCalled()
  })
})
