import { getEditor, normalizeSelection, childrenOf } from './store'
import { askText } from '../ui/Dialogs'
import { zoomBy, zoomToFit } from './Canvas'
import { cloneSubtree } from './factory'
import type { KNode, Tool } from './types'
import { measure, measureSize } from './geometry'
import { insertPreset, PRESETS } from './presets'
import { htmlToNodes, looksLikeHtml } from './importHtml'
import { insertImageFiles } from './images'
import { createNode } from './factory'
import { viewportCenterWorld } from './Canvas'
import { snapshotNode, downloadDataURL } from './snapshot'
import { isMac } from '../platform/os'
import { shortcut } from '../platform/keys'

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
let memoryClipboard: { nodes: KNode[]; roots: string[]; sources?: string[] } | null = null

export async function copySelection(cut = false) {
  const s = getEditor()
  const ids = normalizeSelection(s.doc, s.selection)
  if (!ids.length) return
  const nodes: KNode[] = []
  const roots: string[] = []
  for (const id of ids) {
    const [root, all] = cloneSubtree(s.doc.nodes, id, null, s.pageId)
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
  memoryClipboard = { nodes, roots, sources: ids }
  try {
    await navigator.clipboard.writeText(MARK + JSON.stringify(memoryClipboard))
  } catch {
    /* clipboard may be unavailable; memory copy still works */
  }
  if (cut) s.deleteSelection()
  s.notify(`${cut ? 'Cut' : 'Copied'} ${ids.length} layer${ids.length > 1 ? 's' : ''}`)
}

function pasteNodes(payload: { nodes: KNode[]; roots: string[]; sources?: string[] }) {
  const s = getEditor()
  // fresh ids each paste
  const map: Record<string, KNode> = Object.fromEntries(payload.nodes.map((n) => [n.id, n]))
  const nodes: KNode[] = []
  const roots: string[] = []
  for (const r of payload.roots) {
    const [root, all] = cloneSubtree(map, r, null, s.pageId)
    nodes.push(...all)
    roots.push(root.id)
  }
  const target = s.selection.length === 1 ? s.doc.nodes[s.selection[0]] : null
  // pasting while the copied layer itself is selected → paste next to it, not inside it
  const isSource = !!target && !!payload.sources?.includes(target.id)
  const parentId = target?.type === 'frame' && !isSource ? target.id : target?.parentId ?? null
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

/* ------------------------------------------------------------------ registry */

const tool = (t: Tool) => () => getEditor().setTool(t)

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
  { id: 'edit.rename', label: 'Rename layer', group: 'Edit', keys: shortcut('⌘R'), run: () => {
    const s = getEditor()
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
  { id: 'view.shortcuts', label: 'Keyboard shortcuts', group: 'View', keys: '?', run: () => getEditor().set({ shortcutsOpen: true }) },

  { id: 'export.png', label: 'Export as PNG', group: 'Export', keys: shortcut('⇧⌘E'), enabled: hasSel, run: async () => {
    const s = getEditor()
    const id = s.selection[0]
    const url = await snapshotNode(id, { scale: 2 })
    if (url) downloadDataURL(url, `${s.doc.nodes[id].name.replace(/[^\w-]+/g, '-')}@2x.png`)
  } },
  { id: 'page.add', label: 'New page', group: 'Pages', run: () => getEditor().addPage() },
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
}
