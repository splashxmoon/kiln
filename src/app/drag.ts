/**
 * Pointer-based drag for file cards: no HTML5 drag API, so no native ghost image.
 * A small floating card follows the pointer, and the drop target under it (any element
 * with data-drop) gets the `is-drop-over` class. Releasing over a target calls onDrop.
 */
import type { PointerEvent as ReactPointerEvent } from 'react'

const MOVE_AFTER_PX = 6
let justEnded = false

/** True for the click that follows a drag, so releasing a dragged card doesn't open it. */
export function justDragged(): boolean {
  return justEnded
}

export function startCardDrag(e: ReactPointerEvent<HTMLElement>, label: string, onDrop: (dropId: string) => void) {
  if (e.button !== 0) return
  // a press on a button or a menu (portalled menus bubble through React) is not a drag
  const from = e.target as Element
  if (from.closest('button, .k-menu')) return

  const sx = e.clientX
  const sy = e.clientY
  let ghost: HTMLDivElement | null = null
  let over: Element | null = null

  const move = (ev: PointerEvent) => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < MOVE_AFTER_PX) return
      ghost = document.createElement('div')
      ghost.className = 'k-drag-ghost'
      ghost.textContent = label
      document.body.appendChild(ghost)
      document.body.classList.add('is-dragging-card')
    }
    ghost.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 10}px)`
    const hit = (document.elementFromPoint(ev.clientX, ev.clientY) as Element | null)?.closest('[data-drop]') ?? null
    if (hit !== over) {
      over?.classList.remove('is-drop-over')
      hit?.classList.add('is-drop-over')
      over = hit
    }
  }

  const finish = (drop: boolean) => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', cancel)
    if (!ghost) return
    ghost.remove()
    document.body.classList.remove('is-dragging-card')
    over?.classList.remove('is-drop-over')
    justEnded = true
    window.setTimeout(() => (justEnded = false), 0)
    const target = drop ? over?.getAttribute('data-drop') : null
    if (target) onDrop(target)
  }
  const up = () => finish(true)
  const cancel = () => finish(false)

  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', cancel)
}
