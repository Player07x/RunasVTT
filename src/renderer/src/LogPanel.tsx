import { useState } from "react"
import { Dices, Info, Swords, Trash2 } from "lucide-react"
import type { LogKind } from "../../shared/bridge"
import { useDocumentsVersion, type DocumentStore } from "./document-store"
import { vtt } from "./api"

const KIND: Record<LogKind, { label: string; icon: typeof Dices; className: string }> = {
  test: { label: "Teste", icon: Dices, className: "test" },
  damage: { label: "Dano", icon: Swords, className: "damage" },
  info: { label: "Aviso", icon: Info, className: "info" },
}

/** Testes e danos enviados pelos sites da suíte, do mais recente ao mais antigo. */
export function LogPanel({ store }: { store: DocumentStore }) {
  useDocumentsVersion(store)
  const [clearing, setClearing] = useState(false)
  const entries = store.logs()

  /**
   * O Registro cresce a sessão inteira e nada o poda sozinho. A limpeza sai
   * numa única mudança (`clearLog`), para não republicar a projeção uma vez
   * por entrada apagada com a transmissão ligada.
   */
  async function clear() {
    if (!window.confirm(`Apagar as ${entries.length} entradas do Registro? Isso não pode ser desfeito.`)) return
    setClearing(true)
    try { await vtt.documents.clearLog() } finally { setClearing(false) }
  }

  return <div className="log-panel">
    <header className="panel-header">
      <div><p className="eyebrow">Registro</p><h2>{entries.length ? `${entries.length} ${entries.length === 1 ? "entrada" : "entradas"}` : "Nada registrado"}</h2></div>
      {entries.length > 0 && <button type="button" className="ghost danger small" disabled={clearing} onClick={() => void clear()} title="Apagar todas as entradas do Registro"><Trash2 size={14} /> Limpar</button>}
    </header>
    {entries.length === 0 && <p className="hint">Testes e danos feitos no Runas DM, dentro do navegador integrado, aparecem aqui e sobre o token na cena.</p>}
    <ol className="log-list">
      {entries.map((entry) => {
        const kind = KIND[entry.data.kind]
        const Icon = kind.icon
        return <li key={entry.id} className={kind.className}>
          <span className="log-icon" title={kind.label}><Icon size={14} /></span>
          <div>
            <header><strong>{entry.data.title}</strong><time>{new Date(entry.createdAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</time></header>
            {entry.data.tokenName && <small className="log-token">{entry.data.tokenName}</small>}
            {entry.data.detail && <p>{entry.data.detail}</p>}
          </div>
        </li>
      })}
    </ol>
  </div>
}
