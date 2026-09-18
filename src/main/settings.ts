import { readFile, rename, writeFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { defaultSettings, normalizeSettings, type AppSettings } from "../shared/settings"

/** Cifra usada para o Token de Acesso (o `safeStorage` do Electron em produção). */
export interface SecretCipher {
  available(): boolean
  encrypt(value: string): string
  decrypt(value: string): string
}

interface StoredSettings extends Omit<AppSettings, "accessToken"> {
  /** Token cifrado, em base64. Nunca gravado em texto puro quando há cifra disponível. */
  accessTokenEncrypted?: string
  accessToken?: string
}

/**
 * Configurações do aplicativo, fora de qualquer mundo. A gravação é atômica
 * (arquivo temporário e `rename`), como o manifesto do mundo.
 */
export class SettingsStore {
  private current: AppSettings = defaultSettings()
  private loaded = false

  constructor(private readonly path: string, private readonly cipher: SecretCipher) {}

  async get(): Promise<AppSettings> {
    if (!this.loaded) await this.load()
    return structuredClone(this.current)
  }

  async set(value: unknown): Promise<AppSettings> {
    if (!this.loaded) await this.load()
    this.current = normalizeSettings(value)
    await this.save()
    return structuredClone(this.current)
  }

  private async load(): Promise<void> {
    this.loaded = true
    let raw: StoredSettings
    try { raw = JSON.parse(await readFile(this.path, "utf8")) as StoredSettings } catch { this.current = defaultSettings(); return }
    let accessToken = typeof raw.accessToken === "string" ? raw.accessToken : ""
    if (typeof raw.accessTokenEncrypted === "string" && raw.accessTokenEncrypted) {
      try { accessToken = this.cipher.decrypt(raw.accessTokenEncrypted) } catch { accessToken = "" }
    }
    this.current = normalizeSettings({ ...raw, accessToken })
  }

  private async save(): Promise<void> {
    const { accessToken, ...rest } = this.current
    const stored: StoredSettings = { ...rest }
    if (accessToken) {
      if (this.cipher.available()) stored.accessTokenEncrypted = this.cipher.encrypt(accessToken)
      else stored.accessToken = accessToken
    }
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(stored, null, 2), "utf8")
    await rename(temporary, this.path)
  }
}
