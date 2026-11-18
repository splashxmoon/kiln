/**
 * The single source of truth for node → CSS.
 * The canvas renders nodes with exactly these styles, and the code exporters
 * emit exactly these styles, so the canvas *is* the code.
 */
import type { Fill, KNode, Token } from './types'

export type CSSObject = Record<string, string | number>

export interface StyleOptions {
  /** 'value' inlines token colours, 'var' emits var(--token) references */
  tokenMode?: 'value' | 'var'
  /** emit left/top for top-level nodes (canvas) or drop them (export root) */
  isExportRoot?: boolean
}

export function tokenVarName(t: Token) {
  return '--' + t.name.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()
}

export function resolveColor(color: string, tokenId: string | undefined, tokens: Token[], mode: 'value' | 'var' = 'value') {
  if (tokenId) {
    const t = tokens.find((t) => t.id === tokenId)
    if (t) return mode === 'var' ? `var(${tokenVarName(t)})` : t.value
  }
  return color
}

/** Apply 0..1 opacity to a hex / rgb colour. Leaves var() and keywords alone. */
export function withAlpha(color: string, a: number): string {
  if (a >= 1) return color
  const hex = color.trim()
  if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex)) {
    let h = hex.slice(1)
    if (h.length === 3) h = h.split('').map((c) => c + c).join('')
    const r = parseInt(h.slice(0, 2), 16)
    const g = parseInt(h.slice(2, 4), 16)
    const b = parseInt(h.slice(4, 6), 16)
    const base = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
    return `rgba(${r}, ${g}, ${b}, ${round(base * a, 3)})`
  }
  if (color.startsWith('var(')) return `color-mix(in srgb, ${color} ${Math.round(a * 100)}%, transparent)`
  return color
}

export function round(n: number, p = 2) {
  const m = Math.pow(10, p)
  return Math.round(n * m) / m
}

function fillToLayer(f: Fill, tokens: Token[], mode: 'value' | 'var'): string | null {
  if (!f.visible) return null
  switch (f.type) {
    case 'solid': {
      const c = withAlpha(resolveColor(f.color, f.tokenId, tokens, mode), f.opacity)
      return `linear-gradient(${c}, ${c})`
    }
    case 'linear': {
      const stops = f.stops.map((s) => `${withAlpha(s.color, f.opacity)} ${round(s.pos * 100, 1)}%`).join(', ')
      return `linear-gradient(${round(f.angle, 1)}deg, ${stops})`
    }
    case 'radial': {
      const stops = f.stops.map((s) => `${withAlpha(s.color, f.opacity)} ${round(s.pos * 100, 1)}%`).join(', ')
      return `radial-gradient(circle at 50% 50%, ${stops})`
    }
    case 'image':
      return f.src ? `url("${f.src}")` : null
  }
}

/** Background shorthand pieces for a fill list. fills[0] paints on top (CSS order). */
export function fillsToBackground(fills: Fill[], tokens: Token[], mode: 'value' | 'var' = 'value'): CSSObject {
  const visible = fills.filter((f) => f.visible)
  if (!visible.length) return {}
  if (visible.length === 1 && visible[0].type === 'solid') {
    const f = visible[0]
    return { backgroundColor: withAlpha(resolveColor(f.color, f.tokenId, tokens, mode), f.opacity) }
  }
  const layers: string[] = []
  const sizes: string[] = []
  const repeats: string[] = []
  for (const f of visible) {
    const l = fillToLayer(f, tokens, mode)
    if (!l) continue
    layers.push(l)
    if (f.type === 'image') {
      sizes.push(f.fit === 'contain' ? 'contain' : f.fit === 'fill' ? '100% 100%' : f.fit === 'tile' ? 'auto' : 'cover')
      repeats.push(f.fit === 'tile' ? 'repeat' : 'no-repeat')
    } else {
      sizes.push('100% 100%')
      repeats.push('no-repeat')
    }
  }
  if (!layers.length) return {}
  const out: CSSObject = { backgroundImage: layers.join(', ') }
  if (visible.some((f) => f.type === 'image')) {
    out.backgroundSize = sizes.join(', ')
    out.backgroundRepeat = repeats.join(', ')
    out.backgroundPosition = 'center'
  }
  return out
}

