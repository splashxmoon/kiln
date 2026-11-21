import { getEditor, normalizeSelection, childrenOf } from './store'
import { askText } from '../ui/Dialogs'
import { zoomBy, zoomToFit } from './Canvas'
import { cloneSubtree, solidFill } from './factory'
import type { KNode, Rect, Tool } from './types'
import { measure, measureSize, unionRects } from './geometry'
import { insertPreset, PRESETS } from './presets'
import { htmlToNodes, looksLikeHtml } from './importHtml'
import { insertImageFiles } from './images'
import { createNode } from './factory'
import { viewportCenterWorld } from './Canvas'
import { snapshotNode, downloadDataURL } from './snapshot'
import { isMac } from '../platform/os'
import { shortcut } from '../platform/keys'
import { cannotMakeComponent, createInstance, detach, instanceRootOf, mainOf, mainRootOf, makeComponent, relinkPasted, resetOverrides } from './components'

export interface Command {
  id: string
  label: string
  group: string
  /** display label, already for this platform: "⌘D" on the Mac, "Ctrl+D" elsewhere (see shortcut()) */
  keys?: string
  run: () => void
  enabled?: () => boolean
  /** for toggles: whether the option is on (menus draw a check) */
  checked?: () => boolean
}

type ViewKey = keyof ReturnType<typeof getEditor>['view']
const toggleView = (id: string, label: string, key: ViewKey, keys?: string, after?: (on: boolean) => void): Command => ({
  id,
  label,
  group: 'View',
  keys: keys && shortcut(keys),
  checked: () => getEditor().view[key],
  run: () => {
    const on = !getEditor().view[key]
    getEditor().setView({ [key]: on })
    after?.(on)
  },
})

const hasSel = () => getEditor().selection.length > 0
/** zoom shortcuts drop Shift when "Zoom using number keys" is on */
const numberKeys = () => (getEditor().view.numberKeyZoom ? '' : '⇧')
const hasFrameSel = () => getEditor().selection.some((id) => getEditor().doc.nodes[id]?.type === 'frame')

/* ------------------------------------------------------------------ clipboard */

const MARK = 'kiln/clipboard:'
/** `mains`: the clipboard layers copied from a main component root. */
type ClipPayload = { nodes: KNode[]; roots: string[]; sources?: string[]; mains?: string[] }
let memoryClipboard: ClipPayload | null = null

export async function copySelection(cut = false) {
  const s = getEditor()
  const ids = normalizeSelection(s.doc, s.selection)
  if (!ids.length) return
  const nodes: KNode[] = []
  const roots: string[] = []
  const origin = new Map<string, string>()
  for (const id of ids) {
    const [root, all] = cloneSubtree(s.doc.nodes, id, null, s.pageId, origin)
    const r = measure(id)
    if (r) {
      root.x = Math.round(r.x)
      root.y = Math.round(r.y)
    }
    // copied roots become top-level: freeze fill sizes to what was rendered
    const sz = measureSize(id)
    if (root.widthMode === 'fill') {
      root.widthMode = 'fixed'
      if (sz) root.width = Math.round(sz.w)
    }
    if (root.heightMode === 'fill') {
      root.heightMode = 'fixed'
      if (sz) root.height = Math.round(sz.h)
    }
    root.positioning = 'auto'
    nodes.push(...all)
    roots.push(root.id)
  }
  const mains = [...origin].filter(([, from]) => s.doc.nodes[from]?.main).map(([copy]) => copy)
  memoryClipboard = { nodes, roots, sources: ids, mains }
  try {
    await navigator.clipboard.writeText(MARK + JSON.stringify(memoryClipboard))
  } catch {
    /* clipboard may be unavailable; memory copy still works */
  }
  if (cut) s.deleteSelection()
  s.notify(`${cut ? 'Cut' : 'Copied'} ${ids.length} layer${ids.length > 1 ? 's' : ''}`)
}

function pasteNodes(payload: ClipPayload) {
  const s = getEditor()
  // fresh ids each paste
  const map: Record<string, KNode> = Object.fromEntries(payload.nodes.map((n) => [n.id, n]))
  const nodes: KNode[] = []
  const roots: string[] = []
  const origin = new Map<string, string>()
  for (const r of payload.roots) {
    const [root, all] = cloneSubtree(map, r, null, s.pageId, origin)
    nodes.push(...all)
    roots.push(root.id)
  }
  // a cut main (or one from another file) comes back as the main; other broken links are dropped
  const mains = new Set(payload.mains ?? [])
  relinkPasted(s.doc, nodes, (id) => mains.has(origin.get(id) ?? ''))
  const target = s.selection.length === 1 ? s.doc.nodes[s.selection[0]] : null
  // pasting while the copied layer itself is selected → paste next to it, not inside it
  const isSource = !!target && !!payload.sources?.includes(target.id)
  // an instance never goes inside its own main (⌘V twice after pasting a main): it goes beside the main
  const home = target ? mainRootOf(s.doc, target.id) : undefined
  const ownMain = !!home && nodes.some((n) => n.source === home.id)
  const parentId = ownMain ? home!.parentId : target?.type === 'frame' && !isSource ? target.id : target?.parentId ?? null
  if (parentId) {
    for (const id of roots) {
      const n = nodes.find((x) => x.id === id)!
      n.x = 16
      n.y = 16
    }
  } else {
    for (const id of roots) {
      const n = nodes.find((x) => x.id === id)!
      n.x += 24
      n.y += 24
    }
  }
  s.insertNodes(nodes, roots, parentId)
  s.set({ selection: roots })
}

