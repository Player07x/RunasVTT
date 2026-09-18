import { DEFAULT_AUDIO_MIX, normalizeAudioMix, type AudioMix } from "./audio"

/**
 * Configurações do aplicativo (não do mundo): atalhos de teclado e o Token de
 * Acesso dos sites da Runas Suite. Ficam em `settings.json`, na pasta de dados
 * do usuário; o token é gravado cifrado pelo processo principal.
 */

export const KEY_ACTION_GROUPS = ["Câmera", "Ferramentas", "Objetos"] as const
export type KeyActionGroup = (typeof KEY_ACTION_GROUPS)[number]

export interface KeyActionDefinition {
  id: string
  label: string
  group: KeyActionGroup
  /** Até duas teclas, como `KeyboardEvent.code` (independe do layout). */
  defaults: string[]
}

export const KEY_ACTIONS = [
  { id: "panUp", label: "Mover a câmera para cima", group: "Câmera", defaults: ["KeyW", "ArrowUp"] },
  { id: "panLeft", label: "Mover a câmera para a esquerda", group: "Câmera", defaults: ["KeyA", "ArrowLeft"] },
  { id: "panDown", label: "Mover a câmera para baixo", group: "Câmera", defaults: ["KeyS", "ArrowDown"] },
  { id: "panRight", label: "Mover a câmera para a direita", group: "Câmera", defaults: ["KeyD", "ArrowRight"] },
  { id: "zoomIn", label: "Aproximar", group: "Câmera", defaults: ["Equal", "NumpadAdd"] },
  { id: "zoomOut", label: "Afastar", group: "Câmera", defaults: ["Minus", "NumpadSubtract"] },
  { id: "fitScene", label: "Enquadrar a cena", group: "Câmera", defaults: ["Home"] },
  { id: "toolSelect", label: "Selecionar e mover", group: "Ferramentas", defaults: ["KeyV"] },
  { id: "toolRuler", label: "Régua", group: "Ferramentas", defaults: ["KeyR"] },
  { id: "toolToken", label: "Novo token", group: "Ferramentas", defaults: ["KeyT"] },
  { id: "toolDraw", label: "Desenhar", group: "Ferramentas", defaults: ["KeyP"] },
  { id: "toolNote", label: "Nota no mapa", group: "Ferramentas", defaults: ["KeyN"] },
  { id: "toolWall", label: "Paredes e portas", group: "Ferramentas", defaults: ["KeyB"] },
  { id: "toolLight", label: "Luzes", group: "Ferramentas", defaults: ["KeyL"] },
  { id: "toolSound", label: "Sons no mapa", group: "Ferramentas", defaults: ["KeyM"] },
  { id: "toolRegion", label: "Regiões", group: "Ferramentas", defaults: ["KeyG"] },
  { id: "flipToken", label: "Espelhar o token", group: "Objetos", defaults: ["KeyF"] },
  { id: "toggleHidden", label: "Ocultar/mostrar aos jogadores", group: "Objetos", defaults: ["KeyH"] },
  { id: "deleteSelection", label: "Excluir a seleção", group: "Objetos", defaults: ["Delete", "Backspace"] },
  { id: "cancel", label: "Cancelar e soltar a seleção", group: "Objetos", defaults: ["Escape"] },
] as const satisfies readonly KeyActionDefinition[]

export type KeyAction = (typeof KEY_ACTIONS)[number]["id"]
export type KeyBindings = Record<KeyAction, string[]>

export const PAN_ACTIONS = { panUp: [0, -1], panDown: [0, 1], panLeft: [-1, 0], panRight: [1, 0] } as const satisfies Partial<Record<KeyAction, readonly [number, number]>>
export type PanAction = keyof typeof PAN_ACTIONS

export interface AppSettings {
  keyBindings: KeyBindings
  /** Velocidade da câmera pelo teclado, em pixels da tela por segundo. */
  panSpeed: number
  /** Chave de acesso preenchida automaticamente nos sites da Runas Suite. */
  accessToken: string
  /** Volumes do áudio nesta máquina (os jogadores têm os próprios, na página). */
  audio: AudioMix
}

export const PAN_SPEED = { min: 200, max: 4000, default: 1000 } as const
export const ACCESS_TOKEN_MAX_LENGTH = 512
export const MAX_KEYS_PER_ACTION = 2

