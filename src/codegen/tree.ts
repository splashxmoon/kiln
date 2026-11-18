/**
 * Builds a target-agnostic element tree for an export: semantic tags, unique
 * class names and cleaned CSS. All styles come from `nodeToCSS` (the same
 * mapping the canvas renders with); this module only removes declarations that
 * are provably redundant in the exported context, so the output still renders
 * identically.
 */
import { nodeToCSS, tokenVarName } from '../editor/style.ts'
import type { CSSObject } from '../editor/style.ts'
import type { KDoc, KNode, Token } from '../editor/types.ts'
import { createNameRegistry, isSimpleText, kebabCase, normalizeText } from './format.ts'
import { pathAttrs, vectorPaint } from '../editor/vector.ts'

export interface ExportElement {
  node: KNode
  tag: string
  className: string
  css: CSSObject
  /** static attributes in output order; values are raw (unescaped) */
  attrs: Array<[string, string]>
  /** text content (text layers only) */
  text?: string
  children: ExportElement[]
  /** DOM id of the canvas for shader layers */
  shaderId?: string
  /** SVG internals (<path>, gradients): no class and no CSS rule */
  bare?: boolean
}

export interface FontUse {
  family: string
  /** "0,400" / "1,700" pairs (ital, wght), sorted */
  styles: string[]
}

export interface ExportTree {
  root: ExportElement
  /** every element in document order */
  elements: ExportElement[]
  fonts: FontUse[]
  /** tokens referenced by the emitted CSS, in doc order */
  tokens: Token[]
}

export interface StyleContext {
  tag: string
  isRoot: boolean
  /** some visible child is absolutely positioned (needs a containing block) */
  hasAbsChild: boolean
  /** an earlier visible sibling is absolutely positioned (paint order matters) */
  precededByAbs: boolean
  insideButton: boolean
  tokenMode: 'value' | 'var'
}

// ---------------------------------------------------------------- tags

const LANDMARK_WORDS: Record<string, string> = {
  button: 'button',
  btn: 'button',
  cta: 'button',
  nav: 'nav',
  navbar: 'nav',
  navigation: 'nav',
  header: 'header',
  footer: 'footer',
  section: 'section',
  main: 'main',
  aside: 'aside',
  sidebar: 'aside',
  article: 'article',
}

/** "Primary Button", "Button/Primary", "Top nav", "Hero section 2" → landmark tag. */
function landmarkFor(name: string): string | null {
  for (const segment of name.split('/')) {
    const words = kebabCase(segment).split('-').filter(Boolean)
    while (words.length > 1 && /^\d+$/.test(words[words.length - 1])) words.pop()
    const last = words[words.length - 1]
    if (last && LANDMARK_WORDS[last]) return LANDMARK_WORDS[last]
  }
  return null
}

const HEADINGS: Array<[number, string]> = [
  [32, 'h1'],
  [24, 'h2'],
  [20, 'h3'],
]

export function headingTag(node: KNode): string | null {
  const t = node.text
  if (!t || t.fontWeight < 600) return null
  for (const [size, tag] of HEADINGS) if (t.fontSize >= size) return tag
  return null
}

export function tagFor(node: KNode, isRoot: boolean, ancestors: string[]): string {
  const inButton = ancestors.includes('button')
  switch (node.type) {
    case 'text': {
      if (inButton) return 'span'
      const h = headingTag(node)
      if (h) return h
      const content = normalizeText(node.text?.content ?? '')
      if (!isRoot && node.widthMode === 'hug' && !content.includes('\n')) return 'span'
      return 'p'
    }
    case 'image':
      return node.image?.src ? 'img' : inButton ? 'span' : 'div'
    case 'shader':
      return 'canvas'
    case 'path':
      return 'svg'
    case 'frame': {
      if (inButton) return 'span'
      const lm = landmarkFor(node.name)
      if (!lm) return 'div'
      if (lm === 'button') return 'button'
      if ((lm === 'header' || lm === 'footer') && (ancestors.includes('header') || ancestors.includes('footer'))) return 'div'
      if (lm === 'main' && ancestors.some((a) => a !== 'div' && a !== 'section')) return 'div'
      return lm
    }
    default:
      return inButton ? 'span' : 'div'
  }
}

// ---------------------------------------------------------------- names

