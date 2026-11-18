import { create } from 'zustand'
import { produce, type Draft } from 'immer'
import type { Camera, Comment, KDoc, KNode, Page, PathPoint, Tool } from './types'
import { cloneSubtree, createNode, createPage, emptyDoc, uid } from './factory'
import { measure, measureLocal, measureSize } from './geometry'
import { buildPath } from './vector'

/* ------------------------------------------------------------------ helpers */

export function childrenOf(doc: KDoc, parentId: string | null, pageId: string): string[] {
  if (parentId) return doc.nodes[parentId]?.children ?? []
  return doc.pages.find((p) => p.id === pageId)?.children ?? []
}

export function ancestors(doc: KDoc, id: string): string[] {
  const out: string[] = []
  let n = doc.nodes[id]
  while (n && n.parentId) {
    out.push(n.parentId)
    n = doc.nodes[n.parentId]
  }
  return out
}

/** path from top-level → id (inclusive) */
export function pathTo(doc: KDoc, id: string): string[] {
  return [...ancestors(doc, id).reverse(), id]
}

export function isAncestor(doc: KDoc, maybeAncestor: string, id: string) {
  return ancestors(doc, id).includes(maybeAncestor)
}

export function topLevelOf(doc: KDoc, id: string) {
  const p = pathTo(doc, id)
  return p[0]
}

export function descendants(doc: KDoc, id: string): string[] {
  const out: string[] = []
  const walk = (i: string) => {
    for (const c of doc.nodes[i]?.children ?? []) {
      out.push(c)
      walk(c)
    }
  }
  walk(id)
  return out
}

/** Drop ids whose ancestor is also in the list. */
export function normalizeSelection(doc: KDoc, ids: string[]) {
  const set = new Set(ids)
  return ids.filter((id) => doc.nodes[id] && !ancestors(doc, id).some((a) => set.has(a)))
}

function draftChildren(d: Draft<KDoc>, parentId: string | null, pageId: string): string[] {
  if (parentId) return d.nodes[parentId].children
  return d.pages.find((p) => p.id === pageId)!.children
}

function detach(d: Draft<KDoc>, id: string) {
  const n = d.nodes[id]
  const list = draftChildren(d, n.parentId, n.pageId)
  const i = list.indexOf(id)
  if (i >= 0) list.splice(i, 1)
}

function removeDeep(d: Draft<KDoc>, id: string) {
  const n = d.nodes[id]
  if (!n) return
  for (const c of [...n.children]) removeDeep(d, c)
  delete d.nodes[id]
}

/** World position of a parent's content origin (inner edge of an inside stroke). */
export function parentOrigin(doc: KDoc, parentId: string | null): { x: number; y: number } {
  if (!parentId) return { x: 0, y: 0 }
  const r = measure(parentId)
  const p = doc.nodes[parentId]
  const bw = p?.stroke?.visible && p.stroke.position === 'inside' ? p.stroke.width : 0
  return r ? { x: r.x + bw, y: r.y + bw } : { x: 0, y: 0 }
}

/** Sort ids into document (paint) order within their parent lists. */
export function sortByOrder(doc: KDoc, ids: string[], pageId: string) {
  const idx = (id: string) => {
    const n = doc.nodes[id]
    return n ? childrenOf(doc, n.parentId, pageId).indexOf(id) : 0
  }
  return [...ids].sort((a, b) => idx(a) - idx(b))
}

/* ------------------------------------------------------------------ store */

export interface DragState {
  ids: string[]
  dx: number
  dy: number
  /** frame under pointer that will receive the nodes on drop (null = canvas) */
  targetParent: string | null
  /** for flex targets: insertion index */
  insertIndex: number | null
  /** world-space insertion indicator line */
  indicator: { x: number; y: number; w: number; h: number } | null
  duplicate: boolean
}