export async function handlePaste(e: ClipboardEvent) {
  const s = getEditor()
  const dt = e.clipboardData
  if (!dt) return
  const files = [...dt.files].filter((f) => f.type.startsWith('image/'))
  if (files.length) {
    e.preventDefault()
    void insertImageFiles(files, viewportCenterWorld())
    return
  }
  const text = dt.getData('text/plain')
  if (text.startsWith(MARK)) {
    e.preventDefault()
    try {
      pasteNodes(JSON.parse(text.slice(MARK.length)))
    } catch {
      if (memoryClipboard) pasteNodes(memoryClipboard)
    }
    return
  }
  const html = dt.getData('text/html')
  // browsers/editors wrap plain copied text in <span>/<p>; only treat real structure as a design
  const structural = /<(div|section|button|nav|header|footer|main|article|img|svg|ul|ol|table|form)[\s>]/i
  const source = looksLikeHtml(text) && structural.test(text) ? text : html && structural.test(html) && !/<meta[^>]+vscode/i.test(html) ? html : null
  if (source) {
    e.preventDefault()
    const target = s.selection.length === 1 && s.doc.nodes[s.selection[0]]?.type === 'frame' ? s.selection[0] : null
    const { nodes, rootIds } = htmlToNodes(source, s.pageId, { width: target ? measure(target)?.w : 1280 })
    if (!rootIds.length) return
    if (!target) {
      const c = viewportCenterWorld()
      for (const id of rootIds) {
        const n = nodes.find((x) => x.id === id)!
        n.x = Math.round(c.x - n.width / 2)
        n.y = Math.round(c.y - n.height / 2)
      }
    }
    s.insertNodes(nodes, rootIds, target)
    s.set({ selection: rootIds })
    s.notify(`Pasted HTML as ${nodes.length} layers`)
    return
  }
  if (text.trim()) {
    e.preventDefault()
    const target = s.selection.length === 1 ? s.doc.nodes[s.selection[0]] : null
    if (target?.type === 'text') {
      s.setProps([target.id], (n) => void (n.text && (n.text.content = text)))
      return
    }
    const c = viewportCenterWorld()
    const n = createNode('text', s.pageId, { x: Math.round(c.x), y: Math.round(c.y) })
    n.text = { ...n.text!, content: text }
    if (text.length > 60) {
      n.widthMode = 'fixed'
      n.width = 420
    }
    const parentId = target?.type === 'frame' ? target.id : null
    if (parentId) {
      n.x = 16
      n.y = 16
    }
    s.addNode(n, parentId)
    s.set({ selection: [n.id] })
  } else if (memoryClipboard) {
    pasteNodes(memoryClipboard)
  }
}

/* ------------------------------------------------------------------ helpers */

function selectAll() {
  const s = getEditor()
  const first = s.selection[0] ? s.doc.nodes[s.selection[0]] : null
  const list = childrenOf(s.doc, first ? first.parentId : null, s.pageId)
  s.select(list.filter((id) => s.doc.nodes[id]?.visible && !s.doc.nodes[id]?.locked))
}

function nudge(dx: number, dy: number) {
  const s = getEditor()
  const ids = s.selection.filter((id) => {
    const n = s.doc.nodes[id]
    const p = n.parentId ? s.doc.nodes[n.parentId] : null
    return !n.locked && !(p && p.layout.mode === 'flex' && n.positioning !== 'absolute')
  })
  if (ids.length) {
    s.setProps(ids, (n) => {
      n.x += dx
      n.y += dy
    }, 'nudge')
    return
  }
  // flow children: arrows reorder within the flex parent
  const flow = s.selection.filter((id) => s.doc.nodes[id]?.parentId)
  if (!flow.length) return
  const parent = s.doc.nodes[s.doc.nodes[flow[0]].parentId!]
  const forward = parent.layout.direction === 'row' ? dx > 0 : dy > 0
  const backward = parent.layout.direction === 'row' ? dx < 0 : dy < 0
  if (forward) s.reorder('up')
  else if (backward) s.reorder('down')
}

/* ------------------------------------------------------------------ align & distribute */

export type AlignMode = 'l' | 'c' | 'r' | 't' | 'm' | 'b'

/** Selected layers that can be placed by x / y: unlocked, and not flow children of a flex frame. */
function placeable(): string[] {
  const s = getEditor()
  const doc = s.doc
  return normalizeSelection(doc, s.selection).filter((id) => {
    const n = doc.nodes[id]
    if (!n || n.locked) return false
    const p = n.parentId ? doc.nodes[n.parentId] : null
    return !(p && p.layout.mode === 'flex' && n.positioning !== 'absolute')
  })
}

/** Moves each layer by a world-space offset (rounded to whole pixels), as one undo step. */
function shiftBy(deltas: Record<string, { dx: number; dy: number }>) {
  const ids = Object.keys(deltas).filter((id) => Math.abs(deltas[id].dx) >= 0.01 || Math.abs(deltas[id].dy) >= 0.01)
  if (!ids.length) return
  getEditor().setProps(ids, (n) => {
    const d = deltas[n.id]
    n.x = Math.round(n.x + d.dx)
    n.y = Math.round(n.y + d.dy)
  })
}

const canAlign = () => {
  const ids = placeable()
  return ids.length > 1 || (ids.length === 1 && !!getEditor().doc.nodes[ids[0]].parentId)
}
const canDistribute = () => placeable().length > 2

/**
 * Aligns the selection's edges or centres: several layers to their combined bounds, one layer
 * to its parent frame.
 */
