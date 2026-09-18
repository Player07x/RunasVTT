import { useEffect, useRef, useState } from "react"
import { ChevronDown, ChevronRight, ListMusic, Play, Plus, Repeat, Square, Trash2, Upload, Volume2 } from "lucide-react"
import { AUDIO_CHANNELS, CHANNEL_LABELS, PLAYLIST_MODES, type AudioMix, type AudioState, type PlaylistData, type PlaylistMode, type TrackData } from "../../shared/audio"
import type { WorldDocument } from "../../shared/world"
import { vtt } from "./api"
import { newId, useDocumentsVersion, type DocumentStore } from "./document-store"
import { saveSettings, useSettings } from "./settings"

const MODE_LABELS: Record<PlaylistMode, string> = { sequential: "Em sequência", shuffle: "Aleatória", soundboard: "Mesa de sons" }

/** Nome da faixa a partir do arquivo: sem extensão, com espaços. */
function trackName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || "Faixa"
}

export function AudioPanel({ store, audio }: { store: DocumentStore; audio: AudioState }) {
  useDocumentsVersion(store)
  const playlists = store.playlists()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [error, setError] = useState("")
  const playingPlaylists = new Set(audio.sounds.map((sound) => sound.playlistId).filter(Boolean))
  const ambientCount = audio.sounds.filter((sound) => sound.playlistId === null).length

  async function createPlaylist() {
    const id = newId()
    await store.put({ id, type: "playlist", parentId: null, data: { name: `Playlist ${playlists.length + 1}` } })
    setExpanded((current) => new Set(current).add(id))
  }

  const run = (action: () => Promise<unknown>) => { setError(""); void action().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))) }

  return <section className="audio-panel">
    <header className="panel-header">
      <div><p className="eyebrow">Fase 7</p><h2>Áudio</h2></div>
      <button className="ghost danger" disabled={audio.sounds.length === 0} onClick={() => run(() => vtt.audio.stopAll())}><Square size={13} /> Parar tudo</button>
    </header>
    <MixControls />
    {ambientCount > 0 && <p className="hint"><Volume2 size={12} /> {ambientCount} {ambientCount === 1 ? "som do mapa tocando" : "sons do mapa tocando"} perto dos aliados.</p>}
    <div className="row-actions"><button className="primary" onClick={() => run(createPlaylist)}><Plus size={15} /> Nova playlist</button></div>
    {playlists.length === 0 && <p className="muted">Crie uma playlist e adicione arquivos de áudio (MP3, OGG, WAV, M4A, FLAC, WEBM ou OPUS). Eles são copiados para a pasta do mundo e tocam sem internet.</p>}
    <ul className="playlist-list">
      {playlists.map((playlist) => <PlaylistCard key={playlist.id} playlist={playlist} store={store} audio={audio} playing={playingPlaylists.has(playlist.id)} open={expanded.has(playlist.id)} onToggle={() => setExpanded((current) => { const next = new Set(current); if (next.has(playlist.id)) next.delete(playlist.id); else next.add(playlist.id); return next })} run={run} />)}
    </ul>
    {error && <button className="scene-error" onClick={() => setError("")} role="alert">{error} ✕</button>}
  </section>
}

/** Volumes desta máquina; os jogadores ajustam os deles na própria página. */
function MixControls() {
  const settings = useSettings()
  const [mix, setMix] = useState<AudioMix>(settings.audio)
  const timer = useRef<number | null>(null)
  useEffect(() => setMix(settings.audio), [settings.audio])
  const change = (patch: Partial<AudioMix>) => {
    const next = { ...mix, ...patch }
    setMix(next)
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => { void saveSettings({ ...settings, audio: next }) }, 300)
    audioMixListeners.forEach((listener) => listener(next))
  }
  const slider = (label: string, key: keyof AudioMix) => <label className="field mix-slider"><span>{label}: {Math.round(mix[key] * 100)}%</span><input type="range" min={0} max={1} step={0.05} value={mix[key]} onChange={(event) => change({ [key]: Number(event.target.value) })} /></label>
  return <div className="mix-controls">
    {slider("Geral", "master")}
    {AUDIO_CHANNELS.map((channel) => <span key={channel}>{slider(CHANNEL_LABELS[channel], channel)}</span>)}
  </div>
}

/** O motor de áudio da mesa ouve os sliders na hora, antes de gravar. */
export const audioMixListeners = new Set<(mix: AudioMix) => void>()

