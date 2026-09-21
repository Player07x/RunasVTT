import { mixedVolume, playbackOffset, type AudioMix, type AudioState, type PlayingSound } from "../../shared/audio"
import type { AssetPath } from "../../shared/scene"

interface Voice {
  sound: PlayingSound
  element: HTMLAudioElement
  /** Volume atual e alvo (0 a 1, já com os volumes locais). */
  level: number
  target: number
  /** Velocidade da rampa, em unidades de volume por segundo. */
  rate: number
  stopping: boolean
}

/** Sem fade configurado, uma rampa curta evita estalos. */
const MIN_RAMP_SECONDS = 0.15
/** Diferença tolerada entre a posição da faixa e a do VTT antes de reposicionar. */
const RESYNC_SECONDS = 1.5

/**
 * Reproduz o `AudioState` do processo principal. Cada som vira um
 * `<audio>`; o volume sobe e desce em rampa (fade), e a posição é calculada
 * pelo relógio do VTT, então quem entra depois ouve do mesmo ponto.
 */
export class AudioEngine {
  private readonly voices = new Map<string, Voice>()
  private mix: AudioMix
  private skew = 0
  private timer: number | null = null
  private unlocked: boolean
  private last = performance.now()
  /** Uma faixa sem loop terminou (só a mesa do mestre avisa o processo principal). */
  onEnded: ((key: string) => void) | null = null
  /** O navegador recusou tocar sem um clique (página dos jogadores). */
  onBlocked: (() => void) | null = null

  constructor(private readonly resolve: (path: AssetPath) => string, mix: AudioMix, unlocked = true) {
    this.mix = mix
    this.unlocked = unlocked
  }

  setMix(mix: AudioMix): void {
    this.mix = mix
    for (const voice of this.voices.values()) if (!voice.stopping) this.retarget(voice, voice.sound, MIN_RAMP_SECONDS)
  }

  /** Depois de um clique do usuário: libera a reprodução e retoma os sons. */
  unlock(): void {
    this.unlocked = true
    for (const voice of this.voices.values()) this.start(voice)
  }

  apply(state: AudioState | null): void {
    const sounds = state?.sounds ?? []
    if (state) this.skew = Date.now() - state.now
    const wanted = new Set(sounds.map((sound) => sound.key))
    for (const [key, voice] of this.voices) if (!wanted.has(key) && !voice.stopping) this.stop(voice)
    for (const sound of sounds) {
      const voice = this.voices.get(sound.key)
      if (voice) { voice.sound = sound; if (!voice.stopping) this.retarget(voice, sound, MIN_RAMP_SECONDS); continue }
      this.create(sound)
    }
    this.ensureTicking()
  }

  destroy(): void {
    if (this.timer !== null) window.clearInterval(this.timer)
    this.timer = null
    for (const voice of this.voices.values()) this.release(voice)
    this.voices.clear()
  }

  private create(sound: PlayingSound): void {
    const element = new Audio()
    element.preload = "auto"
    element.loop = sound.loop
    element.volume = 0
    element.src = this.resolve(sound.audio)
    const voice: Voice = { sound, element, level: 0, target: 0, rate: 1, stopping: false }
    this.voices.set(sound.key, voice)
    const finish = () => {
      if (!this.voices.has(sound.key)) return
      this.release(voice)
      this.voices.delete(sound.key)
      this.onEnded?.(sound.key)
    }
    element.addEventListener("ended", finish)
    // Sem isto, um arquivo ilegível (ou uma resposta truncada) emudece a faixa
    // para sempre: `ended` nunca chega, a playlist não avança e o loop não reinicia.
    element.addEventListener("error", finish)
    element.addEventListener("loadedmetadata", () => this.seek(voice), { once: true })
    this.retarget(voice, sound, sound.fade)
    this.start(voice)
  }

  private start(voice: Voice): void {
    if (!this.unlocked || voice.stopping) return
    // Liberado depois (clique do jogador): alcança o ponto atual da faixa.
    if (voice.element.readyState >= HTMLMediaElement.HAVE_METADATA) this.seek(voice)
    if (!this.voices.has(voice.sound.key)) return
    void voice.element.play().catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "NotAllowedError") { this.unlocked = false; this.onBlocked?.() }
    })
  }

  /** Posiciona a faixa onde o VTT diz que ela está agora. */
  private seek(voice: Voice): void {
    const duration = Number.isFinite(voice.element.duration) ? voice.element.duration : null
    const offset = playbackOffset(voice.sound, Date.now(), this.skew, duration)
    if (offset === null) {
      // Um som sem loop que já terminou para os outros não toca atrasado aqui.
      this.release(voice)
      this.voices.delete(voice.sound.key)
      this.onEnded?.(voice.sound.key)
      return
    }
    if (Math.abs(voice.element.currentTime - offset) > RESYNC_SECONDS) voice.element.currentTime = offset
  }

  private retarget(voice: Voice, sound: PlayingSound, seconds: number): void {
    voice.target = mixedVolume(sound, this.mix)
    voice.rate = Math.max(Math.abs(voice.target - voice.level), 0.01) / Math.max(seconds, MIN_RAMP_SECONDS)
    voice.element.loop = sound.loop
  }

  private stop(voice: Voice): void {
    voice.stopping = true
    voice.target = 0
    voice.rate = Math.max(voice.level, 0.01) / Math.max(voice.sound.fade, MIN_RAMP_SECONDS)
  }

  private release(voice: Voice): void {
    voice.element.pause()
    voice.element.removeAttribute("src")
    voice.element.load()
  }

  private ensureTicking(): void {
    if (this.timer !== null || this.voices.size === 0) return
    this.last = performance.now()
    this.timer = window.setInterval(() => this.tick(), 50)
  }

  private tick(): void {
    const now = performance.now()
    const elapsed = (now - this.last) / 1000
    this.last = now
    for (const [key, voice] of this.voices) {
      const step = voice.rate * elapsed
      voice.level = voice.level < voice.target ? Math.min(voice.target, voice.level + step) : Math.max(voice.target, voice.level - step)
      voice.element.volume = Math.max(0, Math.min(1, voice.level))
      if (voice.stopping && voice.level <= 0) { this.release(voice); this.voices.delete(key) }
    }
    if (this.voices.size === 0 && this.timer !== null) { window.clearInterval(this.timer); this.timer = null }
  }
}
