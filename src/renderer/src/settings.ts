import { useEffect, useState } from "react"
import { defaultSettings, type AppSettings } from "../../shared/settings"
import { vtt } from "./api"

let cached: AppSettings | null = null
const listeners = new Set<(settings: AppSettings) => void>()
let subscribed = false

function publish(settings: AppSettings): void {
  cached = settings
  for (const listener of listeners) listener(settings)
}

function ensureLoaded(): void {
  if (subscribed) return
  subscribed = true
  vtt.settings.onChange(publish)
  void vtt.settings.get().then(publish).catch(() => undefined)
}

/** Configurações do aplicativo; os padrões valem até o processo principal responder. */
export function useSettings(): AppSettings {
  const [settings, setSettings] = useState<AppSettings>(() => cached ?? defaultSettings())
  useEffect(() => {
    ensureLoaded()
    listeners.add(setSettings)
    if (cached) setSettings(cached)
    return () => { listeners.delete(setSettings) }
  }, [])
  return settings
}

export async function saveSettings(settings: AppSettings): Promise<AppSettings> {
  const saved = await vtt.settings.set(settings)
  publish(saved)
  return saved
}