export function alignSelection(mode: AlignMode) {
  const doc = getEditor().doc
  const ids = placeable()
  const rects = Object.fromEntries(ids.map((id) => [id, measure(id)]).filter(([, r]) => r)) as Record<string, Rect>
  const list = Object.keys(rects)
  if (!list.length) return
  const ref = list.length === 1 ? (doc.nodes[list[0]].parentId ? measure(doc.nodes[list[0]].parentId!) : null) : unionRects(Object.values(rects))
  if (!ref) return
  const deltas: Record<string, { dx: number; dy: number }> = {}
  for (const id of list) {
    const r = rects[id]
    let dx = 0
    let dy = 0
    if (mode === 'l') dx = ref.x - r.x
    if (mode === 'c') dx = ref.x + ref.w / 2 - (r.x + r.w / 2)
    if (mode === 'r') dx = ref.x + ref.w - (r.x + r.w)
    if (mode === 't') dy = ref.y - r.y
    if (mode === 'm') dy = ref.y + ref.h / 2 - (r.y + r.h / 2)
    if (mode === 'b') dy = ref.y + ref.h - (r.y + r.h)
    deltas[id] = { dx, dy }
  }
  shiftBy(deltas)
}

/**
 * Spaces three or more layers evenly along an axis: the first and last stay put and the
 * gaps between neighbours become equal (Figma's "distribute spacing").
 */
export function distributeSelection(axis: 'x' | 'y') {
  const ids = placeable()
  const items = ids.map((id) => ({ id, r: measure(id) })).filter((i): i is { id: string; r: Rect } => !!i.r)
  if (items.length < 3) return
  const start = (r: Rect) => (axis === 'x' ? r.x : r.y)
  const size = (r: Rect) => (axis === 'x' ? r.w : r.h)
  items.sort((a, b) => start(a.r) - start(b.r) || a.id.localeCompare(b.id))
  const first = items[0].r
  const end = Math.max(...items.map((i) => start(i.r) + size(i.r)))
  const total = end - start(first) - items.reduce((sum, i) => sum + size(i.r), 0)
  const gap = total / (items.length - 1)
  const deltas: Record<string, { dx: number; dy: number }> = {}
  let at = start(first)
  for (const { id, r } of items) {
    const d = at - start(r)
    deltas[id] = axis === 'x' ? { dx: d, dy: 0 } : { dx: 0, dy: d }
    at += size(r) + gap
  }
  shiftBy(deltas)
}

/* ------------------------------------------------------------------ copy / paste properties */

/** The look of a layer, without its content, geometry or name. */
type LayerStyle = Pick<KNode, 'fills' | 'stroke' | 'shadows' | 'blur' | 'backdropBlur' | 'radius' | 'opacity' | 'blend'> & {
  text?: Omit<NonNullable<KNode['text']>, 'content'>
}
let copiedStyle: LayerStyle | null = null

function copyStyle() {
  const s = getEditor()
  const n = s.selection.length === 1 ? s.doc.nodes[s.selection[0]] : null
  if (!n) return
  const { fills, stroke, shadows, blur, backdropBlur, radius, opacity, blend } = n
  let text: LayerStyle['text']
  if (n.text) {
    const { content: _content, ...rest } = n.text
    text = rest
  }
  copiedStyle = structuredClone({ fills, stroke, shadows, blur, backdropBlur, radius, opacity, blend, text })
  s.notify(`Copied the properties of ${n.name}`)
}

function pasteStyle() {
  const st = copiedStyle
  const s = getEditor()
  const ids = s.selection.filter((id) => !s.doc.nodes[id]?.locked)
  if (!st || !ids.length) return
  s.setProps(ids, (n) => {
    const v = structuredClone(st)
    // text's colour and a shape's fill are the same property across the two kinds (as in Figma)
    if (v.text && !n.text) {
      const f = solidFill(v.text.color)
      if (v.text.tokenId) f.tokenId = v.text.tokenId
      n.fills = [f]
    } else if (!v.text && n.text) {
      const solid = v.fills.find((f) => f.visible && f.type === 'solid')
      if (solid) {
        n.text.color = solid.color
        if (solid.tokenId) n.text.tokenId = solid.tokenId
        else delete n.text.tokenId
      }
    } else n.fills = v.fills
    n.stroke = v.stroke
    n.shadows = v.shadows
    n.blur = v.blur
    n.backdropBlur = v.backdropBlur
    n.radius = v.radius
    n.opacity = v.opacity
    n.blend = v.blend
    // type styles go only onto text layers, and the words stay
    if (v.text && n.text) {
      Object.assign(n.text, v.text)
      // a plain colour replaces a token-bound one (the token would otherwise win)
      if (!v.text.tokenId) delete n.text.tokenId
    }
  })
  s.notify(`Pasted properties onto ${ids.length} layer${ids.length > 1 ? 's' : ''}`)
}

const ALIGN_KEYS: Record<string, string> = {
  KeyA: 'arrange.alignLeft',
  KeyH: 'arrange.alignCenter',
  KeyD: 'arrange.alignRight',
  KeyW: 'arrange.alignTop',
  KeyV: 'arrange.alignMiddle',
  KeyS: 'arrange.alignBottom',
}

function selectParent() {
  const s = getEditor()
  const parents = [...new Set(s.selection.map((id) => s.doc.nodes[id]?.parentId).filter(Boolean))] as string[]
  if (parents.length) s.select(parents)
  else s.select([])
}
function selectChildren() {
  const s = getEditor()
  const kids = s.selection.flatMap((id) => s.doc.nodes[id]?.children ?? [])
  if (kids.length) s.select(kids)
}

