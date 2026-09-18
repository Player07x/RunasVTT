import { useEffect, useRef, type KeyboardEvent } from "react"
import { actionForKey, PAN_ACTIONS, type KeyAction, type KeyBindings, type PanAction } from "../../../shared/settings"
import type { SceneView } from "./SceneView"

/** Direção somada das teclas de câmera seguradas. */
function panDirection(held: Set<PanAction>): { x: number; y: number } {
  let x = 0
  let y = 0
  for (const action of held) { x += PAN_ACTIONS[action][0]; y += PAN_ACTIONS[action][1] }
  return { x: Math.sign(x), y: Math.sign(y) }
}

const isPanAction = (action: KeyAction): action is PanAction => action in PAN_ACTIONS

/**
 * Teclado da cena, compartilhado com a Vista dos Jogadores: segurar uma tecla
 * de direção move a câmera; Shift + direção move a seleção uma célula (só na mesa).
 */
export function useSceneKeyboard(viewRef: { current: SceneView | null }, bindings: KeyBindings, onAction: (action: KeyAction) => void, editable: boolean) {
  const held = useRef(new Set<PanAction>())
  const release = () => { held.current.clear(); viewRef.current?.setPanDirection({ x: 0, y: 0 }) }
  useEffect(() => {
    window.addEventListener("blur", release)
    return () => window.removeEventListener("blur", release)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const onKeyDown = (event: KeyboardEvent | globalThis.KeyboardEvent) => {
    const view = viewRef.current
    if (!view || (event.target as HTMLElement).closest?.("input, select, textarea")) return
    if (event.ctrlKey || event.metaKey || event.altKey) return
    const action = actionForKey(bindings, event.code)
    if (!action) return
    event.preventDefault()
    if (isPanAction(action)) {
      if (event.shiftKey && editable) { if (!event.repeat) view.nudgeSelection(PAN_ACTIONS[action][0], PAN_ACTIONS[action][1]); return }
      held.current.add(action)
      view.setPanDirection(panDirection(held.current))
      return
    }
    if (action === "zoomIn") { view.zoomBy(1.15); return }
    if (action === "zoomOut") { view.zoomBy(1 / 1.15); return }
    if (event.repeat) return
    if (action === "fitScene") { view.fitScene(); return }
    onAction(action)
  }
  const onKeyUp = (event: KeyboardEvent | globalThis.KeyboardEvent) => {
    const action = actionForKey(bindings, event.code)
    if (!action || !isPanAction(action)) return
    held.current.delete(action)
    viewRef.current?.setPanDirection(panDirection(held.current))
  }
  return { onKeyDown, onKeyUp, onBlur: release }
}

