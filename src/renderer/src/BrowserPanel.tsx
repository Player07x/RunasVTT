import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { ArrowLeft, ArrowRight, CloudDownload, CloudOff, Globe, Plus, RotateCw, Wifi, WifiOff, X } from "lucide-react"
import type { BrowserState, SiteMirrorStatus } from "../../shared/ipc"
import { SUITE_SITES } from "../../shared/sites"
import { vtt } from "./api"

const EMPTY_STATE: BrowserState = {
  tabs: [],
  activeTabId: null,
  forcedOffline: false,
  sites: [],
  preparation: { running: false, siteId: null, done: 0, total: 0, failed: 0, finishedAt: null },
}

function formatBytes(bytes: number): string {
  return bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`
}

function useBrowserState(): BrowserState {
  const [state, setState] = useState<BrowserState>(EMPTY_STATE)
  useEffect(() => {
    void vtt.browser.state().then(setState)
    return vtt.browser.onState(setState)
  }, [])
  return state
}

/**
 * Reserva a área onde a aba ativa (uma `WebContentsView` nativa) aparece e
 * informa a posição ao processo principal sempre que ela muda. Ao desmontar,
 * a aba some da janela.
 */
function useNativeViewSlot(active: boolean) {
  const slot = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = slot.current
    if (!element || !active) { void vtt.browser.setBounds(null); return }
    const report = () => {
      const rect = element.getBoundingClientRect()
      void vtt.browser.setBounds({ x: rect.left, y: rect.top, width: rect.width, height: rect.height })
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(element)
    window.addEventListener("resize", report)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", report)
      void vtt.browser.setBounds(null)
    }
  }, [active])
  return slot
}

/** `suspended`: esconde a página temporariamente (ex.: enquanto o painel é redimensionado). */
export function BrowserPanel({ suspended = false }: { suspended?: boolean }) {
  const state = useBrowserState()
  const [offlineOpen, setOfflineOpen] = useState(false)
  const [newTabOpen, setNewTabOpen] = useState(false)
  const active = state.tabs.find((tab) => tab.id === state.activeTabId) ?? null
  const [address, setAddress] = useState("")
  // Painéis sobre a área da aba ficariam escondidos atrás da vista nativa:
  // enquanto um deles está aberto, a aba não é exibida.
  const showNativeView = Boolean(active) && !newTabOpen && !suspended
  const slot = useNativeViewSlot(showNativeView)

  useEffect(() => { setAddress(active?.url ?? "") }, [active?.id, active?.url])

  const activeSite = active?.siteId ? state.sites.find((site) => site.siteId === active.siteId) ?? null : null

  return <div className="browser">
    <div className="browser-tabs" role="tablist">
      {state.tabs.map((tab) => <div key={tab.id} role="tab" aria-selected={tab.id === state.activeTabId} className={`browser-tab ${tab.id === state.activeTabId ? "active" : ""}`} onClick={() => { setNewTabOpen(false); void vtt.browser.activate(tab.id) }} title={tab.url}>
        {tab.loading ? <RotateCw size={12} className="spin" /> : <Globe size={12} />}
        <span>{tab.title || "Nova aba"}</span>
        <button aria-label={`Fechar ${tab.title}`} onClick={(event) => { event.stopPropagation(); void vtt.browser.close(tab.id) }}><X size={12} /></button>
      </div>)}
      <button className={`browser-new ${newTabOpen ? "active" : ""}`} aria-label="Nova aba" title="Nova aba" onClick={() => setNewTabOpen((open) => !open)}><Plus size={15} /></button>
    </div>

    {active && !newTabOpen && <form className="browser-bar" onSubmit={(event) => { event.preventDefault(); void vtt.browser.navigate(active.id, address) }}>
      <button type="button" disabled={!active.canGoBack} aria-label="Voltar" onClick={() => void vtt.browser.command(active.id, "back")}><ArrowLeft size={15} /></button>
      <button type="button" disabled={!active.canGoForward} aria-label="Avançar" onClick={() => void vtt.browser.command(active.id, "forward")}><ArrowRight size={15} /></button>
      <button type="button" aria-label="Recarregar" onClick={() => void vtt.browser.command(active.id, "reload")}><RotateCw size={14} /></button>
      <input value={address} onChange={(event) => setAddress(event.target.value)} spellCheck={false} aria-label="Endereço" onFocus={(event) => event.currentTarget.select()} />
      {activeSite && <SourceBadge site={activeSite} forcedOffline={state.forcedOffline} />}
      <button type="button" className={offlineOpen ? "active" : ""} aria-label="Modo offline" title="Modo offline" onClick={() => setOfflineOpen((open) => !open)}><CloudDownload size={15} /></button>
    </form>}

    {(offlineOpen || !active) && !newTabOpen && <OfflineControls state={state} />}

    {newTabOpen || !active
      ? <NewTab onOpen={(url) => { setNewTabOpen(false); void vtt.browser.open(url) }} />
      : <div ref={slot} className="browser-slot" aria-label="Página" />}
  </div>
}

function SourceBadge({ site, forcedOffline }: { site: SiteMirrorStatus; forcedOffline: boolean }) {
  if (forcedOffline || site.lastSource === "mirror") return <span className="source-badge offline" title="Esta página está vindo da cópia local"><WifiOff size={12} /> Cópia local</span>
  if (site.lastSource === "unavailable") return <span className="source-badge missing" title="Sem conexão e sem cópia local"><CloudOff size={12} /> Indisponível</span>
  return <span className="source-badge online" title="Página atualizada pela internet"><Wifi size={12} /> Online</span>
}

function NewTab({ onOpen }: { onOpen: (url: string) => void }) {
  const [address, setAddress] = useState("")
  return <div className="new-tab">
    <p className="eyebrow">Runas Suite</p>
    <div className="site-buttons">
      {SUITE_SITES.map((site) => <button key={site.id} onClick={() => onOpen(site.origin)}><strong>{site.label}</strong><small>{new URL(site.origin).host}</small></button>)}
    </div>
    <form className="new-tab-address" onSubmit={(event) => { event.preventDefault(); if (address.trim()) onOpen(address) }}>
      <input value={address} onChange={(event) => setAddress(event.target.value)} placeholder="Outro endereço (ex.: youtube.com)" aria-label="Outro endereço" />
      <button className="primary" disabled={!address.trim()}>Abrir</button>
    </form>
  </div>
}

function OfflineControls({ state }: { state: BrowserState }) {
  const { preparation } = state
  const percent = preparation.total ? Math.round((preparation.done / preparation.total) * 100) : 0
  return <section className="offline-controls" aria-label="Funcionamento offline">
    <header>
      <div><strong>Funcionamento offline</strong><small>Os sites são copiados para este computador e continuam abrindo sem internet.</small></div>
      <button className="ghost" disabled={preparation.running} onClick={() => void vtt.browser.prepareOffline()}><CloudDownload size={15} /> {preparation.running ? `${percent}%` : "Preparar offline"}</button>
    </header>
    {preparation.running && <div className="progress" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${percent}%` }} /></div>}
    {!preparation.running && preparation.finishedAt && <p className={preparation.failed ? "warning" : "success"}>{preparation.failed ? `Concluído com ${preparation.failed} falha(s). Tente de novo com a internet estável.` : "Pronto: os três sites funcionam offline."}</p>}
    <ul className="mirror-list">
      {state.sites.map((site) => <li key={site.siteId}>
        <span>{site.label}</span>
        <small>{site.entries ? `${site.entries} arquivos · ${formatBytes(site.bytes)} · ${new Date(site.lastStoredAt ?? 0).toLocaleDateString("pt-BR")}` : "Sem cópia local"}</small>
      </li>)}
    </ul>
    <label className="switch">
      <input type="checkbox" checked={state.forcedOffline} onChange={(event) => void vtt.browser.setForcedOffline(event.target.checked)} />
      <span>Forçar modo offline <small>usa só a cópia local, mesmo com internet</small></span>
    </label>
  </section>
}