/** A path being drawn with the pen tool (world coordinates). */
export interface PenDraft {
  points: PathPoint[]
  /** frame the finished path goes into (where the first point was placed) */
  parentId: string | null
  /** pointer position for the rubber-band segment; null while a handle is dragged */
  cursor: { x: number; y: number } | null
  /** the pointer is over the first point: a click closes the path */
  closing: boolean
}

export interface Guide {
  axis: 'x' | 'y'
  pos: number // world coordinate
  from: number
  to: number
}

/** Canvas and zoom preferences (persisted per machine). */
export interface ViewPrefs {
  /** keyboard / menu zoom keeps the selection centred */
  zoomCentersSelection: boolean
  /** 0 / 1 / 2 zoom without Shift */
  numberKeyZoom: boolean
  invertZoom: boolean
  /** plain scroll wheel zooms instead of panning */
  wheelZoom: boolean
  /** right-drag pans; a right click without dragging still opens the menu */
  rightClickPan: boolean
  pixelGrid: boolean
  snapToPixel: boolean
  /** padding and gap overlays on flex frames */
  layoutGuides: boolean
  /** the agent's presence outline on canvas */
  presence: boolean
  /** click selects the deepest layer (⌘ inverts) */
  deepSelect: boolean
  showComments: boolean
  /** the pages / layers panel (hidden, it folds into a floating card) */
  leftPanel: boolean
}

const VIEW_KEY = 'kiln.view'
const DEFAULT_VIEW: ViewPrefs = {
  zoomCentersSelection: false,
  numberKeyZoom: false,
  invertZoom: false,
  wheelZoom: false,
  rightClickPan: false,
  pixelGrid: true,
  snapToPixel: true,
  layoutGuides: true,
  presence: true,
  deepSelect: false,
  showComments: true,
  leftPanel: true,
}
/** last measured width of the pages / layers panel (for keeping the canvas still when it folds) */
let leftPanelWidth = 0
function loadView(): ViewPrefs {
  try {
    return { ...DEFAULT_VIEW, ...JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}') }
  } catch {
    return { ...DEFAULT_VIEW }
  }
}

export type RightTab = 'design' | 'code' | 'agent'
export type LeftTab = 'layers' | 'assets' | 'tokens'

interface History {
  past: KDoc[]
  future: KDoc[]
  lastKey: string | null
  lastTime: number
}

export interface EditorState {
  doc: KDoc
  pageId: string
  selection: string[]
  hoverId: string | null
  tool: Tool
  camera: Camera
  editingTextId: string | null
  drag: DragState | null
  marquee: { x: number; y: number; w: number; h: number } | null
  guides: Guide[]
  history: History
  /** bumped whenever overlays should re-measure (fonts, images, text edits) */
  measureTick: number
  rightTab: RightTab
  leftTab: LeftTab
  paletteOpen: boolean
  shortcutsOpen: boolean
  /** exported HTML shown in the in-app Preview overlay, or null when closed */
  preview: { title: string; html: string } | null
  contextMenu: { x: number; y: number } | null
  activeCommentId: string | null
  agentBusy: string | null // label of what the agent is doing
  agentFocus: string[] // nodes the agent is touching (presence outline)
  /** the agent's current action: drives the canvas cursor and the top-bar status (null between actions) */
  agentAction: AgentAction | null
  /** node id -> time (ms) the agent last changed it, for the fading afterglow on canvas */
  agentTrail: Record<string, number>
  /** the agent's whole turn, from send to the last reply (null when idle) */
  agentTurn: AgentTurn | null
  spaceDown: boolean
  /** Alt / Option held: the overlay measures from the selection to the hovered layer */
  altDown: boolean
  saveState: 'saved' | 'saving' | 'unsaved'
  toast: { id: string; text: string } | null
  penDraft: PenDraft | null
  /** finish the pen path (needs 2+ points); returns the new layer id */
  commitPen(closed: boolean): string | null
  view: ViewPrefs
  setView(p: Partial<ViewPrefs>): void

