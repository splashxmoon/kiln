/**
 * Anchored floating surface used by every Kiln dropdown, picker and menu.
 * Renders into <body> (fixed positioning), flips when it would overflow the
 * viewport, and closes on outside press / Escape without letting the key
 * reach the editor's shortcut handler.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { createPortal } from 'react-dom'

export type Placement = 'bottom-start' | 'bottom-end' | 'top-start' | 'left-start' | 'right-start'

export type Anchor = HTMLElement | { x: number; y: number } | null

const elIds = new WeakMap<HTMLElement, number>()
let nextElId = 1
function anchorKey(a: Anchor): string {
  if (!a) return 'none'
  if (a instanceof HTMLElement) {
    if (!elIds.has(a)) elIds.set(a, nextElId++)
    return 'el' + elIds.get(a)
  }
  return a.x + ',' + a.y
}

function anchorRect(a: Anchor): DOMRect | null {
  if (!a) return null
  if (a instanceof HTMLElement) return a.getBoundingClientRect()
  return new DOMRect(a.x, a.y, 0, 0)
}

export function Popover({
  anchor,
  open,
  onClose,
  placement = 'bottom-start',
  offset = 6,
  matchWidth,
  className = '',
  style,
  children,
  role,
  label,
}: {
  anchor: Anchor
  open: boolean
  onClose: () => void
  placement?: Placement
  offset?: number
  matchWidth?: boolean
  className?: string
  style?: CSSProperties
  children: ReactNode
  role?: string
  label?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; minWidth?: number } | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const anchorRef = useRef(anchor)
  anchorRef.current = anchor
  // nesting depth, fixed for the lifetime of one opening
  const depthRef = useRef(-1)
  if (open && depthRef.current < 0) depthRef.current = document.querySelectorAll('[data-k-popover]').length
  if (!open) depthRef.current = -1

  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    const place = () => {
      const r = anchorRect(anchorRef.current)
      const el = ref.current
      if (!r || !el) return
      const w = el.offsetWidth
      const h = el.offsetHeight
      const vw = window.innerWidth
      const vh = window.innerHeight
      const m = 8
      let left = r.left
      let top = r.bottom + offset
      if (placement === 'bottom-end') left = r.right - w
      if (placement === 'top-start') top = r.top - offset - h
      if (placement === 'left-start') {
        left = r.left - offset - w
        top = r.top
      }
      if (placement === 'right-start') {
        left = r.right + offset
        top = r.top
      }
      // flip vertically / horizontally when out of room
      if (top + h > vh - m && placement.startsWith('bottom')) {
        const above = r.top - offset - h
        top = above >= m ? above : Math.max(m, vh - m - h)
      }
      if (top < m) top = placement === 'top-start' && r.bottom + offset + h <= vh - m ? r.bottom + offset : m
      if (placement === 'left-start' && left < m) left = r.right + offset
      if (placement === 'right-start' && left + w > vw - m) left = r.left - offset - w
      left = Math.min(Math.max(m, left), vw - m - w)
      top = Math.min(Math.max(m, top), Math.max(m, vh - m - h))
      const minWidth = matchWidth ? r.width : undefined
      setPos((p) => (p && p.left === left && p.top === top && p.minWidth === minWidth ? p : { left, top, minWidth }))
    }
    place()
    const ro = new ResizeObserver(place)
    if (ref.current) ro.observe(ref.current)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, anchorKey(anchor), placement, offset, matchWidth])

  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent) => {
      const t = e.target as Node
      if (ref.current?.contains(t)) return
      const a = anchorRef.current
      if (a instanceof HTMLElement && a.contains(t)) return
      // a press inside a popover opened from this one (nested) stays open
      if ((t as Element).closest?.('[data-k-popover]')) {
        const host = (t as Element).closest('[data-k-popover]')
        if (host && host !== ref.current && Number(host.getAttribute('data-k-depth')) > depthRef.current) return
      }
      closeRef.current()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // only the top-most popover reacts
      const all = document.querySelectorAll('[data-k-popover]')
      if (all[all.length - 1] !== ref.current) return
      e.stopPropagation()
      e.preventDefault()
      closeRef.current()
    }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key, true)
    }
  }, [open, anchorKey(anchor)])

  if (!open) return null
  return createPortal(
    <div
      ref={ref}
      data-k-popover
      data-k-depth={depthRef.current}
      role={role}
      aria-label={label}
      className={'k-pop ' + className}
      style={{
        ...style,
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        minWidth: pos?.minWidth,
        visibility: pos ? 'visible' : 'hidden',
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </div>,
    document.body,
  )
}
