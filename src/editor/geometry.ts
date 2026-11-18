/**
 * Geometry is read straight from the DOM. Because every layer is a real
 * element laid out by the browser (flexbox, hug, fill, text wrapping), the DOM
 * is the ground truth for where things are.
 */
import type { Camera, Rect } from './types'

let worldEl: HTMLElement | null = null
let cameraRef: Camera = { x: 0, y: 0, zoom: 1 }

/**
 * id → element, so hover, snapping and the overlay don't scan the whole canvas with
 * querySelector on every call. An entry is trusted only while the element is still in the
 * world and still carries that id (React may replace it, e.g. when a text layer starts editing).
 */
const elCache = new Map<string, Element>()

export function registerWorld(el: HTMLElement | null) {
  worldEl = el
  elCache.clear()
}
export function setGeometryCamera(c: Camera) {
  cameraRef = c
}
export function getWorldEl() {
  return worldEl
}

export function nodeEl(id: string): HTMLElement | null {
  if (!worldEl) return null
  const hit = elCache.get(id)
  if (hit && hit.isConnected && hit.getAttribute('data-id') === id && worldEl.contains(hit)) return hit as HTMLElement
  const el = worldEl.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)
  if (el) elCache.set(id, el)
  else elCache.delete(id)
  // deleted layers would otherwise pile up over a long session
  if (elCache.size > 20000) elCache.clear()
  return el
}

/** World-space bounding box of a node (axis aligned, includes rotation). */
export function measure(id: string): Rect | null {
  const el = nodeEl(id)
  if (!el || !worldEl) return null
  const wr = worldEl.getBoundingClientRect()
  const r = el.getBoundingClientRect()
  const z = cameraRef.zoom
  if (r.width === 0 && r.height === 0 && (!(el instanceof HTMLElement) || el.offsetParent === null)) return null
  return { x: (r.left - wr.left) / z, y: (r.top - wr.top) / z, w: r.width / z, h: r.height / z }
}

/**
 * Unrotated layout box relative to the parent's padding box. SVG layers (vector
 * paths) have no offset* metrics, so theirs comes from the used size and the
 * rendered centre (rotation turns about the centre, so the centre is exact).
 */
function layoutBox(el: Element): Rect {
  if (el instanceof HTMLElement) return { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight }
  const cs = getComputedStyle(el)
  const w = parseFloat(cs.width) || 0
  const h = parseFloat(cs.height) || 0
  const z = cameraRef.zoom
  const r = el.getBoundingClientRect()
  const p = el.parentElement
  const pr = p?.getBoundingClientRect()
  const ox = pr && p ? pr.left + p.clientLeft * z : r.left
  const oy = pr && p ? pr.top + p.clientTop * z : r.top
  return { x: (r.left + r.width / 2 - ox) / z - w / 2, y: (r.top + r.height / 2 - oy) / z - h / 2, w, h }
}

/** Layout box relative to the parent's padding box (unrotated). */
export function measureLocal(id: string): Rect | null {
  const el = nodeEl(id)
  if (!el) return null
  return layoutBox(el)
}

/** Unrotated layout size. */
export function measureSize(id: string): { w: number; h: number } | null {
  const el = nodeEl(id)
  if (!el) return null
  const b = layoutBox(el)
  return { w: b.w, h: b.h }
}

export function screenToWorld(sx: number, sy: number, cam: Camera = cameraRef) {
  return { x: (sx - cam.x) / cam.zoom, y: (sy - cam.y) / cam.zoom }
}
export function worldToScreen(wx: number, wy: number, cam: Camera = cameraRef) {
  return { x: wx * cam.zoom + cam.x, y: wy * cam.zoom + cam.y }
}

export function rectsIntersect(a: Rect, b: Rect) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}
export function rectContains(a: Rect, p: { x: number; y: number }) {
  return p.x >= a.x && p.x <= a.x + a.w && p.y >= a.y && p.y <= a.y + a.h
}
export function unionRects(rs: Rect[]): Rect | null {
  if (!rs.length) return null
  const x = Math.min(...rs.map((r) => r.x))
  const y = Math.min(...rs.map((r) => r.y))
  const x2 = Math.max(...rs.map((r) => r.x + r.w))
  const y2 = Math.max(...rs.map((r) => r.y + r.h))
  return { x, y, w: x2 - x, h: y2 - y }
}
