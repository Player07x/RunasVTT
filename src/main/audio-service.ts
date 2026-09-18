import { falloff, type AudioState, type PlayingSound, type PlaylistData, type SoundData, type TrackData } from "../shared/audio"
import type { DocumentChange } from "../shared/ipc"
import type { SceneData, TokenData, WallData } from "../shared/scene"
import { cellPixels, isViewer, lineBlocked, sightSegments } from "../shared/vision"
import type { WorldDocument } from "../shared/world"
import type { WorldDatabase } from "./world-database"

interface PlaylistPlayback { trackId: string; key: string; startedAt: number; order: string[] }
interface OneShot { playlistId: string; trackId: string; startedAt: number }

const AUDIO_TYPES = new Set(["playlist", "track", "sound", "token", "wall", "scene"])

/**
 * Decide o que toca (Fase 7). Playlists sequenciais e aleatórias tocam uma
 * faixa por vez; a mesa de sons toca cada faixa clicada; sons posicionais
 * tocam enquanto um aliado estiver no alcance. O estado não é gravado: ao
 * reabrir o mundo, nada está tocando.
 */
export class AudioService {
  private readonly playing = new Map<string, PlaylistPlayback>()
  private readonly oneShots = new Map<string, OneShot>()
  /** Início de cada som posicional enquanto ele está audível. */
  private readonly ambient = new Map<string, number>()
  private counter = 0
  private lastKey = ""
  private state: AudioState = { now: 0, sounds: [] }

  constructor(
    private readonly database: () => WorldDatabase | null,
    private readonly sceneId: () => string | null,
    private readonly onChange: (state: AudioState) => void,
    private readonly now: () => number = Date.now,
  ) {}

  get(): AudioState {
    return { now: this.now(), sounds: this.state.sounds }
  }

  playPlaylist(playlistId: string): void {
    const playlist = this.playlist(playlistId)
    if (!playlist || playlist.data.mode === "soundboard") return
    const order = this.order(playlistId, playlist.data)
    const first = order.find((id) => this.track(id)?.data.audio)
    if (!first) return
    this.playing.set(playlistId, { trackId: first, key: this.newKey("pl"), startedAt: this.now(), order })
    this.refresh()
  }

  stopPlaylist(playlistId: string): void {
    this.playing.delete(playlistId)
    for (const [key, shot] of this.oneShots) if (shot.playlistId === playlistId) this.oneShots.delete(key)
    this.refresh()
  }

  /** Na mesa de sons, toca a faixa (de novo, se já estiver tocando); nas outras, pula para ela. */
  playTrack(trackId: string): void {
    const track = this.track(trackId)
    const playlist = track?.parentId ? this.playlist(track.parentId) : null
    if (!track?.data.audio || !playlist) return
    if (playlist.data.mode === "soundboard") {
      this.oneShots.set(this.newKey("sb"), { playlistId: playlist.id, trackId, startedAt: this.now() })
    } else {
      const current = this.playing.get(playlist.id)
      this.playing.set(playlist.id, { trackId, key: this.newKey("pl"), startedAt: this.now(), order: current?.order ?? this.order(playlist.id, playlist.data) })
    }
    this.refresh()
  }

  stopTrack(trackId: string): void {
    for (const [key, shot] of this.oneShots) if (shot.trackId === trackId) this.oneShots.delete(key)
    for (const [playlistId, playback] of this.playing) if (playback.trackId === trackId) this.playing.delete(playlistId)
    this.refresh()
  }

  stopAll(): void {
    this.playing.clear()
    this.oneShots.clear()
    this.refresh()
  }

  /** A mesa avisa que uma faixa sem loop terminou: avança a playlist ou encerra o som. */
  ended(key: string): void {
    if (this.oneShots.delete(key)) { this.refresh(); return }
    for (const [playlistId, playback] of this.playing) {
      if (playback.key !== key) continue
      const playlist = this.playlist(playlistId)
      if (!playlist) { this.playing.delete(playlistId); break }
      let order = playback.order.filter((id) => this.track(id)?.data.audio)
      const index = order.indexOf(playback.trackId)
      let next = order[index + 1]
      if (!next && playlist.data.repeat && order.length) {
        order = this.order(playlistId, playlist.data)
        next = order[0]
      }
      if (next) this.playing.set(playlistId, { trackId: next, key: this.newKey("pl"), startedAt: this.now(), order })
      else this.playing.delete(playlistId)
      break
    }
    this.refresh()
  }

  isPlaying(playlistId: string): boolean {
    return this.playing.has(playlistId) || [...this.oneShots.values()].some((shot) => shot.playlistId === playlistId)
  }

