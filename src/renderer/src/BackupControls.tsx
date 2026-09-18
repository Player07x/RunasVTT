import { useCallback, useEffect, useState } from "react"
import { Camera, RotateCcw, Trash2, X } from "lucide-react"
import type { SnapshotInfo, SnapshotReason } from "../../shared/ipc"
import type { WorldSummary } from "../../shared/world"
import { vtt } from "./api"

const REASON_LABELS: Record<SnapshotReason, string> = { session: "Início de sessão", manual: "Manual", "before-restore": "Antes de restaurar" }

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} KB`
  return `${(bytes / 1024 / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`
}

/** Snapshots de um mundo: o banco guardado no início de cada sessão e a pedido. */
export function SnapshotsDialog({ world, onClose }: { world: WorldSummary; onClose: () => void }) {
  const [list, setList] = useState<SnapshotInfo[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")

  const refresh = useCallback(async () => setList(await vtt.backup.snapshots(world.id)), [world.id])
  useEffect(() => { void refresh().catch((reason: unknown) => setError(String(reason))) }, [refresh])

  const run = async (action: () => Promise<string | void>) => {
    setBusy(true)
    setError("")
    setMessage("")
    try { const done = await action(); if (done) setMessage(done); await refresh() } catch (reason) { setError(reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") : String(reason)) } finally { setBusy(false) }
  }

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="snapshots-title" onKeyDown={(event) => { if (event.key === "Escape") onClose() }}>
      <header>
        <div><p className="eyebrow">{world.title}</p><h2 id="snapshots-title">Snapshots</h2></div>
        <button className="icon" aria-label="Fechar" onClick={onClose}><X size={16} /></button>
      </header>
      <div className="settings-body">
        <p className="hint">O RunasVTT guarda uma cópia do banco do mundo ao abri-lo (início de cada sessão), se algo mudou desde a última. Mapas, tokens e áudio não mudam de nome e continuam na pasta do mundo. São mantidos os 15 mais recentes.</p>
        <div className="row-actions"><button className="ghost" disabled={busy} onClick={() => void run(async () => (await vtt.backup.createSnapshot(world.id)) ? "Snapshot criado." : "Nada mudou desde o último snapshot.")}><Camera size={14} /> Criar snapshot agora</button></div>
        {list === null ? <p className="muted">Carregando…</p> : list.length === 0 ? <p className="muted">Nenhum snapshot ainda. O primeiro é criado ao abrir o mundo.</p> : <ul className="snapshot-list">
          {list.map((snapshot) => <li key={snapshot.id}>
            <div><strong>{new Date(snapshot.createdAt).toLocaleString("pt-BR")}</strong><small>{REASON_LABELS[snapshot.reason]} · {formatBytes(snapshot.bytes)}</small></div>
            <button className="ghost small" disabled={busy} onClick={() => { if (window.confirm(`Voltar "${world.title}" ao estado de ${new Date(snapshot.createdAt).toLocaleString("pt-BR")}? O estado atual vira um snapshot antes, e dá para desfazer.`)) void run(async () => { await vtt.backup.restoreSnapshot(world.id, snapshot.id); return "Mundo restaurado. O estado anterior ficou guardado como \"Antes de restaurar\"." }) }}><RotateCcw size={13} /> Restaurar</button>
            <button className="icon-toggle danger" title="Apagar snapshot" aria-label="Apagar snapshot" disabled={busy} onClick={() => { if (window.confirm("Apagar este snapshot?")) void run(() => vtt.backup.deleteSnapshot(world.id, snapshot.id)) }}><Trash2 size={13} /></button>
          </li>)}
        </ul>}
        {message && <p className="hint" role="status">{message}</p>}
        {error && <p className="error" role="alert">{error}</p>}
      </div>
    </div>
  </div>
}

