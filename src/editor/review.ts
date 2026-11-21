/**
 * Design review (lint): a pure pass over a document that lists what to fix.
 *
 *   runReview(doc, pageId)  // → Issue[] for one page, or every page when pageId is omitted
 *
 * Rules: text contrast (WCAG AA), small tap targets, colours that match a token but don't use
 * it, default layer names, images without alt text, text overflowing a fixed box, and hidden or
 * empty frames. An issue may carry a `fix` that edits a document draft (run it inside
 * `getEditor().update`). Nothing here reads the DOM or the store: sizes come from the layers,
 * or from `opts.size` when the caller can measure (hug and fill layers).
 */
import type { Draft } from 'immer'
import type { Fill, KDoc, KNode, Token } from './types'
import { parseColor, type RGBA } from '../ui/color'

export type ReviewRule = 'contrast' | 'tap-target' | 'off-token' | 'unnamed' | 'alt-text' | 'overflow' | 'hidden-empty'

export interface Issue {
  /** stable across runs: rule + layer (+ which colour, for off-token) */
  id: string
  rule: ReviewRule
  severity: 'error' | 'warning'
  nodeId: string
  message: string
  /** a one-click fix; edits the draft of the document the issue was found in */
  fix?: (d: Draft<KDoc>) => void
}

export interface ReviewOptions {
  /** measured size of a layer, when known (the editor passes geometry's measure) */
  size?: (id: string) => { w: number; h: number } | null | undefined
}

/** Rule titles and order, for the panel and the agent tool. */
export const RULES: { rule: ReviewRule; title: string; hint: string }[] = [
  { rule: 'contrast', title: 'Text contrast', hint: 'Below WCAG AA: 4.5:1, or 3:1 for large text' },
  { rule: 'tap-target', title: 'Tap targets', hint: 'Buttons and links smaller than 44×44' },
  { rule: 'alt-text', title: 'Missing alt text', hint: 'Images with no description' },
  { rule: 'overflow', title: 'Text overflow', hint: 'Text likely taller than its fixed box' },
  { rule: 'off-token', title: 'Colours off token', hint: 'A token has this exact colour' },
  { rule: 'unnamed', title: 'Unnamed layers', hint: 'Default names like “Frame 12”' },
  { rule: 'hidden-empty', title: 'Hidden or empty', hint: 'Hidden layers and frames that draw nothing' },
]

/* ------------------------------------------------------------------ colour */

type RGB = { r: number; g: number; b: number }

const channel = (v: number) => {
  const c = v / 255
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}
export const luminance = ({ r, g, b }: RGB) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
export function contrastRatio(a: RGB, b: RGB) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
/** `top` (with its alpha) painted over an opaque `under`. */
const over = (top: RGBA, under: RGB): RGB => ({
  r: top.r * top.a + under.r * (1 - top.a),
  g: top.g * top.a + under.g * (1 - top.a),
  b: top.b * top.a + under.b * (1 - top.a),
})

const tokenValue = (tokens: Token[], tokenId: string | undefined) => (tokenId ? tokens.find((t) => t.id === tokenId)?.value : undefined)
/** A colour with its token resolved, or null when it can't be parsed (var(), keywords…). */
function resolve(color: string, tokenId: string | undefined, tokens: Token[], opacity = 1): RGBA | null {
  const c = parseColor(tokenValue(tokens, tokenId) ?? color)
  return c ? { ...c, a: c.a * opacity } : null
}
/** Same colour, alpha included (#FFF = #ffffff = rgb(255,255,255)). */
function sameColor(a: string, b: string) {
  const x = parseColor(a)
  const y = parseColor(b)
  return !!x && !!y && x.r === y.r && x.g === y.g && x.b === y.b && Math.abs(x.a - y.a) < 0.01
}

/**
 * What a layer's content sits on: its own fills (fills[0] paints on top) over its parent's, up to
 * the page background. null when a gradient, image or unreadable colour is in the way, since the
 * contrast can't be known then.
 */
function backgroundOf(doc: KDoc, n: KNode | undefined, pageBg: RGB, memo: Map<string, RGB | null>): RGB | null {
  if (!n) return pageBg
  if (memo.has(n.id)) return memo.get(n.id)!
  let bg: RGB | null = backgroundOf(doc, n.parentId ? doc.nodes[n.parentId] : undefined, pageBg, memo)
  // an image or shader paints pixels we can't know
  if (n.type === 'image' || n.type === 'shader') bg = null
  const fills = n.fills.filter((f: Fill) => f.visible && f.opacity > 0)
  for (let i = fills.length - 1; i >= 0 && bg; i--) {
    const f = fills[i]
    if (f.type !== 'solid') {
      bg = null
      break
    }
    const c = resolve(f.color, f.tokenId, doc.tokens, f.opacity)
    bg = c ? over(c, bg) : null
  }
  memo.set(n.id, bg)
  return bg
}

/* ------------------------------------------------------------------ helpers */

