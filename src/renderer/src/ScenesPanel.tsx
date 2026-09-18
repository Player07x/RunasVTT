import { useEffect, useRef, useState } from "react"
import { ImagePlus, Map as MapIcon, Plus, Trash2 } from "lucide-react"
import { DIAGONAL_RULES, GRID_TYPES, type DiagonalRule, type GridConfig, type GridType } from "../../shared/grid"
import { DEFAULT_GRID, type SceneData } from "../../shared/scene"
import type { WorldDocument } from "../../shared/world"
import { resolveAssetUrl } from "./api"
import { importImage } from "./canvas/SceneCanvas"
import { newId, useDocumentsVersion, type DocumentStore } from "./document-store"

const GRID_LABELS: Record<GridType, string> = { square: "Quadrada", "hex-rows": "Hexagonal (fileiras)", "hex-cols": "Hexagonal (colunas)", none: "Sem grade" }
const DIAGONAL_LABELS: Record<DiagonalRule, string> = { equidistant: "Diagonal = 1 célula", alternating: "Diagonal alterna 1 e 2", euclidean: "Distância real" }

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>
}

function CommitInput({ value, onCommit, numeric = false }: { value: string | number; onCommit: (value: string) => void; numeric?: boolean }) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = () => { if (draft !== String(value)) onCommit(draft) }
  return <input inputMode={numeric ? "decimal" : undefined} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") commit() }} />
}

const toNumber = (value: string) => Number(value.replace(",", "."))

export function ScenesPanel({ store, sceneId, onOpen }: { store: DocumentStore; sceneId: string | null; onOpen: (id: string | null) => void }) {
  useDocumentsVersion(store)
  const scenes = store.scenes()
  const current = sceneId ? store.get<SceneData>(sceneId) : null

  async function create() {
    const id = newId()
    await store.put({ id, type: "scene", parentId: null, data: { name: `Cena ${scenes.length + 1}`, width: 3000, height: 2000, grid: DEFAULT_GRID } })
    onOpen(id)
  }

  return <div className="scenes-panel">
    <header className="panel-header">
      <div><p className="eyebrow">Cenas</p><h2>{scenes.length ? `${scenes.length} ${scenes.length === 1 ? "cena" : "cenas"}` : "Nenhuma cena"}</h2></div>
      <button className="primary" onClick={() => void create()}><Plus size={15} /> Nova cena</button>
    </header>
    <ul className="scene-list">
      {scenes.map((scene) => <li key={scene.id}>
        <button className={scene.id === sceneId ? "active" : ""} onClick={() => onOpen(scene.id)}>
          {scene.data.background ? <img src={resolveAssetUrl(scene.data.background)} alt="" /> : <span className="thumb"><MapIcon size={16} /></span>}
          <span><strong>{scene.data.name}</strong><small>{Math.round(scene.data.width / (scene.data.grid.type === "none" ? 100 : scene.data.grid.size))} × {Math.round(scene.data.height / (scene.data.grid.type === "none" ? 100 : scene.data.grid.size))} {scene.data.grid.type === "none" ? "" : "células"}</small></span>
        </button>
      </li>)}
    </ul>
    {current && <SceneConfig key={current.id} scene={current} store={store} onDeleted={() => onOpen(scenes.find((scene) => scene.id !== current.id)?.id ?? null)} />}
  </div>
}