const GENERIC_NAME = /^(frame|group|rectangle|rect|ellipse|text|image|img|shader|layer|vector|path|shape)(\s*\d+)?$/i

function baseClassName(node: KNode, tag: string): string {
  const name = node.name.trim()
  if (!GENERIC_NAME.test(name)) {
    const k = kebabCase(name)
    if (k) return /^[0-9]/.test(k) ? `${node.type}-${k}` : k
  }
  switch (node.type) {
    case 'text':
      return /^h[1-6]$/.test(tag) ? 'heading' : tag === 'span' ? 'label' : 'text'
    case 'image':
      return 'image'
    case 'shader':
      return 'shader'
    case 'path':
      return 'vector'
    case 'frame':
      return tag === 'div' || tag === 'span' ? 'frame' : tag
    default:
      return 'shape'
  }
}

function altText(node: KNode): string {
  const alt = node.image?.alt?.trim()
  if (alt) return alt
  return GENERIC_NAME.test(node.name.trim()) ? '' : node.name.trim()
}

// ---------------------------------------------------------------- CSS cleanup

export function visibleChildren(doc: KDoc, node: KNode): KNode[] {
  return node.children.map((id) => doc.nodes[id]).filter((n): n is KNode => !!n && n.visible)
}

export function isAbsoluteChild(parent: KNode, child: KNode): boolean {
  return parent.layout.mode !== 'flex' || child.positioning === 'absolute'
}

function axisMode(n: KNode, axis: 'width' | 'height') {
  return axis === 'width' ? n.widthMode : n.heightMode
}

/**
 * Can `flex-shrink: 0` be dropped without changing layout? Only when shrinking
 * provably never happens. Hug sizes are measured by the DOM and not stored in
 * the model, so they are never used for the "fits" check.
 */
function shrinkIsNoop(doc: KDoc, node: KNode, parent: KNode, s: CSSObject): boolean {
  if ('flex' in s) return true // the later `flex` shorthand resets flex-shrink anyway
  const dir = parent.layout.direction
  const main = dir === 'row' ? 'width' : 'height'
  const pMode = axisMode(parent, main)
  const cMode = axisMode(node, main)
  const scrollContainer = node.clip || node.type === 'image' || node.type === 'shader'
  // A column that hugs its content is exactly as tall as its content.
  if (dir === 'column' && pMode === 'hug') return true
  // min-height:auto keeps a content-sized item at its content height.
  if (dir === 'column' && cMode === 'hug' && !scrollContainer) return true
  // Unwrappable text: min-content === max-content, so min-width:auto blocks shrinking.
  if (dir === 'row' && node.type === 'text' && cMode === 'hug') return true
  if (pMode !== 'fixed') return false
  // Fixed parent: drop when the fixed-size flow children provably fit.
  const kids = visibleChildren(doc, parent).filter((k) => !isAbsoluteChild(parent, k))
  const [pt, pr, pb, pl] = parent.layout.padding
  const st = parent.stroke
  const border = st && st.visible && st.width > 0 && st.position === 'inside' ? st.width * 2 : 0
  const avail = (main === 'width' ? parent.width - pl - pr : parent.height - pt - pb) - border
  let total = 0
  for (const k of kids) {
    const m = axisMode(k, main)
    if (m === 'fill') continue // flex-basis 0 + min-size 0: never forces overflow
    if (m !== 'fixed') return false // hug size unknown without the DOM
    const size = main === 'width' ? k.width : k.height
    if (parent.layout.wrap) {
      if (size > avail + 0.01) return false
    } else total += size
  }
  if (!parent.layout.wrap) total += parent.layout.gap * Math.max(0, kids.length - 1)
  return total <= avail + 0.01
}

/** Longest word can't overflow the line, so `overflow-wrap` never kicks in. */
function wordsAlwaysFit(node: KNode, content: string): boolean {
  const t = node.text
  if (!t || node.widthMode !== 'fixed') return false
  const longest = content.split(/\s+/).reduce((m, w) => Math.max(m, [...w].length), 0)
  // 1.1em per glyph is a safe upper bound for text fonts.
  const perGlyph = t.fontSize * (1.1 + Math.max(0, t.letterSpacing))
  return longest * perGlyph <= node.width
}

/**
 * `nodeToCSS` for one element of an export, minus redundant declarations.
 * `parent` is the real parent node, or null for the export root.
 */