const DEFAULT_NAME = /^(Frame|Rectangle|Ellipse|Path|Text|Image|Shader|Group|Vector|Line|Layer)( \d+)?$/
/** singular only: "Links" or "Buttons" is a row holding targets, not a target */
const BUTTONISH = /\b(button|btn|link|cta|tab|chip|toggle)\b/i
export const MIN_TAP = 44

const fmt = (n: number) => String(Math.round(n * 10) / 10)

/** Delete a layer and everything inside it, unlinking it from its parent or page. */
function removeLayer(d: Draft<KDoc>, id: string) {
  const n = d.nodes[id]
  if (!n) return
  const list = n.parentId ? d.nodes[n.parentId]?.children : d.pages.find((p) => p.id === n.pageId)?.children
  const i = list?.indexOf(id) ?? -1
  if (list && i >= 0) list.splice(i, 1)
  const drop = (x: string) => {
    for (const c of d.nodes[x]?.children ?? []) drop(c)
    delete d.nodes[x]
  }
  drop(id)
}

/** First text inside a layer, as a short name ("Get started"). */
function textName(doc: KDoc, n: KNode): string | undefined {
  if (n.text?.content.trim()) return n.text.content.trim().split('\n')[0].slice(0, 32)
  for (const c of n.children) {
    const t = doc.nodes[c] && textName(doc, doc.nodes[c])
    if (t) return t
  }
  return undefined
}

/**
 * Lines a text layer needs at its width: an average glyph is ~0.55em wide (plus letter spacing),
 * and each paragraph wraps on its own. An estimate, so the rule allows a few pixels of slack.
 */
export function estimateTextHeight(n: KNode, width: number) {
  const t = n.text!
  const glyph = t.fontSize * (0.55 + (t.letterSpacing || 0))
  const perLine = Math.max(1, Math.floor(width / Math.max(glyph, 0.1)))
  let lines = 0
  for (const para of t.content.split('\n')) lines += Math.max(1, Math.ceil(para.length / perLine))
  return lines * t.fontSize * t.lineHeight
}

/* ------------------------------------------------------------------ the review */