  // ---- lifecycle
  loadDoc(doc: KDoc): void
  // ---- history-aware mutation
  update(recipe: (d: Draft<KDoc>) => void, key?: string): void
  /** mutate without recording (used during drags; call checkpoint() first) */
  updateSilently(recipe: (d: Draft<KDoc>) => void): void
  checkpoint(): void
  /** merge the last two history steps into one (e.g. alt-drag = duplicate + move) */
  squashHistory(): void
  /** remove a node without touching selection; cancels its creation step if that was the last one */
  discardNode(id: string): void
  undo(): void
  redo(): void
  // ---- ui
  set(partial: Partial<EditorState>): void
  setTool(t: Tool): void
  select(ids: string[], additive?: boolean): void
  setCamera(c: Partial<Camera>): void
  bumpMeasure(): void
  notify(text: string): void
  // ---- node ops
  addNode(node: KNode, parentId: string | null, index?: number): void
  insertNodes(nodes: KNode[], rootIds: string[], parentId: string | null, index?: number): void
  deleteSelection(): void
  duplicateSelection(offset?: boolean): string[]
  setProps(ids: string[], recipe: (n: Draft<KNode>) => void, key?: string): void
  reparent(ids: string[], parentId: string | null, index: number | null, worldPos?: Record<string, { x: number; y: number }>): void
  reorder(dir: 'up' | 'down' | 'top' | 'bottom'): void
  wrapInFrame(flex: boolean): void
  unwrap(): void
  toggleFlex(): void
  // ---- pages
  setPage(id: string): void
  addPage(): void
  renamePage(id: string, name: string): void
  deletePage(id: string): void
  // ---- comments
  addComment(c: Omit<Comment, 'id' | 'createdAt' | 'resolved' | 'replies'>): string
}

const HISTORY_LIMIT = 200

