/**
 * Vector paths: pen-tool geometry and the SVG paint a path layer renders with.
 * Shared by the canvas (NodeView), the code exporters and the pen tool.
 */
import type { KNode, PathPoint, Rect, Token, VectorPath } from './types'
import { resolveColor, round, withAlpha } from './style'

type P = { x: number; y: number }

const same = (a: P, b: P) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6

/** Cubic segments [from, control 1, control 2, to] of a point list. */
function segments(pts: PathPoint[], closed: boolean): [P, P, P, P][] {
  const out: [P, P, P, P][] = []
  const n = pts.length
  const count = closed && n > 2 ? n : n - 1
  for (let i = 0; i < count; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % n]
    out.push([a, a.out ?? a, b.in ?? b, b])
  }
  return out
}

const isLine = ([a, c1, c2, b]: [P, P, P, P]) => same(a, c1) && same(b, c2)

export function cubicAt([a, c1, c2, b]: [P, P, P, P], t: number): P {
  const u = 1 - t
  return {
    x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
    y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
  }
}

/** SVG path data for a point list. */
export function pointsToD(pts: PathPoint[], closed: boolean): string {
  if (!pts.length) return ''
  const f = (p: P) => `${round(p.x, 2)} ${round(p.y, 2)}`
  const segs = segments(pts, closed)
  let d = `M${f(pts[0])}`
  segs.forEach((s, i) => {
    // the closing straight edge is drawn by Z
    if (closed && i === segs.length - 1 && isLine(s)) return
    d += isLine(s) ? ` L${f(s[3])}` : ` C${f(s[1])} ${f(s[2])} ${f(s[3])}`
  })
  if (closed && pts.length > 2) d += ' Z'
  return d
}

/** Tight bounds of the drawn curve (curves are sampled, which is exact to well under a pixel). */
export function pointsBounds(pts: PathPoint[], closed: boolean): Rect {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  const add = (p: P) => {
    x0 = Math.min(x0, p.x)
    y0 = Math.min(y0, p.y)
    x1 = Math.max(x1, p.x)
    y1 = Math.max(y1, p.y)
  }
  pts.forEach(add)
  for (const s of segments(pts, closed)) {
    if (isLine(s)) continue
    for (let k = 1; k < 32; k++) add(cubicAt(s, k / 32))
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/**
 * Turn world-space pen points into a layer box (world) and its path, with the
 * points moved into the box's own coordinates. Straight horizontal / vertical
 * lines get a 1px box so the layer stays selectable.
 */
export function buildPath(pts: PathPoint[], closed: boolean, snap: boolean): { box: Rect; path: VectorPath } {
  const b = pointsBounds(pts, closed)
  let x0 = b.x
  let y0 = b.y
  let x1 = b.x + b.w
  let y1 = b.y + b.h
  if (snap) {
    x0 = Math.floor(x0 + 1e-6)
    y0 = Math.floor(y0 + 1e-6)
    x1 = Math.ceil(x1 - 1e-6)
    y1 = Math.ceil(y1 - 1e-6)
  }
  if (x1 - x0 < 1) {
    const c = (x0 + x1) / 2
    x0 = snap ? Math.floor(c) : c - 0.5
    x1 = x0 + 1
  }
  if (y1 - y0 < 1) {
    const c = (y0 + y1) / 2
    y0 = snap ? Math.floor(c) : c - 0.5
    y1 = y0 + 1
  }
  const mv = (p: P | undefined) => (p ? { x: round(p.x - x0, 2), y: round(p.y - y0, 2) } : undefined)
  const points: PathPoint[] = pts.map((p) => {
    const q: PathPoint = { x: round(p.x - x0, 2), y: round(p.y - y0, 2) }
    if (p.in) q.in = mv(p.in)
    if (p.out) q.out = mv(p.out)
    return q
  })
  const w = round(x1 - x0, 2)
  const h = round(y1 - y0, 2)
  return { box: { x: x0, y: y0, w, h }, path: { d: pointsToD(points, closed), w, h, closed, points } }
}

/** Snap `p` to the nearest 45° ray from `from`. */
export function constrain45(from: P, p: P): P {
  const dx = p.x - from.x
  const dy = p.y - from.y
  const len = Math.hypot(dx, dy)
  if (!len) return p
  const step = Math.PI / 4
  const a = Math.round(Math.atan2(dy, dx) / step) * step
  return { x: from.x + Math.cos(a) * len, y: from.y + Math.sin(a) * len }
}

/* ------------------------------------------------------------- paint */

export interface SvgGradient {
  id: string
  type: 'linear' | 'radial'
  /** rotate(angle) about the centre, in objectBoundingBox units */
  transform?: string
  stops: { offset: string; color: string }[]
}

export interface SvgPaint {
  /** colour, `url(#id)` or `none` */
  fill: string
  gradient?: SvgGradient
  stroke?: { color: string; width: number; dash?: string; cap: 'round' | 'butt' }
}

/** SVG paint for a path layer: the top visible fill and the stroke. Token colours resolve to values (SVG attributes can't hold var()). */
export function vectorPaint(node: KNode, tokens: Token[], gradientId: string): SvgPaint {
  const out: SvgPaint = { fill: 'none' }
  const f = node.fills.find((x) => x.visible && x.type !== 'image')
  if (f) {
    if (f.type === 'solid') out.fill = withAlpha(resolveColor(f.color, f.tokenId, tokens), f.opacity)
    else {
      out.gradient = {
        id: gradientId,
        type: f.type === 'radial' ? 'radial' : 'linear',
        // CSS 180deg runs top → bottom; an SVG gradient runs left → right
        transform: f.type === 'linear' && round(f.angle - 90, 2) !== 0 ? `rotate(${round(f.angle - 90, 2)} 0.5 0.5)` : undefined,
        stops: f.stops.map((s) => ({ offset: `${round(s.pos * 100, 1)}%`, color: withAlpha(s.color, f.opacity) })),
      }
      out.fill = `url(#${gradientId})`
    }
  }
  const st = node.stroke
  if (st && st.visible && st.width > 0) {
    const w = st.width
    out.stroke = {
      color: st.color,
      width: w,
      dash: st.style === 'dashed' ? `${round(w * 3, 2)} ${round(w * 2, 2)}` : st.style === 'dotted' ? `0 ${round(w * 2, 2)}` : undefined,
      cap: st.style === 'dashed' ? 'butt' : 'round',
    }
  }
  return out
}

/** Attributes of the <path> element, in SVG (kebab-case) spelling. */
export function pathAttrs(path: VectorPath, paint: SvgPaint): Array<[string, string]> {
  const a: Array<[string, string]> = [['d', path.d], ['fill', paint.fill]]
  if (paint.stroke) {
    a.push(['stroke', paint.stroke.color], ['stroke-width', String(paint.stroke.width)])
    if (paint.stroke.dash) a.push(['stroke-dasharray', paint.stroke.dash])
    a.push(['stroke-linecap', paint.stroke.cap], ['stroke-linejoin', 'round'], ['vector-effect', 'non-scaling-stroke'])
  }
  return a
}
