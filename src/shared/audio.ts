import type { AssetPath } from "./scene"

/**
 * Áudio local (Fase 7): playlists com faixas importadas para o mundo e sons
 * posicionais no mapa. Quem decide o que toca é o processo principal; a mesa
 * e a Vista dos Jogadores só reproduzem o `AudioState`.
 */

export const AUDIO_CHANNELS = ["music", "ambient", "effects"] as const
export type AudioChannel = (typeof AUDIO_CHANNELS)[number]

export const PLAYLIST_MODES = ["sequential", "shuffle", "soundboard"] as const
export type PlaylistMode = (typeof PLAYLIST_MODES)[number]

export interface PlaylistData {
  name: string
  channel: AudioChannel
  /** Sequencial e aleatório tocam uma faixa por vez; a mesa de sons toca cada faixa ao clicar. */
  mode: PlaylistMode
  volume: number
  /** Fade de entrada e saída, em segundos. */
  fade: number
  /** Ao terminar a última faixa, recomeça. */
  repeat: boolean
}

export interface TrackData {
  name: string
  audio: AssetPath | null
  volume: number
  /** Repete a própria faixa sem avançar. */
  loop: boolean
}

/** Som preso a um ponto do mapa, ouvido perto dos tokens aliados. */
export interface SoundData {
  x: number
  y: number
  /** Alcance em células. */
  radius: number
  audio: AssetPath | null
  volume: number
  /** Paredes entre o som e o token abafam o som por completo. */
  walls: boolean
  /** Desligado. */
  hidden: boolean
  locked: boolean
}

/** Um som tocando agora, com o volume já combinado (sem os volumes locais do ouvinte). */
export interface PlayingSound {
  /** Identifica a instância: uma chave nova recomeça o áudio. */
  key: string
  audio: AssetPath
  channel: AudioChannel
  volume: number
  loop: boolean
  /** Início, no relógio do processo principal (ms). */
  startedAt: number
  fade: number
  label: string
  /** Origem, para o painel do mestre marcar o que está tocando; `null` nos sons do mapa. */
  playlistId: string | null
  trackId: string | null
}

export interface AudioState {
  /** Relógio do processo principal no envio, para compensar a diferença do ouvinte. */
  now: number
  sounds: PlayingSound[]
}

/** Volumes locais de quem ouve (o mestre nas configurações, cada jogador na página). */
export interface AudioMix {
  master: number
  music: number
  ambient: number
  effects: number
}

export const DEFAULT_AUDIO_MIX: AudioMix = { master: 0.8, music: 0.7, ambient: 0.8, effects: 1 }

export const CHANNEL_LABELS: Record<AudioChannel, string> = { music: "Música", ambient: "Ambiente", effects: "Efeitos" }

type Raw = Record<string, unknown>
const record = (value: unknown): Raw => (value && typeof value === "object" && !Array.isArray(value) ? value as Raw : {})
const num = (value: unknown, fallback: number, min: number, max: number) => (typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback)
const str = (value: unknown, fallback: string, max: number) => (typeof value === "string" ? value.slice(0, max) : fallback)
const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback)
const oneOf = <T extends string>(value: unknown, options: readonly T[], fallback: T): T => (typeof value === "string" && (options as readonly string[]).includes(value) ? value as T : fallback)
const AUDIO_PATH = /^audio\/[a-f0-9]{64}\.[a-z0-9]{2,5}$/
const audio = (value: unknown): AssetPath | null => (typeof value === "string" && AUDIO_PATH.test(value) ? value : null)

export function normalizePlaylist(value: unknown): PlaylistData {
  const raw = record(value)
  return {
    name: str(raw.name, "Playlist", 80).trim() || "Playlist",
    channel: oneOf(raw.channel, AUDIO_CHANNELS, "music"),
    mode: oneOf(raw.mode, PLAYLIST_MODES, "sequential"),
    volume: num(raw.volume, 0.8, 0, 1),
    fade: num(raw.fade, 2, 0, 30),
    repeat: bool(raw.repeat, true),
  }
}

export function normalizeTrack(value: unknown): TrackData {
  const raw = record(value)
  return {
    name: str(raw.name, "Faixa", 120).trim() || "Faixa",
    audio: audio(raw.audio),
    volume: num(raw.volume, 1, 0, 1),
    loop: bool(raw.loop, false),
  }
}

export function normalizeSound(value: unknown): SoundData {
  const raw = record(value)
  return {
    x: num(raw.x, 0, -1e6, 1e6),
    y: num(raw.y, 0, -1e6, 1e6),
    radius: num(raw.radius, 4, 0.5, 200),
    audio: audio(raw.audio),
    volume: num(raw.volume, 0.8, 0, 1),
    walls: bool(raw.walls, true),
    hidden: bool(raw.hidden, false),
    locked: bool(raw.locked, false),
  }
}

export function normalizeAudioMix(value: unknown): AudioMix {
  const raw = record(value)
  return {
    master: num(raw.master, DEFAULT_AUDIO_MIX.master, 0, 1),
    music: num(raw.music, DEFAULT_AUDIO_MIX.music, 0, 1),
    ambient: num(raw.ambient, DEFAULT_AUDIO_MIX.ambient, 0, 1),
    effects: num(raw.effects, DEFAULT_AUDIO_MIX.effects, 0, 1),
  }
}

/** Volume ouvido: o do som vezes o do canal e o geral de quem ouve. */
export function mixedVolume(sound: Pick<PlayingSound, "volume" | "channel">, mix: AudioMix): number {
  return Math.max(0, Math.min(1, sound.volume * mix[sound.channel] * mix.master))
}

/**
 * Posição, em segundos, em que um som deve estar agora para quem ouve.
 * `skew` = relógio local − relógio do processo principal no envio.
 * Devolve `null` se um som sem loop já terminou.
 */
export function playbackOffset(sound: Pick<PlayingSound, "startedAt" | "loop">, now: number, skew: number, duration: number | null): number | null {
  const elapsed = Math.max(0, (now - skew - sound.startedAt) / 1000)
  if (!duration || !Number.isFinite(duration) || duration <= 0) return elapsed
  if (sound.loop) return elapsed % duration
  return elapsed < duration ? elapsed : null
}

/** Queda linear do volume com a distância, até zero no raio. */
export function falloff(distance: number, radius: number): number {
  if (radius <= 0 || distance >= radius) return 0
  return 1 - distance / radius
}
