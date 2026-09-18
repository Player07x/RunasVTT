import { createHash } from "node:crypto"
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { arch, platform } from "node:process"
import { join } from "node:path"
import { spawn, type ChildProcess } from "node:child_process"

interface ReleaseAsset { name: string; executable: string }

interface ReleaseMetadata {
  body: string
  assets: { name: string; browserDownloadUrl: string }[]
}

const OFFICIAL_HOSTS = new Set([
  "api.github.com",
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
])

function assetForPlatform(): ReleaseAsset {
  const suffix = platform === "win32" ? ".exe" : ""
  if (platform === "win32" && arch === "x64") return { name: "cloudflared-windows-amd64.exe", executable: `cloudflared-windows-amd64${suffix}` }
  if (platform === "win32" && arch === "arm64") return { name: "cloudflared-windows-arm64.exe", executable: `cloudflared-windows-arm64${suffix}` }
  if (platform === "darwin" && arch === "arm64") return { name: "cloudflared-darwin-arm64", executable: "cloudflared-darwin-arm64" }
  if (platform === "darwin" && arch === "x64") return { name: "cloudflared-darwin-amd64", executable: "cloudflared-darwin-amd64" }
  if (platform === "linux" && arch === "x64") return { name: "cloudflared-linux-amd64", executable: "cloudflared-linux-amd64" }
  throw new Error(`cloudflared não tem binário pronto para ${platform}/${arch}.`)
}

function officialApiUrl(): string { return "https://api.github.com/repos/cloudflare/cloudflared/releases/latest" }

function assertOfficialUrl(value: string): URL {
  const parsed = new URL(value)
  if (parsed.protocol !== "https:" || !OFFICIAL_HOSTS.has(parsed.hostname)) throw new Error("O download do cloudflared saiu do GitHub oficial.")
  return parsed
}

async function download(url: string, redirects = 0): Promise<Buffer> {
  if (redirects > 4) throw new Error("Redirecionamentos demais ao baixar o cloudflared.")
  assertOfficialUrl(url)
  const response = await fetch(url, { redirect: "manual", headers: { "User-Agent": "RunasVTT" } })
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location")
    if (!location) throw new Error("Redirecionamento sem destino no download do cloudflared.")
    return download(assertOfficialUrl(new URL(location, url).toString()).toString(), redirects + 1)
  }
  if (!response.ok) throw new Error(`Download do cloudflared falhou (${response.status}).`)
  return Buffer.from(await response.arrayBuffer())
}

function checksum(value: Buffer): string { return createHash("sha256").update(value).digest("hex") }

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") }

/** Extrai o checksum do arquivo citado no corpo do release oficial. */
export function releaseChecksum(body: string, assetName: string): string | null {
  const match = body.match(new RegExp(`(?:^|\\n)\\s*${escapeRegex(assetName)}\\s*:\\s*([a-f0-9]{64})\\b`, "i"))
  return match?.[1]?.toLowerCase() ?? null
}

async function latestRelease(): Promise<ReleaseMetadata> {
  const response = await fetch(officialApiUrl(), {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "RunasVTT" },
  })
  if (!response.ok) throw new Error(`Metadados do release do cloudflared falharam (${response.status}).`)
  const raw = await response.json() as { body?: unknown; assets?: unknown }
  const body = typeof raw.body === "string" ? raw.body : ""
  const assets = Array.isArray(raw.assets)
    ? raw.assets.flatMap((value) => {
      if (!value || typeof value !== "object") return []
      const record = value as Record<string, unknown>
      return typeof record.name === "string" && typeof record.browser_download_url === "string"
        ? [{ name: record.name, browserDownloadUrl: record.browser_download_url }]
        : []
    })
    : []
  return { body, assets }
}

/** Baixa somente do release oficial e confere o SHA-256 publicado pelo release antes de usar. */
export async function ensureCloudflared(userData: string): Promise<string> {
  const asset = assetForPlatform()
  const directory = join(userData, "cloudflared")
  const target = join(directory, asset.executable)
  const checksumPath = `${target}.sha256`
  const release = await latestRelease()
  const metadata = release.assets.find((candidate) => candidate.name === asset.name)
  const expected = releaseChecksum(release.body, asset.name)
  if (!metadata || !expected) throw new Error(`O release oficial não publicou o checksum de ${asset.name}.`)
  const downloadUrl = assertOfficialUrl(metadata.browserDownloadUrl).toString()
  try {
    const current = await readFile(target)
    if (expected === checksum(current)) return target
  } catch { /* download abaixo */ }

  const binary = await download(downloadUrl)
  if (expected !== checksum(binary)) throw new Error("A verificação SHA-256 do cloudflared falhou; o arquivo não será executado.")
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
  const child = spawn(binary, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
  const url = new Promise<string>((resolve, reject) => {
    let output = ""
    let tunnelUrl: string | null = null
    let found = false
    // Os dois canais continuam sendo lidos depois da URL: um pipe cheio
    // bloquearia o cloudflared e derrubaria o túnel no meio da sessão.
    // A URL só é entregue depois que a conexão com a borda da Cloudflare foi
    // registrada; antes disso o endereço existe, mas ainda não atende.
    const onData = (chunk: Buffer) => {
      if (found) return
      output = `${output}${chunk.toString("utf8")}`.slice(-12000)
      tunnelUrl ??= quickTunnelUrl(output)
      if (tunnelUrl && /Registered tunnel connection/i.test(output)) { found = true; resolve(tunnelUrl) }
    }
    child.stdout?.on("data", onData)
    child.stderr?.on("data", onData)
    child.once("error", reject)
    child.once("exit", (code) => { if (!found) reject(new Error(`cloudflared encerrou antes de criar o túnel (${code ?? "sem código"}).`)) })
  })
  return { process: child, url }
}

/** Primeiro endereço de Quick Tunnel citado na saída do cloudflared. */
export function quickTunnelUrl(output: string): string | null {
  return output.match(/https:\/\/(?!api\.)[-a-z0-9]+\.trycloudflare\.com/i)?.[0] ?? null
}

/** Link que os jogadores abrem: o túnel só repassa a página se ela levar a chave da sessão. */
export function publicPlayerUrl(tunnelUrl: string, key: string): string {
  const url = new URL(tunnelUrl)
  url.pathname = "/"
  url.search = `?k=${encodeURIComponent(key)}`
  return url.toString()
}
