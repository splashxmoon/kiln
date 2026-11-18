/**
 * Offline quick actions — deterministic helpers that need no model and no
 * account. They handle the tedious passes so humans (and agents) can focus.
 */
import { getEditor, descendants } from '../editor/store'
import type { KDoc, KNode } from '../editor/types'
import { measure, measureSize } from '../editor/geometry'
import { cloneSubtree } from '../editor/factory'
import { toHex6 } from '../editor/ui/controls'

export interface QuickAction {
  id: string
  label: string
  description: string
  needsSelection?: boolean
}

export const QUICK_ACTIONS: QuickAction[] = [
  { id: 'mobile', label: 'Mobile variant', description: 'Duplicate the selected artboard as a 390px-wide responsive variant', needsSelection: true },
  { id: 'tidy', label: 'Tidy spacing', description: 'Snap gaps, padding, radii and sizes to a 4px grid' },
  { id: 'lint', label: 'Consistency check', description: 'Bind near-match colours to tokens and report off-scale type' },
  { id: 'copy', label: 'Replace lorem', description: 'Swap placeholder text for realistic copy' },
  { id: 'names', label: 'Name layers', description: 'Give generic layers meaningful names from their content' },
]

function scopeIds(doc: KDoc, selection: string[], pageId: string): string[] {
  const roots = selection.length ? selection : doc.pages.find((p) => p.id === pageId)?.children ?? []
  return roots.flatMap((r) => [r, ...descendants(doc, r)])
}

const snap4 = (v: number) => Math.round(v / 4) * 4

/* ------------------------------------------------------------------ colour helpers */

function rgb(c: string): [number, number, number] | null {
  const h = toHex6(c)
  if (!h) return null
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
}
function dist(a: [number, number, number], b: [number, number, number]) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

/* ------------------------------------------------------------------ copy library */

const COPY = {
  heading: ['Built for the long run', 'Everything in one place', 'Plan less. Ship more.', 'Made to be used daily', 'A calmer way to work'],
  body: [
    'Track every order from first sketch to doorstep, with updates your customers actually read.',
    'Invite your team, set a budget and see where every hour goes — no spreadsheets required.',
    'Start with a template, swap in your own photos and publish in an afternoon.',
    'Hand-finished in small batches and shipped in recycled packaging within three days.',
  ],
  button: ['Get started', 'Book a demo', 'See pricing', 'Continue'],
  label: ['Overview', 'Activity', 'Settings', 'Reports'],
}
const pick = <T,>(arr: T[], i: number) => arr[i % arr.length]

/* ------------------------------------------------------------------ actions */

