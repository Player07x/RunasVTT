import { useEffect, useState } from "react"
import QRCode from "qrcode"
import { ExternalLink, MonitorPlay, Radio, RefreshCw, Square, Target, Users, Wifi } from "lucide-react"
import type { PlayerState } from "../../shared/ipc"
import type { DocumentStore } from "./document-store"
import { useDocumentsVersion } from "./document-store"
import { vtt } from "./api"

export function PlayerPanel({ store, sceneId }: { store: DocumentStore; sceneId: string | null }) {
  useDocumentsVersion(store)
  const [state, setState] = useState<PlayerState | null>(null)
  const [port, setPort] = useState("30000")
  const [qr, setQr] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [copied, setCopied] = useState(false)
  const [tunneling, setTunneling] = useState(false)

  useEffect(() => {
    let mounted = true
    void vtt.player.state().then((value) => { if (mounted) { setState(value); setPort(String(value.port)) } }).catch((reason) => { if (mounted) setError(reason instanceof Error ? reason.message : String(reason)) })
    const unsubscribe = vtt.player.onState((value) => { if (mounted) setState(value) })
    return () => { mounted = false; unsubscribe() }
  }, [])

  useEffect(() => {
    const url = state?.publicUrl ?? state?.localUrl
    if (!url) { setQr(""); return }
    void QRCode.toDataURL(url, { width: 220, margin: 1, errorCorrectionLevel: "M" }).then(setQr).catch(() => setQr(""))
  }, [state?.localUrl, state?.publicUrl])

  async function run(action: () => Promise<unknown>) {
    setError("")
    setBusy(true)
    try { await action() } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) } finally { setBusy(false) }
  }

  const scenes = store.scenes()
  const link = state?.publicUrl ?? state?.localUrl ?? ""

  return <section className="player-panel">
    <header className="panel-header">
      <div><p className="eyebrow">Fase 5</p><h2>Vista dos Jogadores</h2></div>
      <Radio size={20} className={state?.enabled ? "player-live" : "muted"} />
    </header>
    <p className="muted">Uma página web somente leitura. O mestre continua sendo o único que opera a mesa.</p>

    <div className="player-controls">
      <label className="field"><span>Porta local</span><input inputMode="numeric" value={port} disabled={Boolean(state?.enabled) || busy} onChange={(event) => setPort(event.target.value.replace(/\D/g, "").slice(0, 5))} /></label>
      {!state?.enabled
        ? <button className="primary" disabled={busy || !port} onClick={() => void run(async () => { await vtt.player.start(Number(port)); })}><Wifi size={15} /> Ligar transmissão</button>
        : <button className="ghost danger" disabled={busy} onClick={() => void run(() => vtt.player.stop())}><Square size={14} /> Desligar</button>}
    </div>

    {state?.enabled && <>
      <div className="player-link-card">
        <div className="player-link-heading"><strong>Link para os jogadores</strong><span><Users size={14} /> {state.spectators} {state.spectators === 1 ? "espectador" : "espectadores"}</span></div>
        <div className="player-link-row"><input readOnly value={link} aria-label="Link da Vista dos Jogadores" /><button className="ghost small" onClick={() => { void navigator.clipboard?.writeText(link); setCopied(true); window.setTimeout(() => setCopied(false), 1600) }}>{copied ? "Copiado" : "Copiar"}</button></div>
        {qr && <img className="player-qr" src={qr} alt="QR code do link para os jogadores" />}
        <small className="hint">{state.publicUrl ? "Link público pela internet: qualquer pessoa com ele assiste à cena. Desligue a transmissão para encerrá-lo." : "O Windows pode pedir permissão de firewall na primeira vez. Todos na mesma rede abrem este link."}</small>
      </div>
      <div className="player-actions"><button className="ghost" onClick={() => void run(() => vtt.player.openWindow())}><MonitorPlay size={15} /> Abrir janela local</button><button className="ghost" disabled={busy} onClick={() => { if (window.confirm("Baixar o cloudflared do release oficial da Cloudflare, verificar o SHA-256 e abrir um túnel público?")) void run(async () => { setTunneling(true); try { await vtt.player.publicLink() } finally { setTunneling(false) } }) }}><ExternalLink size={15} /> {tunneling ? "Gerando link…" : state.publicUrl ? "Gerar novo link público" : "Gerar link público"}</button></div>
      <p className="hint">O link público usa um túnel Cloudflare Quick Tunnel opcional e só é iniciado após sua confirmação.</p>
      <div className="player-config">
        <label className="field"><span>Cena transmitida</span><select value={state.sceneId ?? ""} onChange={(event) => void run(() => vtt.player.setScene(event.target.value || null))}><option value="">Cena aberta pelo mestre</option>{scenes.map((scene) => <option key={scene.id} value={scene.id}>{scene.data.name}</option>)}</select></label>
        <button className="ghost" onClick={() => void run(() => vtt.player.pullCamera())}><Target size={15} /> Puxar a câmera para o ponto do mestre</button>
        <small className="hint">Cada jogador move a própria câmera. Mover a sua não mexe na deles; este botão leva todos ao que você está vendo agora.</small>
        <label className="check"><input type="checkbox" checked={state.audio} onChange={(event) => void run(() => vtt.player.setAudio(event.target.checked))} /> Tocar o áudio também para os jogadores</label>
        <label className="field"><span>Mostrar barras aos jogadores</span><select value={state.bars} onChange={(event) => void run(() => vtt.player.setBars(event.target.value as PlayerState["bars"]))}><option value="friendly">Só nos aliados</option><option value="all">Todos os tokens</option><option value="none">Nenhuma</option></select></label>
      </div>
    </>}
    {!state?.enabled && <div className="player-offline"><RefreshCw size={16} /><span>Ligue a transmissão quando quiser compartilhar a cena. A chave de acesso muda a cada sessão.</span></div>}
    {error && <button className="scene-error" onClick={() => setError("")} role="alert">{error} ✕</button>}
    {sceneId && state?.enabled && <small className="hint">A cena aberta atualmente é usada por padrão; você pode fixar outra acima.</small>}
  </section>
}