export function radiusCSS(r: KNode['radius'], type: KNode['type']): string | undefined {
  if (type === 'ellipse') return '50%'
  if (type === 'path') return undefined
  if (Array.isArray(r)) {
    if (r.every((v) => v === 0)) return undefined
    return r.map((v) => `${v}px`).join(' ')
  }
  return r ? `${r}px` : undefined
}

/**
 * Core mapping. `parent` is the parent node (null for top-level nodes).
 */
export function nodeToCSS(node: KNode, parent: KNode | null, tokens: Token[], opts: StyleOptions = {}): CSSObject {
  const mode = opts.tokenMode ?? 'value'
  const s: CSSObject = { boxSizing: 'border-box' }
  const inFlow = !!parent && parent.layout.mode === 'flex' && node.positioning !== 'absolute'
  const parentDir = parent?.layout.direction ?? 'row'

  // ---- positioning
  if (opts.isExportRoot) {
    s.position = 'relative'
  } else if (inFlow) {
    s.position = 'relative'
    s.flexShrink = 0
  } else {
    s.position = 'absolute'
    s.left = `${round(node.x)}px`
    s.top = `${round(node.y)}px`
  }

  // ---- sizing
  const isText = node.type === 'text'
  // vector paths paint fill and stroke inside their <svg>, not on the box
  const isPath = node.type === 'path'
  const sizeAxis = (axis: 'width' | 'height') => {
    const mode = axis === 'width' ? node.widthMode : node.heightMode
    const val = axis === 'width' ? node.width : node.height
    const mainAxis = parentDir === 'row' ? 'width' : 'height'
    if (mode === 'fixed' || (mode === 'hug' && node.type !== 'frame' && !isText)) {
      s[axis] = `${round(val)}px`
    } else if (mode === 'hug') {
      if (isText && axis === 'width') {
        s.width = 'max-content'
      } else {
        s[axis] = 'fit-content'
      }
    } else if (mode === 'fill') {
      if (inFlow && axis === mainAxis) {
        s.flex = '1 1 0px'
        s[axis === 'width' ? 'minWidth' : 'minHeight'] = 0
      } else if (inFlow) {
        s.alignSelf = 'stretch'
      } else {
        s[axis] = '100%'
      }
    }
  }
  sizeAxis('width')
  sizeAxis('height')
  if (node.minWidth) s.minWidth = `${node.minWidth}px`
  if (node.maxWidth) s.maxWidth = `${node.maxWidth}px`

  // ---- layout (frames)
  if (node.type === 'frame' && node.layout.mode === 'flex') {
    const L = node.layout
    s.display = 'flex'
    s.flexDirection = L.direction
    if (L.wrap) s.flexWrap = 'wrap'
    if (L.gap) s.gap = `${L.gap}px`
    const al: Record<string, string> = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch', baseline: 'baseline' }
    const ju: Record<string, string> = { start: 'flex-start', center: 'center', end: 'flex-end', 'space-between': 'space-between', 'space-around': 'space-around', 'space-evenly': 'space-evenly' }
    s.alignItems = al[L.align]
    s.justifyContent = ju[L.justify]
  }
  if (node.type === 'frame') {
    const [pt, pr, pb, pl] = node.layout.padding
    if (pt || pr || pb || pl) s.padding = pt === pr && pr === pb && pb === pl ? `${pt}px` : `${pt}px ${pr}px ${pb}px ${pl}px`
  }

  // ---- appearance
  Object.assign(s, isText || isPath ? {} : fillsToBackground(node.fills, tokens, mode))
  if (node.type === 'image' && node.image?.src) {
    s.backgroundImage = `url("${node.image.src}")`
    s.backgroundSize = node.image.fit === 'fill' ? '100% 100%' : node.image.fit
    s.backgroundPosition = 'center'
    s.backgroundRepeat = 'no-repeat'
  }
  const br = radiusCSS(node.radius, node.type)
  if (br) s.borderRadius = br
  if (node.clip || node.type === 'shader' || node.type === 'image') s.overflow = 'hidden'
  // strokes and curve handles may reach past the box
  if (isPath) s.overflow = 'visible'
  if (node.opacity < 1) s.opacity = round(node.opacity, 3)
  if (node.rotation) s.transform = `rotate(${round(node.rotation, 2)}deg)`
  if (node.blend !== 'normal') s.mixBlendMode = node.blend

  if (!isPath && node.stroke && node.stroke.visible && node.stroke.width > 0) {
    const st = node.stroke
    const v = `${st.width}px ${st.style} ${st.color}`
    if (st.position === 'inside') s.border = v
    else {
      s.outline = v
      s.outlineOffset = st.position === 'center' ? `${-st.width / 2}px` : '0px'
    }
  }

  const shadows = node.shadows.filter((sh) => sh.visible)
  const filters: string[] = []
  if (shadows.length) {
    if (isPath) {
      // follow the drawn shape, not the box
      for (const sh of shadows) if (sh.type === 'drop') filters.push(`drop-shadow(${sh.x}px ${sh.y}px ${sh.blur}px ${sh.color})`)
    } else if (isText) {
      s.textShadow = shadows.filter((sh) => sh.type === 'drop').map((sh) => `${sh.x}px ${sh.y}px ${sh.blur}px ${sh.color}`).join(', ')
    } else {
      s.boxShadow = shadows.map((sh) => `${sh.type === 'inner' ? 'inset ' : ''}${sh.x}px ${sh.y}px ${sh.blur}px ${sh.spread}px ${sh.color}`).join(', ')
    }
  }
  if (node.blur) filters.push(`blur(${node.blur}px)`)
  if (filters.length) s.filter = filters.join(' ')
  if (node.backdropBlur) s.backdropFilter = `blur(${node.backdropBlur}px)`

  // ---- text
  if (isText && node.text) {
    const t = node.text
    s.fontFamily = fontStack(t.fontFamily)
    s.fontSize = `${t.fontSize}px`
    s.fontWeight = t.fontWeight
    s.lineHeight = t.lineHeight
    if (t.letterSpacing) s.letterSpacing = `${round(t.letterSpacing, 3)}em`
    s.textAlign = t.textAlign
    s.color = resolveColor(t.color, t.tokenId, tokens, mode)
    if (t.italic) s.fontStyle = 'italic'
    if (t.decoration !== 'none') s.textDecoration = t.decoration
    if (t.transform !== 'none') s.textTransform = t.transform
    s.whiteSpace = node.widthMode === 'hug' ? 'pre' : 'pre-wrap'
    s.overflowWrap = 'break-word'
    // text fills paint behind the glyphs
    Object.assign(s, fillsToBackground(node.fills, tokens, mode))
  }

  if (!node.visible) s.display = 'none'
  return s
}

const GENERIC: Record<string, string> = {
  Geist: '"Geist", ui-sans-serif, system-ui, sans-serif',
  'Geist Mono': '"Geist Mono", ui-monospace, monospace',
  'Instrument Serif': '"Instrument Serif", ui-serif, Georgia, serif',
}
export function fontStack(family: string) {
  if (GENERIC[family]) return GENERIC[family]
  const generic = /mono|code/i.test(family) ? 'monospace' : /serif|garamond|playfair|fraunces|lora|georgia/i.test(family) && !/sans/i.test(family) ? 'serif' : 'sans-serif'
  return `"${family}", ${generic}`
}

export function kebab(prop: string) {
  return prop.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())
}

/** Render a CSSObject as declaration lines. */
export function cssObjectToString(s: CSSObject, indent = '  '): string {
  return Object.entries(s)
    .map(([k, v]) => `${indent}${kebab(k)}: ${typeof v === 'number' && !UNITLESS.has(k) ? v + 'px' : v};`)
    .join('\n')
}

export const UNITLESS = new Set(['opacity', 'fontWeight', 'lineHeight', 'flexShrink', 'flexGrow', 'zIndex', 'minWidth', 'minHeight'])