function PlaylistCard({ playlist, store, audio, playing, open, onToggle, run }: { playlist: WorldDocument<PlaylistData>; store: DocumentStore; audio: AudioState; playing: boolean; open: boolean; onToggle: () => void; run: (action: () => Promise<unknown>) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(0)
  const data = playlist.data
  const tracks = store.tracks(playlist.id)
  const update = (patch: Partial<PlaylistData>) => run(() => store.put({ id: playlist.id, type: "playlist", parentId: null, data: { ...data, ...patch } }))
  const soundboard = data.mode === "soundboard"

  async function importFiles(files: File[]) {
    setImporting(files.length)
    try {
      for (const [index, file] of files.entries()) {
        const path = await vtt.assets.import("audio", file.name, new Uint8Array(await file.arrayBuffer()))
        await store.put({ id: newId(), type: "track", parentId: playlist.id, sort: Date.now() + index, data: { name: trackName(file.name), audio: path } })
        setImporting(files.length - index - 1)
      }
    } finally {
      setImporting(0)
    }
  }

  return <li className={`playlist-card ${playing ? "playing" : ""}`}>
    <div className="playlist-head">
      <button className="icon-toggle" aria-label={open ? "Recolher" : "Expandir"} onClick={onToggle}>{open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button>
      <ListMusic size={15} className="muted" />
      <CommitText value={data.name} onCommit={(name) => update({ name })} />
      <small className="muted">{CHANNEL_LABELS[data.channel]} · {tracks.length}</small>
      {!soundboard && (playing
        ? <button className="icon-toggle active" title="Parar" aria-label="Parar playlist" onClick={() => run(() => vtt.audio.stopPlaylist(playlist.id))}><Square size={13} /></button>
        : <button className="icon-toggle" title="Tocar" aria-label="Tocar playlist" disabled={!tracks.some((track) => track.data.audio)} onClick={() => run(() => vtt.audio.playPlaylist(playlist.id))}><Play size={14} /></button>)}
      {soundboard && playing && <button className="icon-toggle active" title="Parar os sons desta mesa" aria-label="Parar" onClick={() => run(() => vtt.audio.stopPlaylist(playlist.id))}><Square size={13} /></button>}
    </div>
    {open && <div className="playlist-body">
      <div className="field-row">
        <label className="field"><span>Canal</span><select value={data.channel} onChange={(event) => update({ channel: event.target.value as PlaylistData["channel"] })}>{AUDIO_CHANNELS.map((channel) => <option key={channel} value={channel}>{CHANNEL_LABELS[channel]}</option>)}</select></label>
        <label className="field"><span>Modo</span><select value={data.mode} onChange={(event) => update({ mode: event.target.value as PlaylistMode })}>{PLAYLIST_MODES.map((mode) => <option key={mode} value={mode}>{MODE_LABELS[mode]}</option>)}</select></label>
        <label className="field"><span>Fade (s)</span><input type="number" min={0} max={30} step={0.5} value={data.fade} onChange={(event) => update({ fade: Number(event.target.value) })} /></label>
      </div>
      <label className="field"><span>Volume: {Math.round(data.volume * 100)}%</span><input type="range" min={0} max={1} step={0.05} value={data.volume} onChange={(event) => update({ volume: Number(event.target.value) })} /></label>
      {!soundboard && <label className="check"><input type="checkbox" checked={data.repeat} onChange={(event) => update({ repeat: event.target.checked })} /> Recomeçar ao terminar a última faixa</label>}
      <ul className="track-list">
        {tracks.map((track) => <TrackRow key={track.id} track={track} store={store} playing={audio.sounds.some((sound) => sound.trackId === track.id)} soundboard={soundboard} run={run} />)}
      </ul>
      <div className="row-actions">
        <button className="ghost small" disabled={importing > 0} onClick={() => input.current?.click()}><Upload size={13} /> {importing > 0 ? `Importando… (${importing})` : "Adicionar faixas"}</button>
        <button className="ghost small danger" onClick={() => { if (window.confirm(`Excluir a playlist "${data.name}" e as ${tracks.length} faixas?`)) run(async () => { await vtt.audio.stopPlaylist(playlist.id); await store.remove(playlist.id) }) }}><Trash2 size={13} /> Excluir playlist</button>
      </div>
      <input ref={input} type="file" accept="audio/*,.mp3,.ogg,.wav,.m4a,.flac,.webm,.opus" multiple hidden onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ""; if (files.length) run(() => importFiles(files)) }} />
    </div>}
  </li>
}

function TrackRow({ track, store, playing, soundboard, run }: { track: WorldDocument<TrackData>; store: DocumentStore; playing: boolean; soundboard: boolean; run: (action: () => Promise<unknown>) => void }) {
  const data = track.data
  const update = (patch: Partial<TrackData>) => run(() => store.put({ id: track.id, type: "track", parentId: track.parentId, data: { ...data, ...patch } }))
  return <li className={`track-row ${playing ? "playing" : ""}`}>
    {playing && !soundboard
      ? <button className="icon-toggle active" title="Parar" aria-label="Parar faixa" onClick={() => run(() => vtt.audio.stopTrack(track.id))}><Square size={12} /></button>
      : <button className={`icon-toggle ${playing ? "active" : ""}`} title={soundboard ? "Tocar (clique de novo para sobrepor)" : "Tocar esta faixa"} aria-label="Tocar faixa" disabled={!data.audio} onClick={() => run(() => vtt.audio.playTrack(track.id))}><Play size={13} /></button>}
    <CommitText value={data.name} onCommit={(name) => update({ name })} />
    <input className="track-volume" type="range" min={0} max={1} step={0.05} value={data.volume} title={`Volume: ${Math.round(data.volume * 100)}%`} aria-label="Volume da faixa" onChange={(event) => update({ volume: Number(event.target.value) })} />
    <button className={`icon-toggle ${data.loop ? "active" : ""}`} title={data.loop ? "Repete esta faixa" : "Repetir esta faixa"} aria-label="Repetir faixa" onClick={() => update({ loop: !data.loop })}><Repeat size={13} /></button>
    <button className="icon-toggle danger" title="Excluir faixa" aria-label="Excluir faixa" onClick={() => run(async () => { await vtt.audio.stopTrack(track.id); await store.remove(track.id) })}><Trash2 size={13} /></button>
  </li>
}

function CommitText({ value, onCommit }: { value: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = () => { if (draft.trim() && draft !== value) onCommit(draft.trim()); else setDraft(value) }
  return <input className="inline-name" value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") (event.target as HTMLInputElement).blur() }} />
}