export function elementCSS(doc: KDoc, node: KNode, parent: KNode | null, ctx: StyleContext): CSSObject {
  // <img> paints its picture with object-fit, not a background
  const source: KNode = ctx.tag === 'img' ? { ...node, image: undefined } : node
  const s: CSSObject = {
    ...nodeToCSS(source, ctx.isRoot ? null : parent, doc.tokens, { isExportRoot: ctx.isRoot, tokenMode: ctx.tokenMode }),
  }
  const p = ctx.isRoot ? null : parent
  const inFlow = !!p && p.layout.mode === 'flex' && node.positioning !== 'absolute'
  const dir = p?.layout.direction ?? 'row'
  const parentStretches = p?.layout.align === 'stretch'

  // box-sizing lives in the reset
  delete s.boxSizing
  if (ctx.isRoot && s.display === 'none') delete s.display

  // position: relative is only needed as a containing block, or to keep the
  // canvas paint order when an absolutely positioned sibling comes earlier.
  if (s.position === 'relative' && !ctx.hasAbsChild && !(inFlow && ctx.precededByAbs)) delete s.position

  if (inFlow && p) {
    if (s.flexShrink === 0 && shrinkIsNoop(doc, node, p, s)) delete s.flexShrink
    // 0% === 0px when the parent's main size is definite
    const main = dir === 'row' ? 'width' : 'height'
    if (s.flex === '1 1 0px' && axisMode(p, main) === 'fixed') s.flex = '1'
    if (s.alignSelf === 'stretch' && parentStretches) delete s.alignSelf
  }

  // ---- hug sizes that equal the browser's auto size in this context
  if (s.height === 'fit-content') {
    // block-axis fit-content is the content height; auto only differs when a row stretches it
    const stretched = inFlow && dir === 'row' && parentStretches
    if (!stretched) delete s.height
  }
  const shrinkToFit = (!!p && !inFlow) || (inFlow && dir === 'column' && !parentStretches)
  if (s.width === 'fit-content' && shrinkToFit) delete s.width

  // ---- text
  if (node.type === 'text' && node.text) {
    const content = normalizeText(node.text.content)
    const simple = isSimpleText(content)
    if (s.whiteSpace === 'pre' && simple) s.whiteSpace = 'nowrap'
    if (s.width === 'max-content' && (s.whiteSpace === 'nowrap' || s.whiteSpace === 'pre')) {
      // unwrappable text: auto width is already max-content in a row, or when shrink-wrapped
      if ((inFlow && dir === 'row') || shrinkToFit) delete s.width
    }
    if (s.whiteSpace === 'pre-wrap' && simple && node.text.textAlign === 'left') delete s.whiteSpace
    if (s.overflowWrap === 'break-word') {
      const noWrap = s.whiteSpace === 'nowrap' || s.whiteSpace === 'pre'
      if (noWrap || wordsAlwaysFit(node, content)) delete s.overflowWrap
    }
    // text-align is inherited; <button> centres by default
    if (s.textAlign === 'left' && !ctx.insideButton) delete s.textAlign
  }

  // ---- flex container defaults
  if (s.flexDirection === 'row') delete s.flexDirection
  if (s.alignItems === 'stretch') delete s.alignItems
  if (s.justifyContent === 'flex-start') delete s.justifyContent

  if (s.outlineOffset === '0px') delete s.outlineOffset

  // ---- replaced elements clip their own content
  if (ctx.tag === 'img' || ctx.tag === 'canvas') delete s.overflow
  if (ctx.tag === 'img') {
    const fit = node.image?.fit ?? 'cover'
    if (fit !== 'fill') s.objectFit = fit
  }
  return s
}

// ---------------------------------------------------------------- tree

export interface BuildOptions {
  tokenMode: 'value' | 'var'
}

