import { useEffect, useState } from "react"
import QRCode from "qrcode"
import { ExternalLink, KeyRound, MonitorPlay, Radio, RefreshCw, RotateCw, Square, Target, Trash2, Users, Wifi } from "lucide-react"
import type { PlayerState } from "../../shared/ipc"
import type { DocumentStore } from "./document-store"
import { useDocumentsVersion } from "./document-store"
import { vtt } from "./api"

export function PlayerPanel({ store, sceneId }: { store: DocumentStore; sceneId: string | null }) {
  useDocumentsVersion(store)
  const [state, setState] = useState<PlayerState | null>(null)
  const [port, setPort] = useState("30000")
  const [seatCount, setSeatCount] = useState("1")
  const [qr, setQr] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [copied, setCopied] = useState(false)
  const [tunneling, setTunneling] = useState(false)

  useEffect(() => {
    let mounted = true
    void vtt.player.state().then((value) => { if (mounted) { setState(value); setPort(String(value.port)) } }).catch((reason) => { if (mounted) setError(reason instanceof Error ? reason.message : String(reason)) })
    const unsubscribe = vtt.player.onState((value) => {
      if (!mounted) return
      setState((previous) => previous && value.sessionId === previous.sessionId
        ? { ...value, seats: value.seats.map((seat) => ({ ...seat, code: seat.code ?? previous.seats.find((candidate) => candidate.slotId === seat.slotId)?.code })) }
        : value)
    })
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
      <div><p className="eyebrow">Fase 10</p><h2>Vista dos Jogadores</h2></div>
      <Radio size={20} className={state?.enabled ? "player-live" : "muted"} />
    </header>
    <p className="muted">A transmissão começa com assentos individuais. Cada código libera um jogador para abrir o Runas Tools e enviar a própria ficha.</p>

    <div className="player-controls">
      <label className="field"><span>Porta local</span><input inputMode="numeric" value={port} disabled={Boolean(state?.enabled) || busy} onChange={(event) => setPort(event.target.value.replace(/\D/g, "").slice(0, 5))} /></label>
      <label className="field"><span>Jogadores</span><input inputMode="numeric" min="1" max="12" value={seatCount} disabled={Boolean(state?.enabled) || busy} onChange={(event) => setSeatCount(event.target.value.replace(/\D/g, "").slice(0, 2))} /></label>
      {!state?.enabled
        ? <button className="primary" disabled={busy || !port || !seatCount} onClick={() => void run(async () => { const next = await vtt.player.start(Number(port), Number(seatCount)); setState(next) })}><Wifi size={15} /> Ligar transmissão</button>
        : <button className="ghost danger" disabled={busy} onClick={() => void run(() => vtt.player.stop())}><Square size={14} /> Desligar</button>}
    </div>

    {state?.enabled && <>
      <div className="player-link-card">
        <div className="player-link-heading"><strong>Link para os jogadores</strong><span><Users size={14} /> {state.players} jogadores · {state.spectators} {state.spectators === 1 ? "espectador" : "espectadores"}</span></div>
        <div className="player-link-row"><input readOnly value={link} aria-label="Link da Vista dos Jogadores" /><button className="ghost small" onClick={() => { void navigator.clipboard?.writeText(link); setCopied(true); window.setTimeout(() => setCopied(false), 1600) }}>{copied ? "Copiado" : "Copiar"}</button></div>
        {qr && <img className="player-qr" src={qr} alt="QR code do link para os jogadores" />}
        <small className="hint">{state.publicUrl ? "Link público pela internet: qualquer pessoa com ele assiste à cena. Desligue a transmissão para encerrá-lo." : "O Windows pode pedir permissão de firewall na primeira vez. Todos na mesma rede abrem este link."}</small>
      </div>
      <div className="player-seats">
        <div className="player-link-heading"><strong>Assentos da sessão</strong><span><KeyRound size={14} /> {state.seats.length} {state.seats.length === 1 ? "jogador" : "jogadores"}</span></div>
        <p className="hint">Entregue um código a cada jogador. Regenerar invalida o código anterior; limpar remove a ficha anexada ao assento.</p>
        <div className="table-scroll"><table><thead><tr><th>Assento</th><th>Código</th><th>Estado</th><th>Ações</th></tr></thead><tbody>{state.seats.map((seat) => <tr key={seat.slotId}><td>{seat.label}</td><td><code>{seat.code ?? "••••••••"}</code>{seat.code && <button className="ghost small" aria-label={`Copiar código de ${seat.label}`} onClick={() => { void navigator.clipboard?.writeText(seat.code ?? "") }}>Copiar</button>}</td><td>{seat.status === "attached" ? "Ficha anexada" : seat.status === "connected" ? "Conectado" : "Disponível"}</td><td><button className="ghost small" disabled={busy} onClick={() => void run(async () => { const next = await vtt.player.rotateSeatCode(seat.slotId); setState(next) })}><RotateCw size={13} /> Regenerar</button><button className="ghost small danger" disabled={busy || (!seat.tokenId && seat.status === "available")} onClick={() => { if (window.confirm(`Limpar a ficha de ${seat.label}?`)) void run(async () => { const next = await vtt.player.clearSeat(seat.slotId); setState(next) }) }}><Trash2 size={13} /> Limpar</button></td></tr>)}</tbody></table></div>
      </div>
      <div className="player-actions"><button className="ghost" onClick={() => void run(() => vtt.player.openWindow())}><MonitorPlay size={15} /> Abrir janela local</button><button className="ghost" disabled={busy} onClick={() => { if (window.confirm("Baixar o cloudflared do release oficial da Cloudflare, verificar o SHA-256 e abrir um túnel público?")) void run(async () => { setTunneling(true); try { await vtt.player.publicLink() } finally { setTunneling(false) } }) }}><ExternalLink size={15} /> {tunneling ? "Gerando link…" : state.publicUrl ? "Gerar novo link público" : "Gerar link público"}</button></div>
      <p className="hint">O link público usa um túnel Cloudflare Quick Tunnel opcional e só é iniciado após sua confirmação.</p>
      <div className="player-config">
        <label className="field"><span>Cena transmitida</span><select value={state.sceneId ?? ""} onChange={(event) => void run(() => vtt.player.setScene(event.target.value || null))}><option value="">Cena aberta pelo mestre</option>{scenes.map((scene) => <option key={scene.id} value={scene.id}>{scene.data.name}</option>)}</select></label>
        <button className="ghost" onClick={() => void run(() => vtt.player.pullCamera())}><Target size={15} /> Puxar a câmera para o ponto do mestre</button>
        <small className="hint">Cada jogador move a própria câmera. Mover a sua não mexe na deles; este botão leva todos ao que você está vendo agora.</small>
        <label className="check"><input type="checkbox" checked={state.moves} onChange={(event) => void run(() => vtt.player.setMoves(event.target.checked))} /> Jogadores podem mover os tokens marcados como Jogador</label>
        <label className="check"><input type="checkbox" checked={state.audio} onChange={(event) => void run(() => vtt.player.setAudio(event.target.checked))} /> Tocar o áudio também para os jogadores</label>
        <label className="field"><span>Mostrar barras aos jogadores</span><select value={state.bars} onChange={(event) => void run(() => vtt.player.setBars(event.target.value as PlayerState["bars"]))}><option value="friendly">Só em Jogador e Aliado</option><option value="all">Todos os tokens</option><option value="none">Nenhuma</option></select></label>
      </div>
    </>}
    {!state?.enabled && <div className="player-offline"><RefreshCw size={16} /><span>Ligue a transmissão quando quiser compartilhar a cena. A chave de acesso muda a cada sessão.</span></div>}
    {error && <button className="scene-error" onClick={() => setError("")} role="alert">{error} ✕</button>}
    {sceneId && state?.enabled && <small className="hint">A cena aberta atualmente é usada por padrão; você pode fixar outra acima.</small>}
  </section>
}