export function runReview(doc: KDoc, pageId?: string, opts: ReviewOptions = {}): Issue[] {
  const issues: Issue[] = []
  const pages = pageId ? doc.pages.filter((p) => p.id === pageId) : doc.pages
  const sizeOf = (n: KNode) => {
    const m = opts.size?.(n.id)
    return m ? { w: m.w, h: m.h } : { w: n.width, h: n.height }
  }

  for (const page of pages) {
    const pageBg = parseColor(page.background) ?? { r: 255, g: 255, b: 255, a: 1 }
    const memo = new Map<string, RGB | null>()
    const visit = (id: string) => {
      const n = doc.nodes[id]
      if (!n) return
      // a hidden layer is one issue; what's inside it isn't seen, so isn't reviewed
      if (!n.visible) {
        issues.push({
          id: `hidden-empty:${n.id}`,
          rule: 'hidden-empty',
          severity: 'warning',
          nodeId: n.id,
          message: `“${n.name}” is hidden. Delete it if it isn't needed, so it doesn't ship in code.`,
        })
        return
      }
      check(n)
      for (const c of n.children) visit(c)
    }

    const check = (n: KNode) => {
      const size = sizeOf(n)

      // ---- text contrast
      if (n.type === 'text' && n.text && n.text.content.trim()) {
        const t = n.text
        const bg = backgroundOf(doc, n, pageBg, memo)
        const fg = resolve(t.color, t.tokenId, doc.tokens, n.opacity)
        if (bg && fg) {
          const ratio = contrastRatio(over(fg, bg), bg)
          const large = t.fontSize >= 24 || (t.fontSize >= 18.66 && t.fontWeight >= 700)
          const need = large ? 3 : 4.5
          if (ratio < need) {
            const better = contrastRatio({ r: 0, g: 0, b: 0 }, bg) >= contrastRatio({ r: 255, g: 255, b: 255 }, bg) ? '#000000' : '#FFFFFF'
            issues.push({
              id: `contrast:${n.id}`,
              rule: 'contrast',
              severity: 'error',
              nodeId: n.id,
              message: `Contrast ${fmt(ratio)}:1, needs ${need}:1${large ? ' (large text)' : ''}.`,
              fix: (d) => {
                const x = d.nodes[n.id]?.text
                if (!x) return
                x.color = better
                delete x.tokenId
              },
            })
          }
        }
      }

      // ---- tap targets
      const only = n.children.length === 1 ? doc.nodes[n.children[0]] : undefined
      const filled = n.fills.some((f) => f.visible && f.opacity > 0)
      const tappable = n.type === 'frame' && (BUTTONISH.test(n.name) || (only?.type === 'text' && filled))
      if (tappable && (size.w < MIN_TAP || size.h < MIN_TAP)) {
        issues.push({
          id: `tap-target:${n.id}`,
          rule: 'tap-target',
          severity: 'error',
          nodeId: n.id,
          message: `${fmt(size.w)}×${fmt(size.h)}, under the ${MIN_TAP}×${MIN_TAP} tap size.`,
          fix: (d) => {
            const x = d.nodes[n.id]
            if (!x) return
            if (size.w < MIN_TAP) {
              if (x.widthMode === 'fixed') x.width = MIN_TAP
              else x.minWidth = Math.max(x.minWidth ?? 0, MIN_TAP)
            }
            if (size.h < MIN_TAP) {
              x.height = MIN_TAP
              x.heightMode = 'fixed'
            }
          },
        })
      }

      // ---- colours that match a token but don't use it
      n.fills.forEach((f, i) => {
        if (f.type !== 'solid' || f.tokenId || !f.visible) return
        const tok = doc.tokens.find((t) => sameColor(t.value, f.color))
        if (!tok) return
        issues.push({
          id: `off-token:${n.id}:fill:${f.id ?? i}`,
          rule: 'off-token',
          severity: 'warning',
          nodeId: n.id,
          message: `Fill ${f.color} matches token “${tok.name}”.`,
          fix: (d) => {
            const x = d.nodes[n.id]?.fills.find((g, j) => (f.id ? g.id === f.id : j === i))
            if (x) x.tokenId = tok.id
          },
        })
      })
      if (n.text && !n.text.tokenId) {
        const color = n.text.color
        const tok = doc.tokens.find((t) => sameColor(t.value, color))
        if (tok)
          issues.push({
            id: `off-token:${n.id}:text`,
            rule: 'off-token',
            severity: 'warning',
            nodeId: n.id,
            message: `Text colour ${color} matches token “${tok.name}”.`,
            fix: (d) => {
              const x = d.nodes[n.id]?.text
              if (x) x.tokenId = tok.id
            },
          })
      }

      // ---- default names (text layers are named by what they say)
      if (n.type !== 'text' && DEFAULT_NAME.test(n.name.trim())) {
        const suggested = textName(doc, n)
        issues.push({
          id: `unnamed:${n.id}`,
          rule: 'unnamed',
          severity: 'warning',
          nodeId: n.id,
          message: suggested ? `“${n.name}” has a default name. Rename to “${suggested}”?` : `“${n.name}” has a default name.`,
          fix: suggested
            ? (d) => {
                const x = d.nodes[n.id]
                if (x) x.name = suggested
              }
            : undefined,
        })
      }

      // ---- images without alt text
      if (n.type === 'image' && !n.image?.alt.trim()) {
        const named = !DEFAULT_NAME.test(n.name.trim()) ? n.name.trim() : ''
        issues.push({
          id: `alt-text:${n.id}`,
          rule: 'alt-text',
          severity: 'error',
          nodeId: n.id,
          message: named ? `No alt text. Use the layer name, “${named}”?` : 'No alt text: describe the image for screen readers.',
          fix: named
            ? (d) => {
                const x = d.nodes[n.id]
                if (x?.image) x.image.alt = named
              }
            : undefined,
        })
      }

      // ---- text overflowing a fixed box
      if (n.type === 'text' && n.text && n.widthMode !== 'hug' && n.heightMode === 'fixed' && n.text.content) {
        const needed = estimateTextHeight(n, size.w)
        if (needed > size.h + Math.max(2, n.text.fontSize * 0.25)) {
          issues.push({
            id: `overflow:${n.id}`,
            rule: 'overflow',
            severity: 'warning',
            nodeId: n.id,
            message: `Text needs about ${Math.round(needed)}px but its box is ${Math.round(size.h)}px tall.`,
            fix: (d) => {
              const x = d.nodes[n.id]
              if (x) x.heightMode = 'hug'
            },
          })
        }
      }

      // ---- frames that draw nothing. A flow child of a flex frame, or one sized to fill, is
      // usually a layout spacer: only stray ones (top-level or absolutely placed) are reported
      const draws = filled || !!n.stroke?.visible || n.shadows.some((s) => s.visible) || n.backdropBlur > 0
      const parent = n.parentId ? doc.nodes[n.parentId] : undefined
      const spacer = (parent?.layout.mode === 'flex' && n.positioning !== 'absolute') || n.widthMode === 'fill' || n.heightMode === 'fill'
      if (n.type === 'frame' && n.children.length === 0 && !draws && !spacer) {
        issues.push({
          id: `hidden-empty:${n.id}`,
          rule: 'hidden-empty',
          severity: 'warning',
          nodeId: n.id,
          message: `“${n.name}” is an empty frame with no fill. Delete it?`,
          fix: (d) => removeLayer(d, n.id),
        })
      }
    }

    for (const id of page.children) visit(id)
  }

  const order = new Map(RULES.map((r, i) => [r.rule, i]))
  return issues.sort((a, b) => order.get(a.rule)! - order.get(b.rule)!)
}

/** The issues as plain data, for the agent tool (no functions). */
export function issuesToJSON(doc: KDoc, issues: Issue[]) {
  return issues.map((i) => ({
    nodeId: i.nodeId,
    name: doc.nodes[i.nodeId]?.name,
    rule: i.rule,
    severity: i.severity,
    message: i.message,
    fixable: !!i.fix,
  }))
}