export function buildTree(doc: KDoc, rootId: string, opts: BuildOptions): ExportTree {
  const rootNode = doc.nodes[rootId]
  if (!rootNode) throw new Error(`exportNode: no node with id "${rootId}"`)
  const nextName = createNameRegistry()
  const elements: ExportElement[] = []
  const fonts = new Map<string, Set<string>>()

  const visit = (node: KNode, parent: KNode | null, ancestors: string[], precededByAbs: boolean): ExportElement => {
    const isRoot = ancestors.length === 0
    const tag = tagFor(node, isRoot, ancestors)
    const kids = visibleChildren(doc, node)
    const css = elementCSS(doc, node, parent, {
      tag,
      isRoot,
      hasAbsChild: kids.some((k) => isAbsoluteChild(node, k)),
      precededByAbs,
      insideButton: ancestors.includes('button'),
      tokenMode: opts.tokenMode,
    })
    const el: ExportElement = { node, tag, className: nextName(baseClassName(node, tag)), css, attrs: [], children: [] }
    elements.push(el)

    if (tag === 'button') el.attrs.push(['type', 'button'])
    if (tag === 'img') el.attrs.push(['src', node.image?.src ?? ''], ['alt', altText(node)])
    if (tag === 'canvas') {
      el.shaderId = el.className
      el.attrs.push(['id', el.shaderId])
    }
    if (tag === 'svg' && node.path) el.children.push(...svgContent(node, el, doc))
    if (node.type === 'text' && node.text) {
      el.text = normalizeText(node.text.content)
      const t = node.text
      const set = fonts.get(t.fontFamily) ?? new Set<string>()
      set.add(`${t.italic ? 1 : 0},${t.fontWeight}`)
      fonts.set(t.fontFamily, set)
    }

    let seenAbs = false
    for (const k of kids) {
      el.children.push(visit(k, node, [...ancestors, tag], seenAbs))
      if (isAbsoluteChild(node, k)) seenAbs = true
    }
    return el
  }

  const root = visit(rootNode, rootNode.parentId ? doc.nodes[rootNode.parentId] ?? null : null, [], false)

  const allValues = elements.flatMap((e) => Object.values(e.css).map(String)).join('\n')
  const seenVars = new Set<string>()
  const tokens = doc.tokens.filter((t) => {
    const v = tokenVarName(t)
    if (seenVars.has(v) || !allValues.includes(`var(${v})`)) return false
    seenVars.add(v)
    return true
  })

  const fontList: FontUse[] = [...fonts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([family, set]) => ({
      family,
      styles: [...set].sort((a, b) => {
        const [ia, wa] = a.split(',').map(Number)
        const [ib, wb] = b.split(',').map(Number)
        return ia - ib || wa - wb
      }),
    }))

  return { root, elements, fonts: fontList, tokens }
}

const bare = (node: KNode, tag: string, attrs: Array<[string, string]>, children: ExportElement[] = []): ExportElement => ({
  node,
  tag,
  className: '',
  css: {},
  attrs,
  children,
  bare: true,
})

/** viewBox and accessibility attributes on the <svg>, and its gradient + <path> children. */
function svgContent(node: KNode, el: ExportElement, doc: KDoc): ExportElement[] {
  const path = node.path!
  el.attrs.push(['viewBox', `0 0 ${path.w} ${path.h}`])
  if (Math.abs(node.width / node.height - path.w / path.h) > 0.001) el.attrs.push(['preserveAspectRatio', 'none'])
  const label = GENERIC_NAME.test(node.name.trim()) ? '' : node.name.trim()
  if (label) el.attrs.push(['role', 'img'], ['aria-label', label])
  else el.attrs.push(['aria-hidden', 'true'])
  const paint = vectorPaint(node, doc.tokens, `${el.className}-fill`)
  const out: ExportElement[] = []
  const g = paint.gradient
  if (g) {
    const stops = g.stops.map((s) => bare(node, 'stop', [['offset', s.offset], ['stop-color', s.color]]))
    const gradient =
      g.type === 'radial'
        ? bare(node, 'radialGradient', [['id', g.id]], stops)
        : bare(node, 'linearGradient', [['id', g.id], ...(g.transform ? ([['gradientTransform', g.transform]] as Array<[string, string]>) : [])], stops)
    out.push(bare(node, 'defs', [], [gradient]))
  }
  out.push(bare(node, 'path', pathAttrs(path, paint)))
  return out
}

/** Ancestor tags (outermost first) of a node as it would export from its top-level frame. */
export function ancestorTags(doc: KDoc, node: KNode): string[] {
  const chain: KNode[] = []
  let id = node.parentId
  while (id && doc.nodes[id]) {
    chain.unshift(doc.nodes[id])
    id = doc.nodes[id].parentId
  }
  const tags: string[] = []
  chain.forEach((n, i) => tags.push(tagFor(n, i === 0, tags.slice())))
  return tags
}