export async function runQuickAction(id: string): Promise<string> {
  const s = getEditor()
  const doc = s.doc
  switch (id) {
    case 'mobile': {
      const srcId = s.selection.find((x) => doc.nodes[x]?.type === 'frame')
      if (!srcId) throw new Error('Select a frame or artboard first.')
      const src = doc.nodes[srcId]
      const width = 390
      const [root, all] = cloneSubtree(doc.nodes, srcId, null, s.pageId)
      const r = measure(srcId)
      root.name = src.name.replace(/desktop/i, '').trim() + ' / Mobile'
      root.x = Math.round((r?.x ?? src.x) + (r?.w ?? src.width) + 120)
      root.y = Math.round(r?.y ?? src.y)
      root.width = width
      root.widthMode = 'fixed'
      if (root.layout.mode === 'flex') root.heightMode = 'hug'
      const byId = new Map(all.map((n) => [n.id, n]))
      let changes = 0
      for (const n of all) {
        if (n.id !== root.id && n.widthMode === 'fixed' && n.width > width - 32) {
          n.widthMode = 'fill'
          changes++
        }
        if (n.type === 'frame' && n.layout.mode === 'flex') {
          const [, pr, , pl] = n.layout.padding
          if (pl > 24 || pr > 24) {
            n.layout.padding = [Math.min(n.layout.padding[0], 48), 20, Math.min(n.layout.padding[2], 48), 20]
            changes++
          }
          if (n.layout.direction === 'row') {
            const kids = n.children.map((c) => byId.get(c)!).filter(Boolean)
            const total = kids.reduce((sum, k) => sum + (measureSize(srcIdOf(k, all, doc, srcId) ?? '')?.w ?? k.width), 0)
            if (total + n.layout.gap * (kids.length - 1) > width - 40 && kids.length > 1) {
              n.layout.direction = 'column'
              n.layout.align = 'stretch'
              for (const k of kids) if (k.widthMode === 'fill' || k.widthMode === 'fixed') k.widthMode = 'fill'
              changes++
            }
          }
        }
        if (n.text) {
          if (n.text.fontSize >= 40) {
            n.text.fontSize = Math.round(n.text.fontSize * 0.62)
            changes++
          } else if (n.text.fontSize >= 24) n.text.fontSize = Math.round(n.text.fontSize * 0.82)
          if (n.widthMode === 'fixed' && n.width > width - 40) n.widthMode = 'fill'
        }
      }
      s.insertNodes(all, [root.id], null)
      s.set({ selection: [root.id] })
      return `Created “${root.name}” at ${width}px — ${changes} layout adjustments (stacked rows, fluid widths, scaled type). Review and tweak.`
    }
    case 'tidy': {
      const ids = scopeIds(doc, s.selection, s.pageId)
      let n = 0
      s.setProps(ids, (x) => {
        const before = JSON.stringify([x.layout.gap, x.layout.padding, x.radius, x.width, x.height, x.x, x.y])
        x.layout.gap = snap4(x.layout.gap)
        x.layout.padding = x.layout.padding.map(snap4) as [number, number, number, number]
        if (typeof x.radius === 'number' && x.radius < 999) x.radius = snap4(x.radius)
        if (x.widthMode === 'fixed' && x.type !== 'text') x.width = Math.max(4, snap4(x.width))
        if (x.heightMode === 'fixed' && x.type !== 'text') x.height = Math.max(4, snap4(x.height))
        x.x = Math.round(x.x)
        x.y = Math.round(x.y)
        if (JSON.stringify([x.layout.gap, x.layout.padding, x.radius, x.width, x.height, x.x, x.y]) !== before) n++
      })
      return n ? `Snapped ${n} layer${n > 1 ? 's' : ''} to the 4px grid.` : 'Everything is already on the 4px grid.'
    }
    case 'lint': {
      const ids = scopeIds(doc, s.selection, s.pageId)
      const tokens = doc.tokens.map((t) => ({ t, c: rgb(t.value) })).filter((x) => x.c)
      let bound = 0
      const sizes = new Map<number, number>()
      s.setProps(ids, (x) => {
        for (const f of x.fills) {
          if (f.type !== 'solid' || f.tokenId) continue
          const c = rgb(f.color)
          const near = c && tokens.find((tk) => dist(tk.c!, c) < 18)
          if (near) {
            f.tokenId = near.t.id
            bound++
          }
        }
        if (x.text && !x.text.tokenId) {
          const c = rgb(x.text.color)
          const near = c && tokens.find((tk) => dist(tk.c!, c) < 18)
          if (near) {
            x.text.tokenId = near.t.id
            bound++
          }
        }
        if (x.text) sizes.set(x.text.fontSize, (sizes.get(x.text.fontSize) ?? 0) + 1)
      })
      const scale = [12, 13, 14, 15, 16, 18, 20, 24, 28, 32, 40, 48, 56, 64, 72, 96]
      const off = [...sizes.keys()].filter((v) => !scale.includes(v))
      const parts = [`Bound ${bound} colour${bound === 1 ? '' : 's'} to tokens.`, `${sizes.size} distinct font sizes in use.`]
      if (off.length) parts.push(`Off-scale sizes: ${off.sort((a, b) => a - b).join(', ')}px.`)
      if (sizes.size > 8) parts.push('Consider consolidating type styles.')
      return parts.join(' ')
    }
    case 'copy': {
      const ids = scopeIds(doc, s.selection, s.pageId).filter((id) => /lorem|ipsum|dolor sit|placeholder|^text$/i.test(doc.nodes[id]?.text?.content ?? ''))
      if (!ids.length) return 'No placeholder text found.'
      let i = 0
      s.setProps(ids, (x) => {
        if (!x.text) return
        const t = x.text
        const kind = t.fontSize >= 22 || t.fontWeight >= 600 ? (t.content.length < 24 && x.name.toLowerCase().includes('button') ? 'button' : 'heading') : t.content.length < 18 ? 'label' : 'body'
        t.content = pick(COPY[kind as keyof typeof COPY], i++)
      })
      return `Replaced placeholder copy in ${ids.length} text layer${ids.length > 1 ? 's' : ''}.`
    }
    case 'names': {
      const ids = scopeIds(doc, s.selection, s.pageId)
      let n = 0
      s.setProps(ids, (x) => {
        const generic = /^(Frame|Rectangle|Ellipse|Text|Stack|Row|Column|Group)( \d+)?$/.test(x.name)
        if (!generic) return
        let name = x.name
        if (x.type === 'text' && x.text?.content) name = x.text.content.split('\n')[0].slice(0, 28)
        else if (x.type === 'frame') {
          const kids = x.children.map((c) => getEditor().doc.nodes[c]).filter(Boolean) as KNode[]
          const texts = kids.filter((k) => k.type === 'text')
          if (x.layout.mode === 'flex' && kids.length === 1 && texts.length === 1 && (x.fills.length || x.stroke)) name = 'Button'
          else if (kids.some((k) => k.type === 'image' || k.type === 'shader') && texts.length) name = 'Card'
          else if (x.layout.mode === 'flex') name = x.layout.direction === 'row' ? 'Row' : 'Stack'
          else name = 'Group'
        } else if (x.type === 'ellipse' && x.width <= 48) name = 'Avatar'
        if (name !== x.name) {
          x.name = name
          n++
        }
      })
      return n ? `Renamed ${n} layer${n > 1 ? 's' : ''}.` : 'Layer names already look meaningful.'
    }
  }
  throw new Error('Unknown action')
}

/** map a cloned node back to its source id by position in the clone list (same walk order) */
function srcIdOf(clone: KNode, all: KNode[], doc: KDoc, srcRoot: string): string | null {
  const order = [srcRoot, ...descendants(doc, srcRoot)]
  const i = all.indexOf(clone)
  void doc
  return order[i] ?? null
}