export function defaultKeyBindings(): KeyBindings {
  return Object.fromEntries(KEY_ACTIONS.map((action) => [action.id, [...action.defaults]])) as KeyBindings
}

export function defaultSettings(): AppSettings {
  return { keyBindings: defaultKeyBindings(), panSpeed: PAN_SPEED.default, accessToken: "", audio: { ...DEFAULT_AUDIO_MIX } }
}

const KEY_CODE = /^[A-Za-z][A-Za-z0-9]{1,30}$/

/**
 * Normaliza atalhos gravados: ações desconhecidas somem, ações novas ganham o
 * padrão e uma tecla nunca fica em duas ações (a primeira ação da lista vence).
 */
export function normalizeKeyBindings(value: unknown): KeyBindings {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const used = new Set<string>()
  const bindings = {} as KeyBindings
  for (const action of KEY_ACTIONS) {
    const stored = raw[action.id]
    const keys = Array.isArray(stored) ? stored.filter((code): code is string => typeof code === "string" && KEY_CODE.test(code)) : [...action.defaults]
    bindings[action.id] = keys.filter((code) => !used.has(code)).slice(0, MAX_KEYS_PER_ACTION)
    for (const code of bindings[action.id]) used.add(code)
  }
  return bindings
}

export function normalizeSettings(value: unknown): AppSettings {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const panSpeed = typeof raw.panSpeed === "number" && Number.isFinite(raw.panSpeed) ? Math.round(Math.min(PAN_SPEED.max, Math.max(PAN_SPEED.min, raw.panSpeed))) : PAN_SPEED.default
  const accessToken = typeof raw.accessToken === "string" ? raw.accessToken.trim().slice(0, ACCESS_TOKEN_MAX_LENGTH) : ""
  return { keyBindings: normalizeKeyBindings(raw.keyBindings), panSpeed, accessToken, audio: normalizeAudioMix(raw.audio) }
}

/** Grava `code` em `action`, tirando a tecla de qualquer outra ação. */
export function bindKey(bindings: KeyBindings, action: KeyAction, slot: number, code: string): KeyBindings {
  const next = Object.fromEntries(Object.entries(bindings).map(([id, keys]) => [id, keys.filter((key) => key !== code)])) as KeyBindings
  const keys = [...next[action]]
  if (slot < keys.length) keys[slot] = code
  else keys.push(code)
  next[action] = keys.slice(0, MAX_KEYS_PER_ACTION)
  return next
}

export function unbindKey(bindings: KeyBindings, action: KeyAction, slot: number): KeyBindings {
  return { ...bindings, [action]: bindings[action].filter((_, index) => index !== slot) }
}

/** Ação ligada a uma tecla, ou `null`. */
export function actionForKey(bindings: KeyBindings, code: string): KeyAction | null {
  for (const action of KEY_ACTIONS) if (bindings[action.id].includes(code)) return action.id
  return null
}

const KEY_NAMES: Record<string, string> = {
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
  Space: "Espaço", Escape: "Esc", Enter: "Enter", Backspace: "Backspace", Delete: "Delete", Tab: "Tab",
  Home: "Home", End: "End", PageUp: "PgUp", PageDown: "PgDn", Insert: "Insert",
  Equal: "=", Minus: "-", Comma: ",", Period: ".", Slash: "/", Semicolon: "ç", Quote: "~", BracketLeft: "´", BracketRight: "[", Backslash: "]", Backquote: "'", IntlBackslash: "\\", IntlRo: "/",
  NumpadAdd: "Num +", NumpadSubtract: "Num -", NumpadMultiply: "Num *", NumpadDivide: "Num /", NumpadEnter: "Num Enter", NumpadDecimal: "Num ,",
}

/** Nome curto de uma tecla (`KeyboardEvent.code`) para a interface. */
export function keyLabel(code: string): string {
  if (KEY_NAMES[code]) return KEY_NAMES[code]!
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^Numpad[0-9]$/.test(code)) return `Num ${code.slice(6)}`
  return code
}

/** Teclas que não podem virar atalho (modificadores sozinhos). */
export function isBindableKey(code: string): boolean {
  return KEY_CODE.test(code) && !/^(Shift|Control|Alt|Meta|OS|CapsLock|NumLock|ScrollLock|Fn)/.test(code)
}