  onDocumentChange(change: DocumentChange): void {
    if (change.kind === "delete" || AUDIO_TYPES.has(change.document.type)) this.refresh()
  }

  /** A cena ouvida mudou (outra cena aberta ou transmitida). */
  sceneChanged(): void {
    this.refresh()
  }

  closeWorld(): void {
    this.playing.clear()
    this.oneShots.clear()
    this.ambient.clear()
    this.refresh()
  }

  refresh(): void {
    const sounds = this.compute()
    const key = JSON.stringify(sounds)
    this.state = { now: this.now(), sounds }
    if (key === this.lastKey) return
    this.lastKey = key
    this.onChange(this.get())
  }

  private compute(): PlayingSound[] {
    const sounds: PlayingSound[] = []
    for (const [playlistId, playback] of this.playing) {
      const playlist = this.playlist(playlistId)
      const track = this.track(playback.trackId)
      if (!playlist || !track?.data.audio) { this.playing.delete(playlistId); continue }
      // Faixa única com repetição: o próprio áudio repete, sem recomeçar a instância.
      const loop = track.data.loop || (playlist.data.repeat && playback.order.length === 1)
      sounds.push(this.sound(playback.key, playlist, track, loop, playback.startedAt))
    }
    for (const [key, shot] of this.oneShots) {
      const playlist = this.playlist(shot.playlistId)
      const track = this.track(shot.trackId)
      if (!playlist || !track?.data.audio) { this.oneShots.delete(key); continue }
      sounds.push(this.sound(key, playlist, track, track.data.loop, shot.startedAt))
    }
    sounds.push(...this.positional())
    return sounds
  }

  private sound(key: string, playlist: WorldDocument<PlaylistData>, track: WorldDocument<TrackData>, loop: boolean, startedAt: number): PlayingSound {
    const { data } = track
    return { key, audio: data.audio!, channel: playlist.data.channel, volume: round(playlist.data.volume * data.volume), loop, startedAt, fade: playlist.data.fade, label: `${playlist.data.name} · ${data.name}`, playlistId: playlist.id, trackId: track.id }
  }

  /** Sons do mapa ouvidos pelos aliados: o mais próximo decide o volume. */
  private positional(): PlayingSound[] {
    const database = this.database()
    const sceneId = this.sceneId()
    const scene = sceneId ? database?.get(sceneId) : null
    if (!database || !scene || scene.type !== "scene") { this.ambient.clear(); return [] }
    const cell = cellPixels(scene.data as SceneData)
    const listeners = (database.list("token", scene.id) as WorldDocument<TokenData>[]).map((token) => token.data).filter(isViewer)
    const walls = sightSegments((database.list("wall", scene.id) as WorldDocument<WallData>[]).map((wall) => wall.data))
    const result: PlayingSound[] = []
    const audible = new Set<string>()
    for (const document of database.list("sound", scene.id) as WorldDocument<SoundData>[]) {
      const sound = document.data
      if (sound.hidden || !sound.audio) continue
      let level = 0
      for (const listener of listeners) {
        if (sound.walls && lineBlocked(sound, listener, walls)) continue
        level = Math.max(level, falloff(Math.hypot(listener.x - sound.x, listener.y - sound.y), sound.radius * cell))
      }
      if (level <= 0) continue
      audible.add(document.id)
      const startedAt = this.ambient.get(document.id) ?? this.now()
      this.ambient.set(document.id, startedAt)
      result.push({ key: `snd:${document.id}`, audio: sound.audio, channel: "ambient", volume: round(sound.volume * level), loop: true, startedAt, fade: 1, label: "Som do mapa", playlistId: null, trackId: null })
    }
    for (const id of this.ambient.keys()) if (!audible.has(id)) this.ambient.delete(id)
    return result
  }

  private order(playlistId: string, playlist: PlaylistData): string[] {
    const ids = (this.database()?.list("track", playlistId) ?? []).map((track) => track.id)
    if (playlist.mode !== "shuffle") return ids
    for (let index = ids.length - 1; index > 0; index -= 1) {
      const other = Math.floor(Math.random() * (index + 1))
      ;[ids[index], ids[other]] = [ids[other]!, ids[index]!]
    }
    return ids
  }

  private playlist(id: string): WorldDocument<PlaylistData> | null {
    const document = this.database()?.get(id)
    return document?.type === "playlist" ? document as WorldDocument<PlaylistData> : null
  }

  private track(id: string): WorldDocument<TrackData> | null {
    const document = this.database()?.get(id)
    return document?.type === "track" ? document as WorldDocument<TrackData> : null
  }

  private newKey(prefix: string): string {
    this.counter += 1
    return `${prefix}:${this.now().toString(36)}:${this.counter}`
  }
}

const round = (value: number) => Math.round(value * 1000) / 1000
