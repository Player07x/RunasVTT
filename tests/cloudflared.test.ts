import { describe, expect, it } from "vitest"
import { publicPlayerUrl, quickTunnelUrl, releaseChecksum } from "../src/main/cloudflared"

describe("checksum do release do cloudflared", () => {
  it("lê o SHA-256 publicado para o asset exato", () => {
    const body = [
      "### SHA256 Checksums:",
      "```",
      "cloudflared-windows-386.exe: 11b6e4b2d306950bd87e7caa4deee8e80a32d71ffee555a96237a76651eeae4c",
      "cloudflared-windows-amd64.exe: 2837888cc0f5d58f15b6dc478376de90b4d3ba5241c7947455d1e0a0df429712",
      "```",
    ].join("\n")
    expect(releaseChecksum(body, "cloudflared-windows-amd64.exe")).toBe("2837888cc0f5d58f15b6dc478376de90b4d3ba5241c7947455d1e0a0df429712")
  })

  it("não confunde um nome parecido", () => {
    expect(releaseChecksum("cloudflared-windows-amd64.exe.old: " + "a".repeat(64), "cloudflared-windows-amd64.exe")).toBeNull()
  })
})

describe("link público do Quick Tunnel", () => {
  it("encontra o endereço do túnel na saída do cloudflared", () => {
    const output = [
      "INF Requesting new quick Tunnel on trycloudflare.com...",
      "INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |",
      "INF |  https://wanna-pixel-cubic-randy.trycloudflare.com                                         |",
    ].join("\n")
    expect(quickTunnelUrl(output)).toBe("https://wanna-pixel-cubic-randy.trycloudflare.com")
  })

  it("ignora a API do trycloudflare", () => {
    expect(quickTunnelUrl("ERR failed to request https://api.trycloudflare.com/tunnel")).toBeNull()
  })

  it("leva a chave da sessão, sem a qual o servidor recusa o espectador", () => {
    expect(publicPlayerUrl("https://abc-def.trycloudflare.com", "0123abcd")).toBe("https://abc-def.trycloudflare.com/?k=0123abcd")
  })
})