/* ------------------------------------------------------------------ select matching */

/** What "same fill" compares: a text layer's colour, or a shape's visible fills (ids aside). */
function fillKey(n: KNode): string | null {
  const solid = (color: string, tokenId: string | undefined, opacity: number) => `solid:${tokenId ? 'token:' + tokenId : color.trim().toLowerCase()}@${opacity}`
  if (n.type === 'text') return n.text ? solid(n.text.color, n.text.tokenId, 1) : null
  const fills = n.fills.filter((f) => f.visible)
  if (!fills.length) return null
  return fills
    .map((f) =>
      f.type === 'solid'
        ? solid(f.color, f.tokenId, f.opacity)
        : f.type === 'image'
          ? `image:${f.src ?? ''}:${f.fit ?? 'cover'}@${f.opacity}`
          : `${f.type}:${f.angle}:${f.stops.map((st) => `${st.color.trim().toLowerCase()} ${st.pos}`).join(',')}@${f.opacity}`,
    )
    .join('|')
}
const fontKey = (n: KNode) => (n.type === 'text' && n.text ? `${n.text.fontFamily}|${n.text.fontWeight}|${n.text.italic ? 'i' : ''}` : null)
const typeKey = (n: KNode) => n.type

/**
 * Selects every visible, unlocked layer on the current page that matches one of the selected
 * layers by `key` (a null key never matches).
 */
function selectMatching(key: (n: KNode) => string | null) {
  const s = getEditor()
  const want = new Set(s.selection.map((id) => (s.doc.nodes[id] ? key(s.doc.nodes[id]) : null)).filter((k): k is string => k !== null))
  if (!want.size) return
  const out: string[] = []
  const walk = (ids: readonly string[]) => {
    for (const id of ids) {
      const n = s.doc.nodes[id]
      // a hidden or locked frame hides / locks what is inside it too
      if (!n || !n.visible || n.locked) continue
      const k = key(n)
      if (k !== null && want.has(k)) out.push(id)
      walk(n.children)
    }
  }
  walk(childrenOf(s.doc, null, s.pageId))
  s.select(out)
  if (out.length > 1) s.notify(`Selected ${out.length} layers`)
}
const selHas = (key: (n: KNode) => string | null) => () => {
  const s = getEditor()
  return s.selection.some((id) => !!s.doc.nodes[id] && key(s.doc.nodes[id]) !== null)
}

/* ------------------------------------------------------------------ batch rename */

/** The selected layers in the layers panel's order (top of the list first). */
export function inLayerOrder(ids: readonly string[]): string[] {
  const s = getEditor()
  const want = new Set(ids)
  const out: string[] = []
  const walk = (list: readonly string[]) => {
    for (let i = list.length - 1; i >= 0; i--) {
      const n = s.doc.nodes[list[i]]
      if (!n) continue
      if (want.has(n.id)) out.push(n.id)
      walk(n.children)
    }
  }
  walk(childrenOf(s.doc, null, s.pageId))
  return out
}

export interface RenameRule {
  /** new name; `#` (a run of them pads: `##` → 01) or `$n` is the layer's number. Empty keeps the name. */
  pattern: string
  find: string
  replace: string
}

