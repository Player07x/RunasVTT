import { describe, expect, it } from "vitest"
import { releaseChecksum } from "../src/main/cloudflared"

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
