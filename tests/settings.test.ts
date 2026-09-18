import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { SettingsStore, type SecretCipher } from "../src/main/settings"
import { actionForKey, bindKey, defaultKeyBindings, defaultSettings, keyLabel, KEY_ACTIONS, normalizeKeyBindings, normalizeSettings, unbindKey } from "../src/shared/settings"

describe("atalhos de teclado", () => {
  it("WASD e as setas movem a câmera, e nenhuma tecla padrão fica em duas ações", () => {
    const bindings = defaultKeyBindings()
    expect(bindings.panUp).toEqual(["KeyW", "ArrowUp"])
    expect(bindings.panRight).toEqual(["KeyD", "ArrowRight"])
    expect(bindings.flipToken).toEqual(["KeyF"])
    const all = KEY_ACTIONS.flatMap((action) => bindings[action.id])
    expect(new Set(all).size).toBe(all.length)
    expect(actionForKey(bindings, "KeyD")).toBe("panRight")
  })

  it("gravar uma tecla tira ela da ação anterior", () => {
    const next = bindKey(defaultKeyBindings(), "toolRuler", 0, "KeyW")
    expect(next.toolRuler).toEqual(["KeyW"])
    expect(next.panUp).toEqual(["ArrowUp"])
    expect(actionForKey(next, "KeyW")).toBe("toolRuler")
    expect(unbindKey(next, "panUp", 0).panUp).toEqual([])
  })

  it("normaliza o que foi gravado: ações novas ganham o padrão e duplicatas somem", () => {
    const bindings = normalizeKeyBindings({ panUp: ["KeyQ"], panDown: ["KeyQ", "KeyS"], inexistente: ["KeyZ"], toolRuler: ["<script>"] })
    expect(bindings.panUp).toEqual(["KeyQ"])
    expect(bindings.panDown).toEqual(["KeyS"])
    expect(bindings.toolRuler).toEqual([])
    expect(bindings.flipToken).toEqual(["KeyF"])
    expect("inexistente" in bindings).toBe(false)
  })

  it("mostra nomes curtos das teclas", () => {
    expect(keyLabel("KeyW")).toBe("W")
    expect(keyLabel("ArrowLeft")).toBe("←")
    expect(keyLabel("Digit3")).toBe("3")
  })

  it("limita a velocidade da câmera e o tamanho do token", () => {
    expect(normalizeSettings({ panSpeed: 99999 }).panSpeed).toBe(4000)
    expect(normalizeSettings({ panSpeed: "rápido" }).panSpeed).toBe(defaultSettings().panSpeed)
    expect(normalizeSettings({ accessToken: `  ${"x".repeat(600)}  ` }).accessToken).toHaveLength(512)
  })
})

describe("SettingsStore", () => {
  let root = ""
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }) })

  const cipher: SecretCipher = {
    available: () => true,
    encrypt: (value) => Buffer.from([...value].reverse().join(""), "utf8").toString("base64"),
    decrypt: (value) => [...Buffer.from(value, "base64").toString("utf8")].reverse().join(""),
  }

  it("grava o Token de Acesso cifrado e lê de volta", async () => {
    root = await mkdtemp(join(tmpdir(), "runas-vtt-settings-"))
    const path = join(root, "settings.json")
    const store = new SettingsStore(path, cipher)
    await store.set({ ...defaultSettings(), accessToken: "segredo-da-mesa" })
    const file = await readFile(path, "utf8")
    expect(file).not.toContain("segredo-da-mesa")
    expect(file).toContain("accessTokenEncrypted")
    expect((await new SettingsStore(path, cipher).get()).accessToken).toBe("segredo-da-mesa")
  })

  it("começa com os padrões quando não há arquivo", async () => {
    root = await mkdtemp(join(tmpdir(), "runas-vtt-settings-"))
    expect(await new SettingsStore(join(root, "settings.json"), cipher).get()).toEqual(defaultSettings())
  })
})
