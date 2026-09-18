import { createHash } from "node:crypto"
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { arch, platform } from "node:process"
import { join } from "node:path"
import { spawn, type ChildProcess } from "node:child_process"

interface ReleaseAsset { name: string; executable: string }

function assetForPlatform(): ReleaseAsset {
  const suffix = platform === "win32" ? ".exe" : ""
  if (platform === "win32" && arch === "x64") return { name: "cloudflared-windows-amd64.exe", executable: `cloudflared-windows-amd64${suffix}` }
  if (platform === "win32" && arch === "arm64") return { name: "cloudflared-windows-arm64.exe", executable: `cloudflared-windows-arm64${suffix}` }
  if (platform === "darwin" && arch === "arm64") return { name: "cloudflared-darwin-arm64", executable: "cloudflared-darwin-arm64" }
  if (platform === "darwin" && arch === "x64") return { name: "cloudflared-darwin-amd64", executable: "cloudflared-darwin-amd64" }
  if (platform === "linux" && arch === "x64") return { name: "cloudflared-linux-amd64", executable: "cloudflared-linux-amd64" }
  throw new Error(`cloudflared não tem binário pronto para ${platform}/${arch}.`)
}

function officialUrl(asset: string): string { return `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}` }

async function download(url: string, redirects = 0): Promise<Buffer> {
  if (redirects > 4) throw new Error("Redirecionamentos demais ao baixar o cloudflared.")
  const parsed = new URL(url)
  if (parsed.hostname !== "github.com" && parsed.hostname !== "objects.githubusercontent.com") throw new Error("O download do cloudflared saiu do GitHub oficial.")
  const response = await fetch(url, { redirect: "manual" })
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location")
    if (!location) throw new Error("Redirecionamento sem destino no download do cloudflared.")
    return download(new URL(location, url).toString(), redirects + 1)
  }
  if (!response.ok) throw new Error(`Download do cloudflared falhou (${response.status}).`)
  return Buffer.from(await response.arrayBuffer())
}

function checksum(value: Buffer): string { return createHash("sha256").update(value).digest("hex") }

/** Baixa somente do release oficial e exige um sidecar SHA-256 antes de usar. */
export async function ensureCloudflared(userData: string): Promise<string> {
  const asset = assetForPlatform()
  const directory = join(userData, "cloudflared")
  const target = join(directory, asset.executable)
  const checksumPath = `${target}.sha256`
  try {
    const current = await readFile(target)
    const expected = (await readFile(checksumPath, "utf8")).trim().split(/\s+/)[0]?.toLowerCase()
    if (expected && expected === checksum(current)) return target
  } catch { /* download abaixo */ }

  const [binary, sidecar] = await Promise.all([download(officialUrl(asset.name)), download(`${officialUrl(asset.name)}.sha256`)] )
  const expected = sidecar.toString("utf8").match(/[a-f0-9]{64}/i)?.[0]?.toLowerCase()
  if (!expected || expected !== checksum(binary)) throw new Error("A verificação SHA-256 do cloudflared falhou; o arquivo não será executado.")
  await mkdir(directory, { recursive: true })
  const temporary = `${target}.download-${process.pid}`
  await writeFile(temporary, binary, { mode: 0o700 })
  await writeFile(`${temporary}.sha256`, expected, "utf8")
  await rename(temporary, target)
  await rename(`${temporary}.sha256`, checksumPath)
  if (platform !== "win32") await chmod(target, 0o700)
  return target
}

export function startCloudflared(binary: string, port: number): { process: ChildProcess; url: Promise<string> } {
  const child = spawn(binary, ["tunnel", "--url", `http://127.0.0.1:${port}`], { stdio: ["ignore", "pipe", "pipe"] })
  const url = new Promise<string>((resolve, reject) => {
    let output = ""
    const onData = (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-12000)
      const match = output.match(/https:\/\/[-a-z0-9]+\.trycloudflare\.com/i)
      if (match) { child.stdout.off("data", onData); resolve(match[0]) }
    }
    child.stdout?.on("data", onData)
    child.stderr?.on("data", onData)
    child.once("error", reject)
    child.once("exit", (code) => { if (code !== 0) reject(new Error(`cloudflared encerrou (${code ?? "sem código"}).`)) })
  })
  return { process: child, url }
}