export const useEditor = create<EditorState>((set, get) => {
  const record = (key?: string) => {
    const { history, doc } = get()
    const now = performance.now()
    if (key && key === history.lastKey && now - history.lastTime < 900) {
      set({ history: { ...history, lastTime: now } })
      return
    }
    const past = [...history.past, doc]
    if (past.length > HISTORY_LIMIT) past.shift()
    set({ history: { past, future: [], lastKey: key ?? null, lastTime: now } })
  }

  const commit = (next: KDoc) => {
    set({ doc: { ...next, updatedAt: Date.now() }, saveState: 'unsaved' })
  }

  return {
    doc: emptyDoc(),
    pageId: '',
    selection: [],
    hoverId: null,
    tool: 'move',
    camera: { x: 0, y: 0, zoom: 1 },
    editingTextId: null,
    drag: null,
    marquee: null,
    guides: [],
    history: { past: [], future: [], lastKey: null, lastTime: 0 },
    measureTick: 0,
    rightTab: 'design',
    leftTab: 'layers',
    paletteOpen: false,
    shortcutsOpen: false,
    preview: null,
    contextMenu: null,
    activeCommentId: null,
    agentBusy: null,
    agentFocus: [],
    agentAction: null,
    agentTrail: {},
    agentTurn: null,
    spaceDown: false,
    altDown: false,
    saveState: 'saved',
    toast: null,
    penDraft: null,
    commitPen(closed) {
      const { penDraft: dr, doc, pageId } = get()
      if (!dr) return null
      set({ penDraft: null })
      if (dr.points.length < 2) return null
      const parent = dr.parentId ? doc.nodes[dr.parentId] : null
      const { box, path } = buildPath(dr.points, closed, get().view.snapToPixel)
      const o = parentOrigin(doc, parent ? parent.id : null)
      const node = createNode('path', pageId, { x: box.x - o.x, y: box.y - o.y, width: box.w, height: box.h, path })
      if (closed) node.name = 'Shape'
      // in an auto-layout frame, keep the path where it was drawn
      if (parent?.layout.mode === 'flex') node.positioning = 'absolute'
      get().addNode(node, parent ? parent.id : null)
      set({ selection: [node.id] })
      return node.id
    },
    view: loadView(),
    setView(p) {
      const view = { ...get().view, ...p }
      if (p.leftPanel !== undefined && p.leftPanel !== get().view.leftPanel) {
        // the stage grows / shrinks on its left edge: move the camera with it so the canvas stays put
        const el = document.querySelector('.k-left')
        if (el) leftPanelWidth = el.getBoundingClientRect().width
        else if (!leftPanelWidth) leftPanelWidth = 248
        const cam = get().camera
        set({ view, camera: { ...cam, x: cam.x + (p.leftPanel ? -leftPanelWidth : leftPanelWidth) } })
      } else set({ view })
      try {
        localStorage.setItem(VIEW_KEY, JSON.stringify(view))
      } catch {
        /* private mode: keep it for this session */
      }
    },

    loadDoc(doc) {
      set({
        doc,
        penDraft: null,
        pageId: doc.pages[0].id,
        selection: [],
        hoverId: null,
        editingTextId: null,
        history: { past: [], future: [], lastKey: null, lastTime: 0 },
        saveState: 'saved',
      })
    },

    update(recipe, key) {
      const prev = get().doc
      const next = produce(prev, recipe)
      if (next === prev) return
      record(key)
      commit(next)
    },
    updateSilently(recipe) {
      const prev = get().doc
      const next = produce(prev, recipe)
      if (next !== prev) commit(next)
    },
    checkpoint() {
      record()
    },
    squashHistory() {
      const { history } = get()
      if (history.past.length < 2) return
      set({ history: { ...history, past: history.past.slice(0, -1), lastKey: null } })
    },
    discardNode(id) {
      const { doc, history } = get()
      if (!doc.nodes[id]) return
      const next = produce(doc, (d) => {
        detach(d, id)
        removeDeep(d, id)
      })
      const prev = history.past[history.past.length - 1]
      const createdLast = prev && !prev.nodes[id]
      set({
        doc: { ...next, updatedAt: Date.now() },
        selection: get().selection.filter((x) => x !== id),
        hoverId: get().hoverId === id ? null : get().hoverId,
        saveState: 'unsaved',
        history: createdLast ? { ...history, past: history.past.slice(0, -1), lastKey: null } : history,
      })
    },
    undo() {
      const { history, doc, selection } = get()
      const prev = history.past[history.past.length - 1]
      if (!prev) return
      set({
        doc: prev,
        history: { past: history.past.slice(0, -1), future: [doc, ...history.future], lastKey: null, lastTime: 0 },
        selection: selection.filter((id) => prev.nodes[id]),
        editingTextId: null,
        saveState: 'unsaved',
        pageId: prev.pages.some((p) => p.id === get().pageId) ? get().pageId : prev.pages[0].id,
      })
    },
    redo() {
      const { history, doc, selection } = get()
      const next = history.future[0]
      if (!next) return
      set({
        doc: next,
        history: { past: [...history.past, doc], future: history.future.slice(1), lastKey: null, lastTime: 0 },
        selection: selection.filter((id) => next.nodes[id]),
        editingTextId: null,
        saveState: 'unsaved',
        pageId: next.pages.some((p) => p.id === get().pageId) ? get().pageId : next.pages[0].id,
      })
    },

    set(partial) {
      set(partial)
    },
    setTool(tool) {
      // leaving the pen tool finishes the path being drawn
      if (tool !== 'pen' && get().penDraft) get().commitPen(false)
      set({ tool, editingTextId: tool === 'move' ? get().editingTextId : null })
    },
    select(ids, additive) {
      const { selection, doc } = get()
      let next = ids
      if (additive) {
        const s = new Set(selection)
        for (const id of ids) {
          if (s.has(id)) s.delete(id)
          else s.add(id)
        }
        next = [...s]
      }
      next = normalizeSelection(doc, next)
      set({ selection: next, editingTextId: null, contextMenu: null })
    },
    setCamera(c) {
      const cam = { ...get().camera, ...c }
      cam.zoom = Math.min(64, Math.max(0.02, cam.zoom))
      set({ camera: cam })
    },
    bumpMeasure() {
      set({ measureTick: get().measureTick + 1 })
    },
    notify(text) {
      const id = uid(4)
      set({ toast: { id, text } })
      setTimeout(() => {
        if (get().toast?.id === id) set({ toast: null })
      }, 2400)
    },

    addNode(node, parentId, index) {
      get().insertNodes([node], [node.id], parentId, index)
    },
    insertNodes(nodes, rootIds, parentId, index) {
      const { pageId } = get()
      get().update((d) => {
        for (const n of nodes) {
          d.nodes[n.id] = { ...n, pageId }
        }
        const list = draftChildren(d, parentId, pageId)
        for (const id of rootIds) d.nodes[id].parentId = parentId
        if (index == null || index < 0 || index > list.length) list.push(...rootIds)
        else list.splice(index, 0, ...rootIds)
      })
    },
    deleteSelection() {
      const { selection, doc } = get()
      const ids = normalizeSelection(doc, selection).filter((id) => !doc.nodes[id]?.locked)
      if (!ids.length) return
      get().update((d) => {
        for (const id of ids) {
          if (!d.nodes[id]) continue
          detach(d, id)
          removeDeep(d, id)
        }
      })
      set({ selection: [], hoverId: null })
    },
    duplicateSelection(offset = true) {
      const { selection, doc, pageId } = get()
      const ids = normalizeSelection(doc, selection)
      if (!ids.length) return []
      const created: string[] = []
      get().update((d) => {
        for (const id of ids) {
          const src = doc.nodes[id]
          const [root, all] = cloneSubtree(doc.nodes, id, src.parentId, pageId)
          if (offset) {
            const parent = src.parentId ? doc.nodes[src.parentId] : null
            const inFlow = parent && parent.layout.mode === 'flex' && src.positioning !== 'absolute'
            if (!inFlow) {
              if (!src.parentId) root.x = src.x + src.width + 40
              else {
                root.x = src.x + 12
                root.y = src.y + 12
              }
            }
          }
          for (const n of all) d.nodes[n.id] = n
          const list = draftChildren(d, src.parentId, pageId)
          list.splice(list.indexOf(id) + 1, 0, root.id)
          created.push(root.id)
        }
      })
      set({ selection: created })
      return created
    },
    setProps(ids, recipe, key) {
      get().update((d) => {
        for (const id of ids) if (d.nodes[id]) recipe(d.nodes[id])
      }, key)
    },
    reparent(ids, parentId, index, worldPos) {
      const { doc, pageId } = get()
      const valid = sortByOrder(
        doc,
        normalizeSelection(doc, ids).filter((id) => id !== parentId && !(parentId && isAncestor(doc, id, parentId))),
        pageId,
      )
      if (!valid.length) return
      const origin = parentOrigin(doc, parentId)
      const parent = parentId ? doc.nodes[parentId] : null
      const intoFlow = !!parent && parent.layout.mode === 'flex'
      const sizes = Object.fromEntries(valid.map((id) => [id, measureSize(id)]))
      get().update((d) => {
        let insertAt = index
        for (const id of valid) {
          const n = d.nodes[id]
          const oldList = draftChildren(d, n.parentId, n.pageId)
          const oldIdx = oldList.indexOf(id)
          // same list reorder: adjust index for removal
          if (insertAt != null && n.parentId === parentId && oldIdx >= 0 && oldIdx < insertAt) insertAt--
          detach(d, id)
          const wp = worldPos?.[id] ?? measure(id)
          n.parentId = parentId
          if (!intoFlow || n.positioning === 'absolute') {
            if (wp) {
              n.x = px(wp.x - origin.x)
              n.y = px(wp.y - origin.y)
            }
            if (!intoFlow) n.positioning = 'auto'
          }
          // fill only means something inside a parent; freeze the rendered size otherwise
          if (!intoFlow || !parentId) {
            const sz = sizes[id]
            if (n.widthMode === 'fill') {
              n.widthMode = 'fixed'
              if (sz) n.width = Math.round(sz.w)
            }
            if (n.heightMode === 'fill') {
              n.heightMode = 'fixed'
              if (sz) n.height = Math.round(sz.h)
            }
          }
          const list = draftChildren(d, parentId, pageId)
          if (insertAt == null || insertAt > list.length) list.push(id)
          else {
            list.splice(insertAt, 0, id)
            insertAt++
          }
        }
      })
      set({ selection: valid })
    },
    reorder(dir) {
      const { selection, doc, pageId } = get()
      const ids = normalizeSelection(doc, selection)
      if (!ids.length) return
      const ordered = sortByOrder(doc, ids, pageId)
      if (dir === 'up' || dir === 'bottom') ordered.reverse()
      get().update((d) => {
        for (const id of ordered) {
          const n = d.nodes[id]
          const list = draftChildren(d, n.parentId, pageId)
          const i = list.indexOf(id)
          // stop at the ends, and don't jump over another selected sibling
          if (dir === 'up' && (i === list.length - 1 || ordered.includes(list[i + 1]))) continue
          if (dir === 'down' && (i === 0 || ordered.includes(list[i - 1]))) continue
          list.splice(i, 1)
          const j = dir === 'up' ? i + 1 : dir === 'down' ? i - 1 : dir === 'top' ? list.length : 0
          list.splice(j, 0, id)
        }
      })
    },
    wrapInFrame(flex) {
      const { selection, doc, pageId } = get()
      const ids = normalizeSelection(doc, selection)
      if (!ids.length) return
      const first = doc.nodes[ids[0]]
      const parentId = first.parentId
      const sameParent = sortByOrder(doc, ids.filter((id) => doc.nodes[id].parentId === parentId), pageId)
      const rects = sameParent.map((id) => measure(id)).filter(Boolean) as { x: number; y: number; w: number; h: number }[]
      if (!rects.length) return
      const minX = Math.min(...rects.map((r) => r.x))
      const minY = Math.min(...rects.map((r) => r.y))
      const maxX = Math.max(...rects.map((r) => r.x + r.w))
      const maxY = Math.max(...rects.map((r) => r.y + r.h))
      const parent = parentId ? doc.nodes[parentId] : null
      const parentInFlow = !!parent && parent.layout.mode === 'flex'
      const { x: originX, y: originY } = parentOrigin(doc, parentId)
      // guess direction from arrangement
      const spreadX = maxX - minX - Math.max(...rects.map((r) => r.w))
      const spreadY = maxY - minY - Math.max(...rects.map((r) => r.h))
      const direction = spreadX > spreadY ? 'row' : 'column'
      const sorted = [...sameParent].sort((a, b) => {
        const ra = measure(a)!
        const rb = measure(b)!
        return direction === 'row' ? ra.x - rb.x : ra.y - rb.y
      })
      let gap = 0
      if (flex && sorted.length > 1) {
        const gaps: number[] = []
        for (let i = 1; i < sorted.length; i++) {
          const a = measure(sorted[i - 1])!
          const b = measure(sorted[i])!
          gaps.push(direction === 'row' ? b.x - (a.x + a.w) : b.y - (a.y + a.h))
        }
        gap = Math.max(0, Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length))
      }
      const frame = createNode('frame', pageId, {
        name: flex ? 'Stack' : 'Frame',
        x: Math.round(minX - originX),
        y: Math.round(minY - originY),
        width: Math.round(maxX - minX),
        height: Math.round(maxY - minY),
        fills: [],
        clip: false,
        widthMode: flex ? 'hug' : 'fixed',
        heightMode: flex ? 'hug' : 'fixed',
      })
      if (flex) frame.layout = { ...frame.layout, mode: 'flex', direction, gap }
      const firstIndex = Math.min(...sameParent.map((id) => childrenOf(doc, parentId, pageId).indexOf(id)))
      get().update((d) => {
        d.nodes[frame.id] = frame
        const list = draftChildren(d, parentId, pageId)
        for (const id of sameParent) detach(d, id)
        list.splice(Math.min(firstIndex, list.length), 0, frame.id)
        d.nodes[frame.id].parentId = parentId
        for (const id of (flex ? sorted : sameParent)) {
          const n = d.nodes[id]
          const r = measure(id)!
          n.parentId = frame.id
          if (!flex) {
            n.x = Math.round(r.x - minX)
            n.y = Math.round(r.y - minY)
          }
          n.positioning = 'auto'
          d.nodes[frame.id].children.push(id)
        }
        if (parentInFlow) d.nodes[frame.id].positioning = 'auto'
      })
      set({ selection: [frame.id] })
    },
    unwrap() {
      const { selection, doc, pageId } = get()
      const frames = selection.filter((id) => doc.nodes[id]?.type === 'frame' && doc.nodes[id].children.length)
      if (!frames.length) return
      const positions: Record<string, { x: number; y: number }> = {}
      const originOf: Record<string, { x: number; y: number }> = {}
      const sizes: Record<string, { w: number; h: number } | null> = {}
      for (const f of frames) {
        for (const c of doc.nodes[f].children) {
          const r = measure(c)
          if (r) positions[c] = { x: r.x, y: r.y }
          sizes[c] = measureSize(c)
        }
        originOf[f] = parentOrigin(doc, doc.nodes[f].parentId)
      }
      const freed: string[] = []
      get().update((d) => {
        for (const f of frames) {
          const fr = d.nodes[f]
          const list = draftChildren(d, fr.parentId, pageId)
          const at = list.indexOf(f)
          const kids = [...fr.children]
          list.splice(at, 1, ...kids)
          for (const c of kids) {
            const n = d.nodes[c]
            n.parentId = fr.parentId
            const pos = positions[c]
            if (pos) {
              n.x = Math.round(pos.x - originOf[f].x)
              n.y = Math.round(pos.y - originOf[f].y)
            }
            const parentIsFlex = !!fr.parentId && d.nodes[fr.parentId]?.layout.mode === 'flex'
            if (!parentIsFlex) {
              if (n.widthMode === 'fill') {
                n.widthMode = 'fixed'
                if (sizes[c]) n.width = Math.round(sizes[c]!.w)
              }
              if (n.heightMode === 'fill') {
                n.heightMode = 'fixed'
                if (sizes[c]) n.height = Math.round(sizes[c]!.h)
              }
            }
            freed.push(c)
          }
          delete d.nodes[f]
        }
      })
      set({ selection: freed })
    },
    toggleFlex() {
      const { selection, doc } = get()
      const ids = selection.filter((id) => doc.nodes[id]?.type === 'frame')
      if (!ids.length) {
        get().wrapInFrame(true)
        return
      }
      for (const id of ids) {
        const n = doc.nodes[id]
        if (n.layout.mode === 'flex') {
          // freeze current child positions before switching to absolute
          const sizes: Record<string, { x: number; y: number; w: number; h: number }> = {}
          for (const c of n.children) {
            const r = measureLocal(c)
            if (r) sizes[c] = r
          }
          const self = measure(id)
          get().update((d) => {
            const f = d.nodes[id]
            f.layout.mode = 'none'
            if (self) {
              if (f.widthMode !== 'fixed') {
                f.width = Math.round(self.w)
                f.widthMode = 'fixed'
              }
              if (f.heightMode !== 'fixed') {
                f.height = Math.round(self.h)
                f.heightMode = 'fixed'
              }
            }
            for (const c of f.children) {
              const r = sizes[c]
              const cn = d.nodes[c]
              if (r) {
                cn.x = Math.round(r.x)
                cn.y = Math.round(r.y)
                if (cn.widthMode === 'fill') {
                  cn.widthMode = 'fixed'
                  cn.width = Math.round(r.w)
                }
                if (cn.heightMode === 'fill') {
                  cn.heightMode = 'fixed'
                  cn.height = Math.round(r.h)
                }
              }
            }
          })
        } else {
          // guess direction from children arrangement
          const rects = n.children.map((c) => measureLocal(c)).filter(Boolean) as { x: number; y: number; w: number; h: number }[]
          const xs = rects.map((r) => r.x)
          const ys = rects.map((r) => r.y)
          const spanX = xs.length ? Math.max(...xs) - Math.min(...xs) : 0
          const spanY = ys.length ? Math.max(...ys) - Math.min(...ys) : 1
          const direction = spanX > spanY ? 'row' : 'column'
          const order = [...n.children].sort((a, b) => {
            const ra = measureLocal(a)
            const rb = measureLocal(b)
            if (!ra || !rb) return 0
            return direction === 'row' ? ra.x - rb.x : ra.y - rb.y
          })
          get().update((d) => {
            const f = d.nodes[id]
            f.layout.mode = 'flex'
            f.layout.direction = direction
            if (!f.layout.gap) f.layout.gap = 12
            if (f.layout.padding.every((p) => p === 0)) f.layout.padding = [16, 16, 16, 16]
            f.children = order
          })
        }
      }
    },

    setPage(id) {
      if (get().penDraft) get().commitPen(false)
      set({ pageId: id, selection: [], hoverId: null, editingTextId: null })
    },
    addPage() {
      const page = createPage(`Page ${get().doc.pages.length + 1}`)
      get().update((d) => {
        d.pages.push(page)
      })
      set({ pageId: page.id, selection: [] })
    },
    renamePage(id, name) {
      get().update((d) => {
        const p = d.pages.find((p) => p.id === id)
        if (p) p.name = name
      })
    },
    deletePage(id) {
      const { doc } = get()
      if (doc.pages.length < 2) return
      get().update((d) => {
        const p = d.pages.find((p) => p.id === id) as Page
        for (const c of p.children) removeDeep(d, c)
        d.pages = d.pages.filter((x) => x.id !== id)
        d.comments = d.comments.filter((c) => c.pageId !== id)
      })
      set({ pageId: get().doc.pages[0].id, selection: [] })
    },

    addComment(c) {
      const id = uid(8)
      get().update((d) => {
        d.comments.push({ ...c, id, createdAt: Date.now(), resolved: false, replies: [] })
      })
      return id
    },
  }
})

export const getEditor = () => useEditor.getState()

/** Round a position or size: whole pixels with "Snap to pixel", else 0.01px. */
export function px(v: number) {
  return getEditor().view.snapToPixel ? Math.round(v) : Math.round(v * 100) / 100
}

// Leaving text edit mode on an empty text layer removes it (and its creation step).
useEditor.subscribe((state, prev) => {
  const id = prev.editingTextId
  if (!id || state.editingTextId === id) return
  const n = state.doc.nodes[id]
  if (n && n.type === 'text' && !(n.text?.content ?? '').trim()) queueMicrotask(() => getEditor().discardNode(id))
})

/** What the agent is doing right now (see src/agent/humanize.ts for the wording). */
export interface AgentAction {
  /** tool name, e.g. "update_nodes" */
  tool: string
  /** human wording, e.g. "Styling 3 layers" */
  label: string
  /** nodes it touches (may be empty) */
  ids: string[]
  /** when it started (ms) */
  at: number
}

/** One agent turn: set on send, cleared when the reply ends. */
export interface AgentTurn {
  /** provider label, e.g. "Claude Code" */
  provider: string
  startedAt: number
  /** tool calls so far in this turn */
  steps: number
}