function SceneConfig({ scene, store, onDeleted }: { scene: WorldDocument<SceneData>; store: DocumentStore; onDeleted: () => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const data = scene.data
  const update = (patch: Partial<SceneData>) => void store.put({ id: scene.id, type: "scene", parentId: null, data: { ...data, ...patch } })
  const updateGrid = (patch: Partial<GridConfig>) => update({ grid: { ...data.grid, ...patch } })
  const cells = (pixels: number) => Math.round((pixels / data.grid.size) * 100) / 100

  async function chooseBackground(file: File) {
    setBusy(true)
    try {
      const image = await importImage("maps", file)
      // A cena assume o tamanho do mapa: a grade é que se ajusta a ele.
      update({ background: image.path, width: image.width, height: image.height })
    } finally {
      setBusy(false)
    }
  }

  return <section className="scene-config" aria-label="Configuração da cena">
    <Field label="Nome"><CommitInput value={data.name} onCommit={(name) => update({ name })} /></Field>
    <div className="background-picker">
      {data.background ? <img src={resolveAssetUrl(data.background)} alt="Mapa da cena" /> : <span className="empty">Sem mapa: fundo de cor sólida</span>}
      <div className="row-actions">
        <button className="ghost" disabled={busy} onClick={() => input.current?.click()}><ImagePlus size={14} /> {data.background ? "Trocar mapa" : "Escolher mapa"}</button>
        {data.background && <button className="link" onClick={() => update({ background: null })}>Remover</button>}
        <input type="color" title="Cor de fundo" value={data.backgroundColor} onChange={(event) => update({ backgroundColor: event.target.value })} />
      </div>
      <input ref={input} type="file" accept="image/*" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void chooseBackground(file) }} />
    </div>
    <div className="field-row">
      <Field label="Largura (px)"><CommitInput numeric value={data.width} onCommit={(value) => update({ width: toNumber(value) })} /></Field>
      <Field label="Altura (px)"><CommitInput numeric value={data.height} onCommit={(value) => update({ height: toNumber(value) })} /></Field>
    </div>

    <h3>Grade</h3>
    <Field label="Tipo"><select value={data.grid.type} onChange={(event) => updateGrid({ type: event.target.value as GridType })}>{GRID_TYPES.map((type) => <option key={type} value={type}>{GRID_LABELS[type]}</option>)}</select></Field>
    {data.grid.type !== "none" && <>
      <div className="field-row">
        <Field label="Tamanho da célula (px)"><CommitInput numeric value={data.grid.size} onCommit={(value) => updateGrid({ size: toNumber(value) })} /></Field>
        <Field label="Deslocamento X"><CommitInput numeric value={data.grid.offsetX} onCommit={(value) => updateGrid({ offsetX: toNumber(value) })} /></Field>
        <Field label="Deslocamento Y"><CommitInput numeric value={data.grid.offsetY} onCommit={(value) => updateGrid({ offsetY: toNumber(value) })} /></Field>
      </div>
      <small className="hint">Mapa com grade desenhada? Ajuste tamanho e deslocamento até as linhas coincidirem. Esta cena tem {cells(data.width)} × {cells(data.height)} células.</small>
    </>}
    <div className="field-row">
      <Field label="Cada célula vale"><CommitInput numeric value={data.grid.distance} onCommit={(value) => updateGrid({ distance: toNumber(value) })} /></Field>
      <Field label="Unidade"><CommitInput value={data.grid.units} onCommit={(units) => updateGrid({ units })} /></Field>
    </div>
    {data.grid.type === "square" && <Field label="Diagonais"><select value={data.grid.diagonals} onChange={(event) => updateGrid({ diagonals: event.target.value as DiagonalRule })}>{DIAGONAL_RULES.map((rule) => <option key={rule} value={rule}>{DIAGONAL_LABELS[rule]}</option>)}</select></Field>}
    {data.grid.type !== "none" && <div className="field-row">
      <Field label="Cor da grade"><input type="color" value={data.grid.color} onChange={(event) => updateGrid({ color: event.target.value })} /></Field>
      <Field label={`Opacidade: ${Math.round(data.grid.alpha * 100)}%`}><input type="range" min={0} max={1} step={0.05} value={data.grid.alpha} onChange={(event) => updateGrid({ alpha: Number(event.target.value) })} /></Field>
    </div>}

    <button className="ghost danger delete-scene" onClick={() => { if (window.confirm(`Excluir a cena "${data.name}" com todos os tokens, imagens, desenhos e notas?`)) { void store.remove(scene.id); onDeleted() } }}><Trash2 size={14} /> Excluir cena</button>
  </section>
}