/** The names a batch rename gives `ids` (already in layer order), numbering from 1. */
export function batchNames(names: readonly string[], rule: RenameRule): string[] {
  return names.map((old, i) => {
    let name = rule.pattern ? rule.pattern.replace(/\$n|#+/g, (m) => (m === '$n' ? String(i + 1) : String(i + 1).padStart(m.length, '0'))) : old
    if (rule.find) name = name.split(rule.find).join(rule.replace)
    name = name.trim()
    return name || old
  })
}

/** Renames the layers in one undo step. */
export function applyBatchRename(ids: readonly string[], rule: RenameRule) {
  const s = getEditor()
  const live = ids.filter((id) => s.doc.nodes[id])
  const next = batchNames(live.map((id) => s.doc.nodes[id].name), rule)
  const names = new Map(live.map((id, i) => [id, next[i]]))
  const changed = live.filter((id) => s.doc.nodes[id].name !== names.get(id))
  if (!changed.length) return
  s.setProps(changed, (n) => void (n.name = names.get(n.id) ?? n.name))
}

/* ------------------------------------------------------------------ registry */

const tool = (t: Tool) => () => getEditor().setTool(t)

/* ------------------------------------------------------------------ components (components.ts) */

const oneSel = () => (getEditor().selection.length === 1 ? getEditor().selection[0] : null)
const selInstance = () => {
  const id = oneSel()
  return id ? instanceRootOf(getEditor().doc, id) : undefined
}

/** Insert an instance of a main: beside the main when it is a top-level layer on this page, else at the middle of the view. */
export function insertInstance(mainId: string) {
  const s = getEditor()
  const m = s.doc.nodes[mainId]
  if (!m?.main) return
  const r = m.pageId === s.pageId ? measure(mainId) : null
  let at: { x: number; y: number }
  if (r && !m.parentId) at = { x: r.x + r.w + 40, y: r.y }
  else {
    const c = viewportCenterWorld()
    const sz = measureSize(mainId) ?? { w: m.width, h: m.height }
    at = { x: c.x - sz.w / 2, y: c.y - sz.h / 2 }
  }
  if (createInstance(mainId, { pageId: s.pageId, ...at })) s.notify(`Inserted ${m.name}`)
}

/** Select a main component (switching page if needed) and bring it into view. */
export function goToMain(mainId: string) {
  const s = getEditor()
  const m = s.doc.nodes[mainId]
  if (!m) return
  if (m.pageId !== s.pageId) s.setPage(m.pageId)
  s.select([mainId])
  requestAnimationFrame(() => zoomToFit([mainId]))
}

export const COMMANDS: Command[] = [
  { id: 'tool.move', label: 'Move tool', group: 'Tools', keys: 'V', run: tool('move') },
  { id: 'tool.hand', label: 'Hand tool', group: 'Tools', keys: 'H', run: tool('hand') },
  { id: 'tool.frame', label: 'Frame tool', group: 'Tools', keys: 'F', run: tool('frame') },
  { id: 'tool.rect', label: 'Rectangle tool', group: 'Tools', keys: 'R', run: tool('rect') },
  { id: 'tool.ellipse', label: 'Ellipse tool', group: 'Tools', keys: 'O', run: tool('ellipse') },
  { id: 'tool.pen', label: 'Pen tool', group: 'Tools', keys: 'P', run: tool('pen') },
  { id: 'tool.text', label: 'Text tool', group: 'Tools', keys: 'T', run: tool('text') },
  { id: 'tool.image', label: 'Image tool', group: 'Tools', keys: 'I', run: tool('image') },
  { id: 'tool.shader', label: 'Shader tool', group: 'Tools', keys: 'S', run: tool('shader') },
  { id: 'tool.comment', label: 'Comment tool', group: 'Tools', keys: 'C', run: tool('comment') },

  { id: 'edit.undo', label: 'Undo', group: 'Edit', keys: shortcut('⌘Z'), run: () => getEditor().undo() },
  { id: 'edit.redo', label: 'Redo', group: 'Edit', keys: shortcut('⇧⌘Z'), run: () => getEditor().redo() },
  { id: 'edit.copy', label: 'Copy', group: 'Edit', keys: shortcut('⌘C'), run: () => void copySelection(), enabled: hasSel },
  { id: 'edit.cut', label: 'Cut', group: 'Edit', keys: shortcut('⌘X'), run: () => void copySelection(true), enabled: hasSel },
  { id: 'edit.duplicate', label: 'Duplicate', group: 'Edit', keys: shortcut('⌘D'), run: () => void getEditor().duplicateSelection(), enabled: hasSel },
  { id: 'edit.delete', label: 'Delete', group: 'Edit', keys: shortcut(isMac ? '⌫' : '⌦'), run: () => getEditor().deleteSelection(), enabled: hasSel },
  { id: 'edit.selectAll', label: 'Select all', group: 'Edit', keys: shortcut('⌘A'), run: selectAll },
  { id: 'edit.selectParent', label: 'Select parent', group: 'Edit', keys: shortcut('⇧↵'), run: selectParent, enabled: hasSel },
  { id: 'edit.selectChildren', label: 'Select children', group: 'Edit', keys: shortcut('↵'), run: selectChildren, enabled: hasFrameSel },
  { id: 'edit.selectSameFill', label: 'Select same fill', group: 'Edit', run: () => selectMatching(fillKey), enabled: selHas(fillKey) },
  { id: 'edit.selectSameFont', label: 'Select same font', group: 'Edit', run: () => selectMatching(fontKey), enabled: selHas(fontKey) },
  { id: 'edit.selectSameType', label: 'Select same type', group: 'Edit', run: () => selectMatching(typeKey), enabled: hasSel },
  { id: 'edit.rename', label: 'Rename layer', group: 'Edit', keys: shortcut('⌘R'), run: () => {
    const s = getEditor()
    // several layers: the batch rename dialog (Menus.tsx) numbers them / finds and replaces
    const many = inLayerOrder(s.selection)
    if (many.length > 1) return void window.dispatchEvent(new CustomEvent('kiln:batch-rename', { detail: { ids: many } }))
    const n = s.selection[0] ? s.doc.nodes[s.selection[0]] : null
    if (!n) return
    // rename inline in the layers panel; fall back to a Kiln dialog
    s.set({ leftTab: 'layers' })
    requestAnimationFrame(() => {
      const detail: { id: string; handled?: boolean } = { id: n.id }
      window.dispatchEvent(new CustomEvent('kiln:rename-layer', { detail }))
      if (detail.handled) return
      void askText({ title: 'Rename layer', value: n.name }).then((v) => v && getEditor().setProps([n.id], (x) => void (x.name = v)))
    })
  }, enabled: hasSel },

  { id: 'layout.flex', label: 'Add / remove flex layout', group: 'Layout', keys: shortcut('⇧A'), run: () => getEditor().toggleFlex(), enabled: hasSel },
  { id: 'layout.wrap', label: 'Wrap in frame', group: 'Layout', keys: shortcut('⌥⌘G'), run: () => getEditor().wrapInFrame(false), enabled: hasSel },
  { id: 'layout.wrapFlex', label: 'Wrap in flex stack', group: 'Layout', keys: shortcut('⌘G'), run: () => getEditor().wrapInFrame(true), enabled: hasSel },
  { id: 'layout.unwrap', label: 'Remove frame', group: 'Layout', keys: shortcut('⇧⌘G'), run: () => getEditor().unwrap(), enabled: hasFrameSel },
  { id: 'layout.fillW', label: 'Width: fill container', group: 'Layout', run: () => getEditor().setProps(getEditor().selection, (n) => void (n.parentId && (n.widthMode = 'fill'))), enabled: hasSel },
  { id: 'layout.hugW', label: 'Width: hug contents', group: 'Layout', run: () => getEditor().setProps(getEditor().selection, (n) => void ((n.type === 'text' || n.layout.mode === 'flex') && (n.widthMode = 'hug'))), enabled: hasSel },
  { id: 'order.front', label: 'Bring to front', group: 'Arrange', keys: shortcut('⇧⌘]'), run: () => getEditor().reorder('top'), enabled: hasSel },
  { id: 'order.forward', label: 'Bring forward', group: 'Arrange', keys: shortcut('⌘]'), run: () => getEditor().reorder('up'), enabled: hasSel },
  { id: 'order.backward', label: 'Send backward', group: 'Arrange', keys: shortcut('⌘['), run: () => getEditor().reorder('down'), enabled: hasSel },
  { id: 'order.back', label: 'Send to back', group: 'Arrange', keys: shortcut('⇧⌘['), run: () => getEditor().reorder('bottom'), enabled: hasSel },
  { id: 'arrange.alignLeft', label: 'Align left', group: 'Arrange', keys: shortcut('⌥A'), run: () => alignSelection('l'), enabled: canAlign },
  { id: 'arrange.alignCenter', label: 'Align horizontal centers', group: 'Arrange', keys: shortcut('⌥H'), run: () => alignSelection('c'), enabled: canAlign },
  { id: 'arrange.alignRight', label: 'Align right', group: 'Arrange', keys: shortcut('⌥D'), run: () => alignSelection('r'), enabled: canAlign },
  { id: 'arrange.alignTop', label: 'Align top', group: 'Arrange', keys: shortcut('⌥W'), run: () => alignSelection('t'), enabled: canAlign },
  { id: 'arrange.alignMiddle', label: 'Align vertical centers', group: 'Arrange', keys: shortcut('⌥V'), run: () => alignSelection('m'), enabled: canAlign },
  { id: 'arrange.alignBottom', label: 'Align bottom', group: 'Arrange', keys: shortcut('⌥S'), run: () => alignSelection('b'), enabled: canAlign },
  { id: 'arrange.distributeH', label: 'Distribute horizontal spacing', group: 'Arrange', keys: shortcut('⌥⇧H'), run: () => distributeSelection('x'), enabled: canDistribute },
  { id: 'arrange.distributeV', label: 'Distribute vertical spacing', group: 'Arrange', keys: shortcut('⌥⇧V'), run: () => distributeSelection('y'), enabled: canDistribute },
  { id: 'edit.copyStyle', label: 'Copy properties', group: 'Edit', keys: shortcut('⌥⌘C'), run: copyStyle, enabled: () => getEditor().selection.length === 1 },
  { id: 'edit.pasteStyle', label: 'Paste properties', group: 'Edit', keys: shortcut('⌥⌘V'), run: pasteStyle, enabled: () => !!copiedStyle && hasSel() },
  { id: 'layer.hide', label: 'Show / hide', group: 'Arrange', keys: shortcut('⇧⌘H'), run: () => getEditor().setProps(getEditor().selection, (n) => void (n.visible = !n.visible)), enabled: hasSel },
  { id: 'layer.lock', label: 'Lock / unlock', group: 'Arrange', keys: shortcut('⇧⌘L'), run: () => getEditor().setProps(getEditor().selection, (n) => void (n.locked = !n.locked)), enabled: hasSel },

  { id: 'view.in', label: 'Zoom in', group: 'View', keys: '+', run: () => zoomBy(1.25) },
  { id: 'view.out', label: 'Zoom out', group: 'View', keys: shortcut('−'), run: () => zoomBy(0.8) },
  { id: 'view.100', label: 'Zoom to 100%', group: 'View', get keys() { return shortcut(numberKeys() + '0') }, run: () => zoomBy(1 / getEditor().camera.zoom) },
  { id: 'view.fit', label: 'Zoom to fit', group: 'View', get keys() { return shortcut(numberKeys() + '1') }, run: () => zoomToFit() },
  { id: 'view.sel', label: 'Zoom to selection', group: 'View', get keys() { return shortcut(numberKeys() + '2') }, run: () => zoomToFit(getEditor().selection), enabled: hasSel },
  toggleView('view.zoomCenters', 'Zoom centers selection', 'zoomCentersSelection'),
  toggleView('view.numberKeys', 'Zoom using number keys', 'numberKeyZoom'),
  toggleView('view.invertZoom', 'Invert zoom direction', 'invertZoom'),
  toggleView('view.wheelZoom', 'Scroll wheel zooms', 'wheelZoom'),
  toggleView('view.rightPan', 'Right click to pan', 'rightClickPan'),
  toggleView('view.pixelGrid', 'Show pixel grid', 'pixelGrid', "⇧'"),
  toggleView('view.snapPixel', 'Snap to pixel', 'snapToPixel', "⇧⌘'"),
  toggleView('view.layoutGuides', 'Layout guides', 'layoutGuides', 'G'),
  toggleView('view.presence', 'Agent presence', 'presence', '⇧M'),
  toggleView('view.deepSelect', 'Use deep selection', 'deepSelect'),
  toggleView('view.comments', 'Show comments', 'showComments', '⇧C', (on) => {
    if (!on) getEditor().set({ activeCommentId: null })
  }),
  toggleView('view.leftPanel', 'Show layers panel', 'leftPanel', '⌘\\'),
  { id: 'view.code', label: 'Show code', group: 'View', keys: shortcut('⌥C'), run: () => getEditor().set({ rightTab: 'code' }) },
  { id: 'view.agent', label: 'Open agent', group: 'View', keys: shortcut('⌘J'), run: () => getEditor().set({ rightTab: 'agent' }) },
  { id: 'view.design', label: 'Show design panel', group: 'View', run: () => getEditor().set({ rightTab: 'design' }) },
  { id: 'view.review', label: 'Review design', group: 'View', run: () => getEditor().set({ rightTab: 'review' }) },
  { id: 'view.shortcuts', label: 'Keyboard shortcuts', group: 'View', keys: '?', run: () => getEditor().set({ shortcutsOpen: true }) },

  { id: 'export.png', label: 'Export as PNG', group: 'Export', keys: shortcut('⇧⌘E'), enabled: hasSel, run: async () => {
    const s = getEditor()
    const id = s.selection[0]
    const url = await snapshotNode(id, { scale: 2 })
    if (url) downloadDataURL(url, `${s.doc.nodes[id].name.replace(/[^\w-]+/g, '-')}@2x.png`)
  } },
  { id: 'page.add', label: 'New page', group: 'Pages', run: () => getEditor().addPage() },
  { id: 'component.create', label: 'Create component', group: 'Components', keys: shortcut('⌥⌘K'), enabled: () => { const id = oneSel(); return !!id && !cannotMakeComponent(getEditor().doc, id) }, run: () => { const id = oneSel(); if (id && makeComponent(id)) getEditor().notify('Created a component') } },
  { id: 'component.goToMain', label: 'Go to main component', group: 'Components', enabled: () => !!selInstance(), run: () => { const m = mainOf(getEditor().doc, oneSel()!); if (m) goToMain(m.id) } },
  { id: 'component.reset', label: 'Reset overrides', group: 'Components', enabled: () => !!getEditor().doc.nodes[oneSel() ?? '']?.source && !!selInstance(), run: () => { if (resetOverrides(oneSel()!)) getEditor().notify('Reset to the main component') } },
  { id: 'component.detach', label: 'Detach instance', group: 'Components', keys: shortcut('⌥⌘B'), enabled: () => !!selInstance(), run: () => { if (detach(oneSel()!)) getEditor().notify('Detached the instance') } },
  { id: 'component.insertInstance', label: 'Insert instance', group: 'Components', enabled: () => !!getEditor().doc.nodes[oneSel() ?? '']?.main, run: () => insertInstance(oneSel()!) },
  // VersionsDialog.tsx (mounted by Menus.tsx) answers these
  { id: 'file.saveVersion', label: 'Name this version', group: 'File', keys: shortcut('⌥⌘S'), run: () => void window.dispatchEvent(new CustomEvent('kiln:save-version')) },
  { id: 'file.versions', label: 'Version history', group: 'File', run: () => void window.dispatchEvent(new CustomEvent('kiln:versions')) },
  ...PRESETS.map((p) => ({ id: 'insert.' + p.id, label: `Insert ${p.label}`, group: `Insert · ${p.group}`, run: () => insertPreset(p.id) })),
]

export function runCommand(id: string) {
  const c = COMMANDS.find((c) => c.id === id)
  if (c && (!c.enabled || c.enabled())) c.run()
}

/* ------------------------------------------------------------------ keyboard */

export function isTypingTarget(t: EventTarget | null) {
  const el = t as HTMLElement | null
  if (!el) return false
  return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
}

export function handleKeyDown(e: KeyboardEvent) {
  const s = getEditor()
  // held Alt / Option: the overlay measures distances (cleared on key up and window blur)
  // (not while typing: Option makes characters there, e.g. ⌥2 → ™)
  if (e.key === 'Alt' && !s.altDown && !isTypingTarget(e.target)) s.set({ altDown: true })
  // no structural edits mid-drag (the drag holds references to the dragged layers)
  if (s.drag && e.key !== ' ' && e.key !== 'Shift' && e.key !== 'Alt' && e.key !== 'Meta' && e.key !== 'Control') {
    e.preventDefault()
    return
  }
  if (e.key === ' ' && !isTypingTarget(e.target)) {
    if (!s.spaceDown) s.set({ spaceDown: true })
    e.preventDefault()
    return
  }
  if (isTypingTarget(e.target)) return
  // AltGr (European layouts) arrives as Ctrl+Alt: it is typing [ ] \ { }, not a shortcut
  if (e.getModifierState?.('AltGraph')) return
  const mod = e.metaKey || e.ctrlKey
  const k = e.key.toLowerCase()
  const run = (id: string) => {
    e.preventDefault()
    runCommand(id)
  }

  // ⌥⌘K / ⌥⌘B by physical key (⌥ changes e.key on the Mac); before ⌘K, which opens the palette
  if (mod && e.altKey && !e.shiftKey && e.code === 'KeyK') return run('component.create')
  if (mod && e.altKey && !e.shiftKey && e.code === 'KeyB') return run('component.detach')
  if (mod && k === 'k') return void (e.preventDefault(), s.set({ paletteOpen: !s.paletteOpen }))
  // drawing with the pen: Enter finishes, Delete / ⌘Z take back the last anchor (Esc finishes below)
  const pen = s.penDraft
  if (pen && !s.paletteOpen) {
    if (e.key === 'Enter') {
      e.preventDefault()
      s.commitPen(false)
      return s.setTool('move')
    }
    if (e.key === 'Backspace' || e.key === 'Delete' || (mod && k === 'z' && !e.shiftKey)) {
      e.preventDefault()
      const points = pen.points.slice(0, -1)
      return s.set({ penDraft: points.length ? { ...pen, points, closing: false } : null })
    }
  }
  if (e.key === 'Escape') {
    if (s.preview) return s.set({ preview: null })
    if (s.paletteOpen || s.shortcutsOpen || s.contextMenu) return s.set({ paletteOpen: false, shortcutsOpen: false, contextMenu: null })
    if (s.tool !== 'move') return s.setTool('move')
    if (s.selection.length) return selectParent()
    return
  }
  if (mod && k === 'z') return run(e.shiftKey ? 'edit.redo' : 'edit.undo')
  if (mod && k === 'y') return run('edit.redo')
  // ⌥⌘C / ⌥⌘V by physical key: on the Mac ⌥ changes e.key ("ç", "√")
  if (mod && e.altKey && !e.shiftKey && e.code === 'KeyC') return run('edit.copyStyle')
  if (mod && e.altKey && !e.shiftKey && e.code === 'KeyV') return run('edit.pasteStyle')
  if (mod && e.altKey && !e.shiftKey && e.code === 'KeyS') return run('file.saveVersion')
  if (mod && k === 'c' && !e.shiftKey) return run('edit.copy')
  if (mod && k === 'x') return run('edit.cut')
  if (mod && k === 'd') return run('edit.duplicate')
  if (mod && k === 'a') return run('edit.selectAll')
  if (mod && k === 'r') return run('edit.rename')
  if (mod && k === 'j') return run('view.agent')
  if (mod && k === 'g') return run(e.shiftKey ? 'layout.unwrap' : e.altKey ? 'layout.wrap' : 'layout.wrapFlex')
  if (mod && e.shiftKey && k === 'h') return run('layer.hide')
  if (mod && e.shiftKey && k === 'l') return run('layer.lock')
  if (mod && e.shiftKey && k === 'e') return run('export.png')
  if (mod && (e.key === ']' || e.key === '}')) return run(e.shiftKey ? 'order.front' : 'order.forward')
  if (mod && (e.key === '[' || e.key === '{')) return run(e.shiftKey ? 'order.back' : 'order.backward')
  if (mod && (e.key === '=' || e.key === '+')) return run('view.in')
  if (mod && (e.key === '-' || e.key === '_')) return run('view.out')
  if (mod && e.key === '0') return run('view.100')
  if (mod && e.shiftKey && e.code === 'Quote') return run('view.snapPixel')
  if (mod && e.key === '\\') return run('view.leftPanel')
  if (mod) return
  if (e.altKey && e.code === 'KeyC') return run('view.code')
  // align ⌥A ⌥H ⌥D ⌥W ⌥V ⌥S and distribute ⌥⇧H ⌥⇧V, by physical key (⌥ changes e.key on the Mac)
  if (e.altKey && !e.shiftKey && ALIGN_KEYS[e.code]) return run(ALIGN_KEYS[e.code])
  if (e.altKey && e.shiftKey && e.code === 'KeyH') return run('arrange.distributeH')
  if (e.altKey && e.shiftKey && e.code === 'KeyV') return run('arrange.distributeV')
  if (e.shiftKey && !e.altKey && e.code === 'Quote') return run('view.pixelGrid')
  if (e.shiftKey && !e.altKey && e.code === 'KeyM') return run('view.presence')
  if (e.shiftKey && !e.altKey && e.code === 'KeyC') return run('view.comments')
  if (!e.shiftKey && !e.altKey && k === 'g') return run('view.layoutGuides')
  if (!e.altKey && (e.key === '=' || e.key === '+')) return run('view.in')
  if (!e.altKey && (e.key === '-' || e.key === '_')) return run('view.out')
  if (s.view.numberKeyZoom && !e.shiftKey && !e.altKey) {
    if (e.code === 'Digit0') return run('view.100')
    if (e.code === 'Digit1') return run('view.fit')
    if (e.code === 'Digit2') return run('view.sel')
  }
  if (e.shiftKey && (e.code === 'Digit1' || e.key === '!')) return run('view.fit')
  if (e.shiftKey && (e.code === 'Digit2' || e.key === '@')) return run('view.sel')
  if (e.shiftKey && (e.code === 'Digit0' || e.key === ')')) return run('view.100')
  if (e.shiftKey && k === 'a') return run('layout.flex')
  if (e.key === 'Enter') {
    const n = s.selection.length === 1 ? s.doc.nodes[s.selection[0]] : null
    if (n?.type === 'text') return void (e.preventDefault(), s.set({ editingTextId: n.id }))
    return run(e.shiftKey ? 'edit.selectParent' : 'edit.selectChildren')
  }
  if (e.key === 'Backspace' || e.key === 'Delete') return run('edit.delete')
  if (e.key === '?') return run('view.shortcuts')
  if (e.key.startsWith('Arrow')) {
    e.preventDefault()
    const d = e.shiftKey ? 10 : 1
    if (e.key === 'ArrowLeft') nudge(-d, 0)
    if (e.key === 'ArrowRight') nudge(d, 0)
    if (e.key === 'ArrowUp') nudge(0, -d)
    if (e.key === 'ArrowDown') nudge(0, d)
    return
  }
  const tools: Record<string, Tool> = { v: 'move', h: 'hand', f: 'frame', a: 'frame', r: 'rect', o: 'ellipse', p: 'pen', t: 'text', i: 'image', s: 'shader', c: 'comment' }
  if (!e.shiftKey && !e.altKey && tools[k]) {
    e.preventDefault()
    s.setTool(tools[k])
  }
}

export function handleKeyUp(e: KeyboardEvent) {
  if (e.key === ' ') getEditor().set({ spaceDown: false })
  if (e.key === 'Alt' && getEditor().altDown) getEditor().set({ altDown: false })
}
