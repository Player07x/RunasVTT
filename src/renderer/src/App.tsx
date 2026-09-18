import { useCallback, useEffect, useState } from "react"
import { ArrowLeft, BookOpen, FolderOpen, Globe, Map as MapIcon, MonitorPlay, Music, Plus, ScrollText, Swords } from "lucide-react"
import type { AppInfo } from "../../shared/ipc"
import { RULESET_IDS, WORLD_TITLE_MAX_LENGTH, type RulesetId, type WorldSummary } from "../../shared/world"
import { isBrowserPreview, vtt } from "./api"

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
  { id: "browser", label: "Navegador", icon: Globe, phase: "Fase 1", description: "Runas Tools, Runas DM e Runas Book abertos aqui, funcionando offline, com a ponte para importar fichas e aplicar dano." },
  { id: "scenes", label: "Cenas", icon: MapIcon, phase: "Fase 2", description: "Lista de cenas do mundo, com mapa, grade e tokens." },
  { id: "audio", label: "Áudio", icon: Music, phase: "Fase 7", description: "Playlists com arquivos importados para o mundo." },
  { id: "log", label: "Registro", icon: ScrollText, phase: "Fase 3", description: "Testes e danos enviados pelos sites da Runas Suite." },
]

function TableShell({ world, onClose }: { world: WorldSummary; onClose: () => void }) {
  const [tab, setTab] = useState<SideTab>("browser")
  const current = SIDE_TABS.find((candidate) => candidate.id === tab) ?? SIDE_TABS[0]!
  return <main className="table">
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
      <nav className="side-tabs" aria-label="Painéis">
        {SIDE_TABS.map(({ id, label, icon: Icon }) => <button key={id} className={id === tab ? "active" : ""} onClick={() => setTab(id)} title={label} aria-label={label}><Icon size={17} /></button>)}
      </nav>
      <div className="side-content">
        <p className="eyebrow">{current.phase}</p>
        <h2>{current.label}</h2>
        <p className="muted">{current.description}</p>
        {tab === "browser" && <ul className="site-list"><li><BookOpen size={14} /> runas-tools.pages.dev</li><li><BookOpen size={14} /> runas-dm.pages.dev</li><li><BookOpen size={14} /> runas-book.pages.dev</li></ul>}
      </div>
    </aside>
  </main>
}
