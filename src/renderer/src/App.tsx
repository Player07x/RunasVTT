import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { ArrowLeft, FolderOpen, Globe, Map as MapIcon, Maximize2, Minimize2, MonitorPlay, Music, Plus, ScrollText, Swords } from "lucide-react"
import type { AppInfo } from "../../shared/ipc"
import { RULESET_IDS, WORLD_TITLE_MAX_LENGTH, type RulesetId, type WorldSummary } from "../../shared/world"
import { isBrowserPreview, vtt } from "./api"
import { BrowserPanel } from "./BrowserPanel"

const RULESET_LABELS: Record<RulesetId, string> = { "runas-blue": "Runas", cronos: "Cronos" }

export function App() {
  const [world, setWorld] = useState<WorldSummary | null>(null)
  if (!world) return <WorldSetup onOpen={setWorld} />
  return <TableShell world={world} onClose={() => { void vtt.closeWorld(); setWorld(null) }} />
}

function WorldSetup({ onOpen }: { onOpen: (world: WorldSummary) => void }) {
  const [worlds, setWorlds] = useState<WorldSummary[] | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [title, setTitle] = useState("")
  const [rulesetId, setRulesetId] = useState<RulesetId>("runas-blue")
  const [error, setError] = useState("")

  const refresh = useCallback(async () => setWorlds(await vtt.listWorlds()), [])

  useEffect(() => {
    void refresh()
    void vtt.appInfo().then(setInfo)
  }, [refresh])

  async function open(id: string) {
    setError("")
    try { onOpen(await vtt.openWorld(id)) } catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível abrir o mundo.") }
  }

  async function create() {
    setError("")
    try {
      const created = await vtt.createWorld({ title, rulesetId })
      setTitle("")
      await open(created.id)
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível criar o mundo.") }
  }

  return <main className="setup">
    <header className="setup-brand">
      <span className="rune">R</span>
      <div><strong>RunasVTT</strong><small>Mesa virtual da Runas Suite</small></div>
    </header>
    <section className="setup-body">
      <div className="setup-copy">
        <p className="eyebrow">Seus mundos</p>
        <h1>Escolha onde a sessão acontece.</h1>
        <p>Cada mundo é uma pasta no seu computador com cenas, tokens, mapas e áudio. Tudo funciona sem internet.</p>
      </div>
      <form className="world-create" onSubmit={(event) => { event.preventDefault(); void create() }}>
        <label><span>Nome do mundo</span><input value={title} maxLength={WORLD_TITLE_MAX_LENGTH} onChange={(event) => setTitle(event.target.value)} placeholder="Ex.: Crônicas de Ordem x Caos" /></label>
        <label><span>Sistema</span><select value={rulesetId} onChange={(event) => setRulesetId(event.target.value as RulesetId)}>{RULESET_IDS.map((id) => <option key={id} value={id}>{RULESET_LABELS[id]}</option>)}</select></label>
        <button className="primary" disabled={!title.trim()}><Plus size={16} /> Criar mundo</button>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="world-list">
        {worlds === null ? <p className="muted">Carregando…</p>
          : worlds.length === 0 ? <p className="muted">Nenhum mundo ainda. Crie o primeiro acima.</p>
            : worlds.map((candidate) => <article key={candidate.id} className="world-card">
              <button className="world-open" onClick={() => void open(candidate.id)}>
                <strong>{candidate.title}</strong>
                <small>{RULESET_LABELS[candidate.rulesetId]} · aberto em {new Date(candidate.updatedAt).toLocaleString("pt-BR")}</small>
              </button>
              {!isBrowserPreview && <button className="icon" title="Mostrar pasta do mundo" aria-label="Mostrar pasta do mundo" onClick={() => void vtt.revealWorld(candidate.id)}><FolderOpen size={16} /></button>}
            </article>)}
      </div>
    </section>
    <footer className="setup-footer">
      {info && <span>Pasta dos mundos: <code>{info.worldsRoot}</code></span>}
      {info && <span>v{info.version} · Electron {info.electron}</span>}
    </footer>
  </main>
}

type SideTab = "browser" | "scenes" | "audio" | "log"

const SIDE_TABS: { id: SideTab; label: string; icon: typeof Globe; phase: string; description: string }[] = [
  { id: "browser", label: "Navegador", icon: Globe, phase: "Fase 1", description: "Runas Tools, Runas DM e Runas Book, funcionando offline." },
  { id: "scenes", label: "Cenas", icon: MapIcon, phase: "Fase 2", description: "Lista de cenas do mundo, com mapa, grade e tokens." },
  { id: "audio", label: "Áudio", icon: Music, phase: "Fase 7", description: "Playlists com arquivos importados para o mundo." },
  { id: "log", label: "Registro", icon: ScrollText, phase: "Fase 3", description: "Testes e danos enviados pelos sites da Runas Suite." },
]

const PANEL_WIDTH_KEY = "runas-vtt.side-panel-width"
const PANEL_MIN = 360
const CANVAS_MIN = 280

function readPanelWidth(): number {
  try { return Number(localStorage.getItem(PANEL_WIDTH_KEY)) || 520 } catch { return 520 }
}

function clampPanelWidth(width: number): number {
  return Math.max(PANEL_MIN, Math.min(width, window.innerWidth - CANVAS_MIN))
}

function TableShell({ world, onClose }: { world: WorldSummary; onClose: () => void }) {
  const [tab, setTab] = useState<SideTab>("browser")
  const [panelWidth, setPanelWidth] = useState(() => clampPanelWidth(readPanelWidth()))
  const [expanded, setExpanded] = useState(false)
  const dragging = useRef(false)
  const [resizing, setResizing] = useState(false)
  const current = SIDE_TABS.find((candidate) => candidate.id === tab) ?? SIDE_TABS[0]!
  const width = expanded ? window.innerWidth - CANVAS_MIN : panelWidth

  useEffect(() => {
    const onResize = () => setPanelWidth((value) => clampPanelWidth(value))
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])

  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    dragging.current = true
    setResizing(true)
    setExpanded(false)
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  function resize(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragging.current) setPanelWidth(clampPanelWidth(window.innerWidth - event.clientX))
  }
  function endResize() {
    if (!dragging.current) return
    dragging.current = false
    setResizing(false)
    try { localStorage.setItem(PANEL_WIDTH_KEY, String(panelWidth)) } catch { /* preferência opcional */ }
  }

  return <main className="table" style={{ gridTemplateColumns: `minmax(${CANVAS_MIN}px, 1fr) ${width}px` }}>
    <header className="table-bar">
      <button className="ghost" onClick={onClose}><ArrowLeft size={16} /> Mundos</button>
      <div className="table-title"><span className="rune small">R</span><strong>{world.title}</strong><small>{RULESET_LABELS[world.rulesetId]}</small></div>
      <button className="ghost" disabled title="Fase 5"><MonitorPlay size={16} /> Vista dos Jogadores</button>
    </header>
    <section className="canvas-area" aria-label="Cena">
      <div className="canvas-placeholder">
        <Swords size={28} />
        <strong>Nenhuma cena aberta</strong>
        <p>O mapa, a grade e os tokens chegam na Fase 2.</p>
      </div>
    </section>
    <aside className="side-panel">
      <div className="panel-resizer" role="separator" aria-orientation="vertical" aria-label="Redimensionar painel" onPointerDown={startResize} onPointerMove={resize} onPointerUp={endResize} onPointerCancel={endResize} />
      <nav className="side-tabs" aria-label="Painéis">
        {SIDE_TABS.map(({ id, label, icon: Icon }) => <button key={id} className={id === tab ? "active" : ""} onClick={() => setTab(id)} title={label} aria-label={label}><Icon size={17} /></button>)}
        <span className="side-tabs-spacer" />
        <button onClick={() => setExpanded((value) => !value)} title={expanded ? "Recolher painel" : "Expandir painel"} aria-label={expanded ? "Recolher painel" : "Expandir painel"}>{expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
      </nav>
      {tab === "browser" ? <BrowserPanel suspended={resizing} /> : <div className="side-content">
        <p className="eyebrow">{current.phase}</p>
        <h2>{current.label}</h2>
        <p className="muted">{current.description}</p>
      </div>}
    </aside>
  </main>
}
