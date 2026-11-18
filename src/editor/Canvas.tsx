import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PointerEvent as RPointerEvent } from 'react'
import { useEditor, getEditor, pathTo, descendants, childrenOf, parentOrigin, px, type Guide } from './store'
import { registerWorld, setGeometryCamera, measure, measureLocal, rectsIntersect, unionRects, screenToWorld } from './geometry'
import { createNode } from './factory'
import { NodeView } from './NodeView'
import { Overlay } from './Overlay'
import type { KDoc, KNode, NodeType, Rect } from './types'
import { defaultShaderSpec } from '../shaders/defs'
import { insertImageFiles } from './images'
import { constrain45 } from './vector'
import { isMac } from '../platform/os'
import { isMod } from '../platform/keys'

/* ------------------------------------------------------------- viewport */

let viewportEl: HTMLElement | null = null
export function getViewportRect() {
  return viewportEl?.getBoundingClientRect() ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight)
}

export function zoomToRect(r: Rect, padding = 80, maxZoom = 1) {
  const vp = getViewportRect()
  const zoom = Math.min(maxZoom, (vp.width - padding * 2) / Math.max(r.w, 1), (vp.height - padding * 2) / Math.max(r.h, 1))
  const z = Math.max(0.05, zoom)
  getEditor().setCamera({ zoom: z, x: vp.width / 2 - (r.x + r.w / 2) * z, y: vp.height / 2 - (r.y + r.h / 2) * z })
}

export function zoomToFit(ids?: string[]) {
  const s = getEditor()
  const page = s.doc.pages.find((p) => p.id === s.pageId)
  const list = ids?.length ? ids : page?.children ?? []
  const rects = list.map((id) => measure(id)).filter(Boolean) as Rect[]
  const u = unionRects(rects)
  if (u) zoomToRect(u, 80, ids?.length ? 4 : 1)
  else s.setCamera({ x: 120, y: 120, zoom: 1 })
}

export function zoomBy(factor: number, center?: { x: number; y: number }) {
  const s = getEditor()
  const vp = getViewportRect()
  const cam = s.camera
  const z = Math.min(64, Math.max(0.02, cam.zoom * factor))
  // keyboard / menu zoom with "Zoom centers selection": zoom and bring the selection to the middle
  if (!center && s.view.zoomCentersSelection && s.selection.length) {
    const u = unionRects(s.selection.map((id) => measure(id)).filter(Boolean) as Rect[])
    if (u) {
      s.setCamera({ zoom: z, x: vp.width / 2 - (u.x + u.w / 2) * z, y: vp.height / 2 - (u.y + u.h / 2) * z })
      return
    }
  }
  const c = center ?? { x: vp.width / 2, y: vp.height / 2 }
  const wx = (c.x - cam.x) / cam.zoom
  const wy = (c.y - cam.y) / cam.zoom
  s.setCamera({ zoom: z, x: c.x - wx * z, y: c.y - wy * z })
}

/** World point at the centre of the viewport. */
export function viewportCenterWorld() {
  const vp = getViewportRect()
  return screenToWorld(vp.width / 2, vp.height / 2, getEditor().camera)
}

/* ------------------------------------------------------------- hit testing */

function hitIdAt(clientX: number, clientY: number, exclude?: Set<string>): string | null {
  const els = document.elementsFromPoint(clientX, clientY)
  for (const el of els) {
    const id = (el as HTMLElement).closest?.('[data-id]')?.getAttribute('data-id')
    if (id && !exclude?.has(id)) {
      // make sure it's inside the world
      if ((el as HTMLElement).closest('.k-world')) return id
    }
  }
  return null
}

/** Deepest frame under the point (excluding a subtree). */
function frameAt(doc: KDoc, clientX: number, clientY: number, exclude: Set<string>): string | null {
  const els = document.elementsFromPoint(clientX, clientY)
  for (const el of els) {
    const host = (el as HTMLElement).closest?.('[data-id]') as HTMLElement | null
    if (!host || !host.closest('.k-world')) continue
    let id: string | null = host.getAttribute('data-id')
    // walk up to a frame that's not excluded
    while (id) {
      const n: KNode | undefined = doc.nodes[id]
      if (!n) break
      if (n.type === 'frame' && !exclude.has(id) && !n.locked) return id
      id = n.parentId
    }
  }
  return null
}

/** Figma-style selection resolution: click selects siblings of the current selection, else the artboard's direct child. */
export function resolveTarget(doc: KDoc, hitId: string, selection: string[], deep: boolean): string | null {
  let path = pathTo(doc, hitId)
  const li = path.findIndex((id) => doc.nodes[id]?.locked)
  if (li === 0) return null
  if (li > 0) path = path.slice(0, li)
  if (deep) return path[path.length - 1]
  const sel = new Set(selection)
  const selParents = new Set(selection.map((id) => doc.nodes[id]?.parentId ?? '__top__'))
  for (let k = path.length - 1; k >= 0; k--) {
    const id = path[k]
    const parent = doc.nodes[id].parentId
    if (sel.has(id) || selParents.has(parent ?? '__top__')) {
      if (k === 0 && path.length > 1 && !sel.has(id) && isArtboard(doc, id)) break
      return id
    }
  }
  const top = doc.nodes[path[0]]
  if (path.length > 1 && isArtboard(doc, top.id)) return path[1]
  return path[0]
}

export function isArtboard(doc: KDoc, id: string) {
  const n = doc.nodes[id]
  return !!n && n.type === 'frame' && n.parentId === null && n.children.length > 0
}

/* ------------------------------------------------------------- snapping */

const SNAP_PX = 6
/** screen px within which a pen click lands on an existing anchor */
const PEN_HIT = 7
/** the pixel grid appears from this zoom up (600%) */
const PIXEL_GRID_ZOOM = 6

function snapCandidates(doc: KDoc, pageId: string, ids: string[]): Rect[] {
  const s = new Set<string>()
  for (const id of ids) {
    s.add(id)
    for (const d of descendants(doc, id)) s.add(d)
  }
  const parents = new Set(ids.map((id) => doc.nodes[id]?.parentId ?? null))
  const out: Rect[] = []
  for (const p of parents) {
    for (const sib of childrenOf(doc, p, pageId)) {
      if (s.has(sib)) continue
      const r = measure(sib)
      if (r) out.push(r)
    }
    if (p) {
      const r = measure(p)
      if (r) out.push(r)
    }
  }
  return out.slice(0, 300)
}

function snapAxis(edges: number[], targets: number[], threshold: number): { delta: number; at: number } | null {
  let best: { delta: number; at: number } | null = null
  for (const e of edges)
    for (const t of targets) {
      const d = t - e
      if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.delta))) best = { delta: d, at: t }
    }
  return best
}

function computeSnap(moving: Rect, cands: Rect[], zoom: number, axes: { x: boolean; y: boolean } = { x: true, y: true }) {
  const th = SNAP_PX / zoom
  const xs = cands.flatMap((c) => [c.x, c.x + c.w / 2, c.x + c.w])
  const ys = cands.flatMap((c) => [c.y, c.y + c.h / 2, c.y + c.h])
  const sx = axes.x ? snapAxis([moving.x, moving.x + moving.w / 2, moving.x + moving.w], xs, th) : null
  const sy = axes.y ? snapAxis([moving.y, moving.y + moving.h / 2, moving.y + moving.h], ys, th) : null
  const dx = sx?.delta ?? 0
  const dy = sy?.delta ?? 0
  const m = { ...moving, x: moving.x + dx, y: moving.y + dy }
  const guides: Guide[] = []
  if (sx) {
    const rel = cands.filter((c) => [c.x, c.x + c.w / 2, c.x + c.w].some((v) => Math.abs(v - sx.at) < 0.5))
    const ys2 = [m.y, m.y + m.h, ...rel.flatMap((c) => [c.y, c.y + c.h])]
    guides.push({ axis: 'x', pos: sx.at, from: Math.min(...ys2), to: Math.max(...ys2) })
  }
  if (sy) {
    const rel = cands.filter((c) => [c.y, c.y + c.h / 2, c.y + c.h].some((v) => Math.abs(v - sy.at) < 0.5))
    const xs2 = [m.x, m.x + m.w, ...rel.flatMap((c) => [c.x, c.x + c.w])]
    guides.push({ axis: 'y', pos: sy.at, from: Math.min(...xs2), to: Math.max(...xs2) })
  }
  return { dx, dy, guides }
}

/* ------------------------------------------------------------- flex insertion */

function flexInsertion(doc: KDoc, parentId: string, world: { x: number; y: number }, exclude: Set<string>) {
  const p = doc.nodes[parentId]
  const row = p.layout.direction === 'row'
  const kids = p.children.filter((c) => !exclude.has(c) && doc.nodes[c]?.visible && doc.nodes[c]?.positioning !== 'absolute')
  const rects = kids.map((k) => measure(k))
  let index = kids.length
  for (let i = 0; i < kids.length; i++) {
    const r = rects[i]
    if (!r) continue
    const mid = row ? r.x + r.w / 2 : r.y + r.h / 2
    if ((row ? world.x : world.y) < mid) {
      index = i
      break
    }
  }
  // indicator
  const pr = measure(parentId)!
  let indicator: Rect | null = null
  const before = rects[index - 1]
  const after = rects[index]
  if (row) {
    const x = after && before ? (before.x + before.w + after.x) / 2 : after ? after.x - 2 : before ? before.x + before.w + 2 : pr.x + p.layout.padding[3]
    const ref = after ?? before
    indicator = { x: x - 1, y: ref ? ref.y : pr.y + p.layout.padding[0], w: 2, h: ref ? ref.h : pr.h - p.layout.padding[0] - p.layout.padding[2] }
  } else {
    const y = after && before ? (before.y + before.h + after.y) / 2 : after ? after.y - 2 : before ? before.y + before.h + 2 : pr.y + p.layout.padding[0]
    const ref = after ?? before
    indicator = { x: ref ? ref.x : pr.x + p.layout.padding[3], y: y - 1, w: ref ? ref.w : pr.w - p.layout.padding[1] - p.layout.padding[3], h: 2 }
  }
  // translate visible-children index into the full children index
  const fullIndex = index < kids.length ? p.children.indexOf(kids[index]) : p.children.length
  return { index: fullIndex, indicator }
}

/* ------------------------------------------------------------- component */

type Gesture =
  | {
      kind: 'pan'
      sx: number
      sy: number
      cx: number
      cy: number
      /** right-button pan: a press without movement opens the context menu instead */
      right?: { moved: boolean; mod: boolean }
    }
  | { kind: 'marquee'; start: { x: number; y: number }; scope: string[]; base: string[]; additive: boolean }
  | {
      kind: 'move'
      startClient: { x: number; y: number }
      startWorld: { x: number; y: number }
      ids: string[]
      rects: Record<string, Rect>
      bbox: Rect
      started: boolean
      alt: boolean
      cands: Rect[]
      flowParent: string | null
      exclude: Set<string>
      /** on a click without drag: select this instead (dive into / narrow a selection) */
      clickSelect: string | null
    }
  | {
      kind: 'resize'
      id: string
      handle: string
      startWorld: { x: number; y: number }
      rect: Rect
      local: { x: number; y: number }
      cands: Rect[]
      textWidthOnly: boolean
    }
  | { kind: 'create'; type: NodeType; start: { x: number; y: number }; startClient: { x: number; y: number }; rect: Rect | null }
  | { kind: 'comment' }
  | {
      kind: 'pen'
      /** anchor being placed (or the first anchor, when closing) */
      index: number
      startClient: { x: number; y: number }
      dragged: boolean
      closing: boolean
    }

export function Canvas() {
  const camera = useEditor((s) => s.camera)
  const page = useEditor((s) => s.doc.pages.find((p) => p.id === s.pageId))
  const tool = useEditor((s) => s.tool)
  const spaceDown = useEditor((s) => s.spaceDown)
  const vpRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)
  const gesture = useRef<Gesture | null>(null)
  const [createRect, setCreateRect] = useState<Rect | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const suppressCtxUntil = useRef(0)
  const pixelGrid = useEditor((s) => s.view.pixelGrid)
  const penClosing = useEditor((s) => !!s.penDraft?.closing)
  /** ⌘ (Ctrl off the Mac) inverts "Use deep selection". Not Ctrl on the Mac: ctrl-click is a right-click there. */
  const isDeep = (e: { metaKey: boolean; ctrlKey: boolean }) => isMod(e) !== getEditor().view.deepSelect

  setGeometryCamera(camera)

  useLayoutEffect(() => {
    viewportEl = vpRef.current
    registerWorld(worldRef.current)
    return () => registerWorld(null)
  }, [])

  // re-measure when web fonts land
  useEffect(() => {
    const f = () => getEditor().bumpMeasure()
    document.fonts?.addEventListener?.('loadingdone', f)
    document.fonts?.ready.then(f)
    return () => document.fonts?.removeEventListener?.('loadingdone', f)
  }, [])

  // wheel: pan / pinch-zoom (non-passive so we can stop browser zoom)
  useEffect(() => {
    const el = vpRef.current!
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const s = getEditor()
      const v = s.view
      const rect = el.getBoundingClientRect()
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.height : 1
      const deltaX = e.deltaX * unit
      const deltaY = e.deltaY * unit
      // a trackpad pinch arrives as ctrl + wheel
      const pinch = e.ctrlKey && !e.metaKey
      // "Scroll wheel zooms": plain wheel zooms, ⌘ / ⇧ + wheel pan; sideways swipes still pan
      const wheelZooms = v.wheelZoom && !e.metaKey && !e.shiftKey && Math.abs(deltaY) >= Math.abs(deltaX)
      if (pinch || wheelZooms || (!v.wheelZoom && e.metaKey)) {
        const dir = !pinch && v.invertZoom ? -1 : 1
        const d = Math.max(-60, Math.min(60, deltaY))
        // Ctrl + mouse wheel off the Mac also arrives as "pinch", one notch at a time (|deltaY| ≈ 100):
        // step it like the wheel, or each notch would double the zoom
        // (Firefox reports a notch in lines, about 48px after scaling, so line or page mode counts as a notch too)
        const notch = pinch && !isMac && (e.deltaMode !== 0 || Math.abs(deltaY) >= 50)
        const factor = Math.exp(-d * dir * (pinch && !notch ? 0.012 : 0.0025))
        zoomBy(factor, { x: e.clientX - rect.left, y: e.clientY - rect.top })
      } else {
        const dx = e.shiftKey && !deltaX ? deltaY : deltaX
        const dy = e.shiftKey && !deltaX ? 0 : deltaY
        s.setCamera({ x: s.camera.x - dx, y: s.camera.y - dy })
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const toWorld = (e: { clientX: number; clientY: number }) => {
    const r = vpRef.current!.getBoundingClientRect()
    return screenToWorld(e.clientX - r.left, e.clientY - r.top, getEditor().camera)
  }

  /* ---------------- pointer down */
  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    const s = getEditor()
    if (s.contextMenu) s.set({ contextMenu: null })
    const target = e.target as HTMLElement
    if (target.closest('[data-overlay-ui]')) return // overlay handles its own
    // on the Mac, ctrl-click is a right-click: it opens the context menu rather than selecting or dragging
    if (e.button === 2 || (isMac && e.button === 0 && e.ctrlKey)) {
      // context menu is handled in onContextMenu, unless right-drag pans
      if (!s.view.rightClickPan) return
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      gesture.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, cx: s.camera.x, cy: s.camera.y, right: { moved: false, mod: isMod(e) } }
      return
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)

    if (s.editingTextId) {
      s.set({ editingTextId: null })
    }
    if (s.drag || s.guides.length || s.marquee) s.set({ drag: null, guides: [], marquee: null })

    // pan
    if (e.button === 1 || s.spaceDown || s.tool === 'hand') {
      gesture.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, cx: s.camera.x, cy: s.camera.y }
      setCursor('grabbing')
      return
    }

    const world = toWorld(e)

    if (s.tool === 'comment') {
      gesture.current = { kind: 'comment' }
      if (!s.view.showComments) s.setView({ showComments: true })
      const hit = hitIdAt(e.clientX, e.clientY)
      const id = s.addComment({ pageId: s.pageId, x: world.x, y: world.y, nodeId: hit ?? undefined, author: 'You', body: '' })
      s.set({ activeCommentId: id, tool: 'move' })
      return
    }

    if (s.tool === 'pen') {
      penDown(e, world)
      return
    }

    if (s.tool !== 'move') {
      gesture.current = { kind: 'create', type: s.tool as NodeType, start: world, startClient: { x: e.clientX, y: e.clientY }, rect: null }
      return
    }

    const hit = hitIdAt(e.clientX, e.clientY)
    const deep = isDeep(e)

    // pressing inside an already-selected layer keeps the selection so it can be dragged;
    // a click without dragging then dives into it (or narrows a multi-selection)
    if (hit && !deep && !e.shiftKey) {
      const path = pathTo(s.doc, hit)
      const selIdx = path.findIndex((id) => s.selection.includes(id))
      if (selIdx >= 0 && !s.doc.nodes[path[selIdx]].locked) {
        const selected = path[selIdx]
        let clickSelect: string | null = null
        if (s.selection.length > 1) clickSelect = selected
        else {
          const next = path[selIdx + 1]
          if (next && !s.doc.nodes[next].locked) clickSelect = next
        }
        startMove(e.clientX, e.clientY, world, e.altKey, clickSelect)
        return
      }
    }

    let targetId = hit ? resolveTarget(s.doc, hit, s.selection, deep) : null

    // empty part of an artboard → marquee among its children (unless the artboard is selected)
    if (targetId && isArtboard(s.doc, targetId) && hit === targetId && !s.selection.includes(targetId) && !deep) {
      targetId = null
    }

    if (!targetId) {
      const scope = hit && isArtboard(s.doc, pathTo(s.doc, hit)[0]) ? s.doc.nodes[pathTo(s.doc, hit)[0]].children : page?.children ?? []
      gesture.current = { kind: 'marquee', start: world, scope, base: e.shiftKey ? s.selection : [], additive: e.shiftKey }
      if (!e.shiftKey) s.select([])
      return
    }

    if (e.shiftKey) {
      s.select([targetId], true)
    } else if (!s.selection.includes(targetId)) {
      s.select([targetId])
    }
    startMove(e.clientX, e.clientY, world, e.altKey)
  }

  /* ---------------- pen */
  const nearPoint = (p: { x: number; y: number }, world: { x: number; y: number }) =>
    Math.hypot(p.x - world.x, p.y - world.y) * getEditor().camera.zoom <= PEN_HIT

  /** where the next anchor goes: ⇧ locks the segment to 45° steps */
  const penPoint = (world: { x: number; y: number }, shift: boolean) => {
    const pts = getEditor().penDraft?.points
    const prev = pts?.[pts.length - 1]
    const p = shift && prev ? constrain45(prev, world) : world
    return { x: px(p.x), y: px(p.y) }
  }

  const penDown = (e: RPointerEvent<HTMLDivElement>, world: { x: number; y: number }) => {
    const s = getEditor()
    const d = s.penDraft
    const startClient = { x: e.clientX, y: e.clientY }
    // click the first anchor: close the shape (drag to curve the closing segment)
    if (d && d.points.length >= 2 && nearPoint(d.points[0], world)) {
      gesture.current = { kind: 'pen', index: 0, startClient, dragged: false, closing: true }
      return
    }
    // click the last anchor again (or double-click): finish the open path
    if (d && d.points.length && nearPoint(d.points[d.points.length - 1], world)) {
      s.commitPen(false)
      s.setTool('move')
      return
    }
    const p = penPoint(world, e.shiftKey)
    const parentId = d ? d.parentId : frameAt(s.doc, e.clientX, e.clientY, new Set())
    const points = [...(d?.points ?? []), p]
    s.set({ penDraft: { points, parentId, cursor: null, closing: false }, selection: [], hoverId: null })
    gesture.current = { kind: 'pen', index: points.length - 1, startClient, dragged: false, closing: false }
  }

  /** dragging after placing an anchor pulls out mirrored curve handles */
  const penDrag = (g: Extract<Gesture, { kind: 'pen' }>, e: RPointerEvent<HTMLDivElement>, world: { x: number; y: number }) => {
    const s = getEditor()
    const d = s.penDraft
    if (!d || !d.points[g.index]) return
    if (!g.dragged) {
      if (Math.hypot(e.clientX - g.startClient.x, e.clientY - g.startClient.y) < 3) return
      g.dragged = true
    }
    const a = d.points[g.index]
    const h0 = e.shiftKey ? constrain45(a, world) : world
    const out = { x: px(h0.x), y: px(h0.y) }
    const points = d.points.slice()
    points[g.index] = { x: a.x, y: a.y, out, in: { x: 2 * a.x - out.x, y: 2 * a.y - out.y } }
    s.set({ penDraft: { ...d, points, cursor: null } })
  }

  const penHover = (e: RPointerEvent<HTMLDivElement>, world: { x: number; y: number }) => {
    const s = getEditor()
    const d = s.penDraft
    if (!d) return
    const closing = d.points.length >= 2 && nearPoint(d.points[0], world)
    s.set({ penDraft: { ...d, cursor: closing ? { ...d.points[0] } : penPoint(world, e.shiftKey), closing } })
  }

  const startMove = (clientX: number, clientY: number, world: { x: number; y: number }, alt: boolean, clickSelect: string | null = null) => {
    const s = getEditor()
    const ids = s.selection.filter((id) => !s.doc.nodes[id]?.locked)
    if (!ids.length) return
    const rects: Record<string, Rect> = {}
    for (const id of ids) {
      const r = measure(id)
      if (r) rects[id] = r
    }
    const bbox = unionRects(Object.values(rects))
    if (!bbox) return
    const parents = new Set(ids.map((id) => s.doc.nodes[id].parentId))
    const onlyParent = parents.size === 1 ? [...parents][0] : null
    const flowParent =
      onlyParent && s.doc.nodes[onlyParent].layout.mode === 'flex' && ids.every((id) => s.doc.nodes[id].positioning !== 'absolute') ? onlyParent : null
    const exclude = new Set<string>()
    for (const id of ids) {
      exclude.add(id)
      for (const d of descendants(s.doc, id)) exclude.add(d)
    }
    gesture.current = {
      kind: 'move',
      startClient: { x: clientX, y: clientY },
      startWorld: world,
      ids,
      rects,
      bbox,
      started: false,
      alt,
      cands: [],
      flowParent,
      exclude,
      clickSelect,
    }
  }

  // exposed for overlay (artboard labels)
  useEffect(() => {
    overlayStartMove = (clientX, clientY, pointerId) => {
      const r = vpRef.current!.getBoundingClientRect()
      startMove(clientX, clientY, screenToWorld(clientX - r.left, clientY - r.top, getEditor().camera), false)
      try {
        vpRef.current!.setPointerCapture(pointerId)
      } catch {
        /* pointer already released */
      }
    }
    overlayStartResize = (id, handle, clientX, clientY, pointerId) => {
      const s = getEditor()
      const rect = measure(id)
      const local = measureLocal(id)
      if (!rect || !local) return
      const r = vpRef.current!.getBoundingClientRect()
      s.checkpoint()
      const n = s.doc.nodes[id]
      gesture.current = {
        kind: 'resize',
        id,
        handle,
        startWorld: screenToWorld(clientX - r.left, clientY - r.top, s.camera),
        rect,
        local: { x: n.x, y: n.y },
        cands: snapCandidates(s.doc, s.pageId, [id]),
        textWidthOnly: n.type === 'text' && (handle === 'e' || handle === 'w'),
      }
      try {
        vpRef.current!.setPointerCapture(pointerId)
      } catch {
        /* pointer already released */
      }
    }
  })

  /* ---------------- pointer move */
  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    const s = getEditor()
    const g = gesture.current
    if (!g) {
      if (s.tool === 'pen' && !s.spaceDown) return penHover(e, toWorld(e))
      // hover
      if (s.tool === 'move' && !s.spaceDown) {
        const target = e.target as HTMLElement
        if (target.closest('[data-overlay-ui]')) return
        const hit = hitIdAt(e.clientX, e.clientY)
        let id = hit ? resolveTarget(s.doc, hit, s.selection, isDeep(e)) : null
        if (id && isArtboard(s.doc, id) && hit === id && !s.selection.includes(id)) id = null
        if (id !== s.hoverId) s.set({ hoverId: id })
      }
      return
    }
    const world = toWorld(e)
    switch (g.kind) {
      case 'pan':
        if (g.right) {
          // the release was lost (e.g. it happened outside the window): stop panning
          if (!(e.buttons & 2)) {
            gesture.current = null
            setCursor(null)
            return
          }
          if (!g.right.moved) {
            if (Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < 4) return
            g.right.moved = true
            setCursor('grabbing')
          }
        }
        s.setCamera({ x: g.cx + (e.clientX - g.sx), y: g.cy + (e.clientY - g.sy) })
        return
      case 'marquee': {
        const r: Rect = {
          x: Math.min(g.start.x, world.x),
          y: Math.min(g.start.y, world.y),
          w: Math.abs(world.x - g.start.x),
          h: Math.abs(world.y - g.start.y),
        }
        const hits = g.scope.filter((id) => {
          const n = s.doc.nodes[id]
          if (!n || !n.visible || n.locked) return false
          const nr = measure(id)
          return nr && rectsIntersect(r, nr)
        })
        const sel = g.additive ? [...new Set([...g.base, ...hits])] : hits
        s.set({ marquee: r, selection: sel })
        return
      }
      case 'create': {
        const dx = e.clientX - g.startClient.x
        const dy = e.clientY - g.startClient.y
        if (Math.hypot(dx, dy) < 3) return
        let w = world.x - g.start.x
        let h = world.y - g.start.y
        if (e.shiftKey) {
          const m = Math.max(Math.abs(w), Math.abs(h))
          w = Math.sign(w || 1) * m
          h = Math.sign(h || 1) * m
        }
        g.rect = { x: Math.min(g.start.x, g.start.x + w), y: Math.min(g.start.y, g.start.y + h), w: Math.abs(w), h: Math.abs(h) }
        setCreateRect(g.rect)
        return
      }
      case 'move': {
        if (!g.started) {
          if (Math.hypot(e.clientX - g.startClient.x, e.clientY - g.startClient.y) < 3) return
          g.started = true
          if (g.alt || e.altKey) {
            const created = s.duplicateSelection(false)
            g.ids = created
            g.exclude = new Set(created.flatMap((id) => [id, ...descendants(getEditor().doc, id)]))
            g.rects = Object.fromEntries(created.map((id, i) => [id, Object.values(g.rects)[i]]))
          }
          g.cands = snapCandidates(getEditor().doc, s.pageId, g.ids)
          s.set({ hoverId: null })
        }
        const doc = getEditor().doc
        if (g.ids.some((id) => !doc.nodes[id])) {
          gesture.current = null
          s.set({ drag: null, guides: [] })
          return
        }
        let dx = world.x - g.startWorld.x
        let dy = world.y - g.startWorld.y
        if (e.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0
          else dx = 0
        }
        // target parent
        let targetParent: string | null
        const topLevelFrames = g.ids.every((id) => doc.nodes[id].parentId === null && doc.nodes[id].type === 'frame')
        if (g.flowParent) {
          const pr = measure(g.flowParent)
          const inside = pr && world.x >= pr.x && world.x <= pr.x + pr.w && world.y >= pr.y && world.y <= pr.y + pr.h
          targetParent = inside ? g.flowParent : frameAt(doc, e.clientX, e.clientY, g.exclude)
        } else if (topLevelFrames && !isMod(e)) {
          targetParent = null
        } else {
          targetParent = frameAt(doc, e.clientX, e.clientY, g.exclude)
        }
        let guides: Guide[] = []
        let insertIndex: number | null = null
        let indicator: Rect | null = null
        const targetIsFlex = targetParent && doc.nodes[targetParent].layout.mode === 'flex'
        if (targetIsFlex) {
          const fi = flexInsertion(doc, targetParent!, world, g.exclude)
          insertIndex = fi.index
          indicator = fi.indicator
        } else if (!isMod(e)) {
          const moved = { ...g.bbox, x: g.bbox.x + dx, y: g.bbox.y + dy }
          const sn = computeSnap(moved, g.cands, s.camera.zoom)
          dx += sn.dx
          dy += sn.dy
          guides = sn.guides
        }
        if (s.view.snapToPixel) {
          dx = Math.round(dx)
          dy = Math.round(dy)
        }
        s.set({
          drag: { ids: g.ids, dx, dy, targetParent, insertIndex, indicator, duplicate: g.alt },
          guides,
        })
        return
      }
      case 'resize':
        applyResize(g, world, e.shiftKey, e.altKey)
        return
      case 'pen':
        penDrag(g, e, world)
        return
    }
  }

  /* ---------------- pointer up */
  const onPointerUp = () => {
    const s = getEditor()
    const g = gesture.current
    gesture.current = null
    setCursor(null)
    if (!g) return
    switch (g.kind) {
      case 'pan':
        if (g.right) {
          // Windows / Linux send contextmenu after the release: ignore that one
          suppressCtxUntil.current = performance.now() + 400
          if (!g.right.moved) openContextMenu(g.sx, g.sy, g.right.mod)
        }
        return
      case 'marquee':
        s.set({ marquee: null })
        return
      case 'create': {
        setCreateRect(null)
        // the parent is decided by where the gesture started, not where it ended
        finishCreate(g.type, g.start, g.rect, g.startClient.x, g.startClient.y)
        return
      }
      case 'move': {
        const drag = s.drag
        s.set({ drag: null, guides: [] })
        if (!g.started || !drag) {
          if (g.clickSelect && s.doc.nodes[g.clickSelect]) s.select([g.clickSelect])
          return
        }
        commitDrag(g, drag)
        if (g.alt) s.squashHistory()
        return
      }
      case 'resize':
        s.set({ guides: [] })
        s.bumpMeasure()
        return
      case 'pen':
        if (g.closing) {
          s.commitPen(true)
          s.setTool('move')
        }
        return
    }
  }

  const commitDrag = (g: Extract<Gesture, { kind: 'move' }>, drag: NonNullable<ReturnType<typeof getEditor>['drag']>) => {
    const s = getEditor()
    const doc = s.doc
    const { dx, dy, targetParent, insertIndex } = drag
    const sameParent = g.ids.every((id) => doc.nodes[id].parentId === targetParent)
    if (sameParent && targetParent && doc.nodes[targetParent].layout.mode === 'flex' && g.ids.every((id) => doc.nodes[id].positioning !== 'absolute')) {
      s.reparent(g.ids, targetParent, insertIndex, undefined)
      return
    }
    if (sameParent) {
      if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return
      s.setProps(g.ids, (n) => {
        n.x = px(n.x + dx)
        n.y = px(n.y + dy)
      })
      return
    }
    const worldPos: Record<string, { x: number; y: number }> = {}
    for (const id of g.ids) {
      const r = g.rects[id]
      if (r) worldPos[id] = { x: r.x + dx, y: r.y + dy }
    }
    s.reparent(g.ids, targetParent, insertIndex, worldPos)
  }

  const applyResize = (g: Extract<Gesture, { kind: 'resize' }>, world: { x: number; y: number }, shift: boolean, alt: boolean) => {
    const s = getEditor()
    const n = s.doc.nodes[g.id]
    if (!n) return
    const dxw = world.x - g.startWorld.x
    const dyw = world.y - g.startWorld.y
    const h = g.handle
    let { x, y, w, h: hh } = g.rect
    const left = h.includes('w')
    const right = h.includes('e')
    const top = h.includes('n')
    const bottom = h.includes('s')
    if (right) w = g.rect.w + dxw * (alt ? 2 : 1)
    if (left) {
      w = g.rect.w - dxw * (alt ? 2 : 1)
      x = g.rect.x + dxw
    }
    if (bottom) hh = g.rect.h + dyw * (alt ? 2 : 1)
    if (top) {
      hh = g.rect.h - dyw * (alt ? 2 : 1)
      y = g.rect.y + dyw
    }
    if (alt) {
      if (left || right) x = g.rect.x + (g.rect.w - w) / 2
      if (top || bottom) y = g.rect.y + (g.rect.h - hh) / 2
    }
    if (shift && (left || right) && (top || bottom)) {
      const ratio = g.rect.w / Math.max(g.rect.h, 1)
      if (Math.abs(w / ratio) > Math.abs(hh)) hh = w / ratio
      else w = hh * ratio
      if (top) y = g.rect.y + g.rect.h - hh
      if (left) x = g.rect.x + g.rect.w - w
      if (alt) {
        x = g.rect.x + (g.rect.w - w) / 2
        y = g.rect.y + (g.rect.h - hh) / 2
      }
    }
    // snap moving edges
    let guides: Guide[] = []
    if (!alt && !shift) {
      const edges = { x: [] as number[], y: [] as number[] }
      if (right) edges.x.push(x + w)
      if (left) edges.x.push(x)
      if (bottom) edges.y.push(y + hh)
      if (top) edges.y.push(y)
      const th = SNAP_PX / s.camera.zoom
      const sx = edges.x.length ? snapAxis(edges.x, g.cands.flatMap((c) => [c.x, c.x + c.w / 2, c.x + c.w]), th) : null
      const sy = edges.y.length ? snapAxis(edges.y, g.cands.flatMap((c) => [c.y, c.y + c.h / 2, c.y + c.h]), th) : null
      if (sx) {
        if (right) w += sx.delta
        else {
          x += sx.delta
          w -= sx.delta
        }
        guides.push({ axis: 'x', pos: sx.at, from: Math.min(y, ...g.cands.map((c) => c.y)), to: Math.max(y + hh, ...g.cands.map((c) => c.y + c.h)) })
      }
      if (sy) {
        if (bottom) hh += sy.delta
        else {
          y += sy.delta
          hh -= sy.delta
        }
        guides.push({ axis: 'y', pos: sy.at, from: Math.min(x, ...g.cands.map((c) => c.x)), to: Math.max(x + w, ...g.cands.map((c) => c.x + c.w)) })
      }
      guides = guides.slice(0, 2)
    }
    w = Math.max(1, px(w))
    hh = Math.max(1, px(hh))
    // keep the opposite edge anchored once the size clamps
    if (!alt) {
      if (left) x = g.rect.x + g.rect.w - w
      if (top) y = g.rect.y + g.rect.h - hh
    }
    const parent = n.parentId ? s.doc.nodes[n.parentId] : null
    const inFlow = parent && parent.layout.mode === 'flex' && n.positioning !== 'absolute'
    s.updateSilently((d) => {
      const m = d.nodes[g.id]
      if (left || right) {
        m.width = w
        m.widthMode = 'fixed'
      }
      if ((top || bottom) && !g.textWidthOnly) {
        m.height = hh
        m.heightMode = 'fixed'
      }
      if (!inFlow) {
        m.x = px(g.local.x + (x - g.rect.x))
        m.y = px(g.local.y + (y - g.rect.y))
      }
    })
    s.set({ guides })
  }

  const finishCreate = (type: NodeType, start: { x: number; y: number }, r: Rect | null, clientX: number, clientY: number) => {
    const s = getEditor()
    const doc = s.doc
    if (type === 'image') {
      pickImage((files) => insertImageFiles(files, start))
      s.setTool('move')
      return
    }
    const parentId = type === 'frame' && !r ? null : frameAt(doc, clientX, clientY, new Set())
    const parentAtStart = parentId
    const defaults: Record<string, [number, number]> = { frame: [390, 844], rect: [120, 120], ellipse: [120, 120], shader: [480, 320], text: [0, 0] }
    const rect: Rect = r && r.w > 2 && r.h > 2 ? r : { x: start.x, y: start.y, w: defaults[type][0], h: defaults[type][1] }
    const node = createNode(type, s.pageId, { x: px(rect.x), y: px(rect.y), width: Math.max(1, px(rect.w)), height: Math.max(1, px(rect.h)) })
    if (type === 'shader') {
      node.shader = defaultShaderSpec('aurora')
      node.name = 'Shader'
      node.radius = 0
    }
    if (type === 'frame' && !parentAtStart) {
      node.name = r ? 'Frame' : 'Mobile'
      node.radius = 0
    }
    if (type === 'frame' && parentAtStart) {
      node.fills = []
      node.clip = false
    }
    if (type === 'text') {
      node.text = { ...node.text!, content: '' }
      if (r && r.w > 8) {
        node.widthMode = 'fixed'
        node.width = px(r.w)
      }
    }
    let index: number | undefined
    if (parentAtStart) {
      const p = doc.nodes[parentAtStart]
      if (p.layout.mode === 'flex') {
        index = flexInsertion(doc, parentAtStart, start, new Set()).index
      } else {
        const o = parentOrigin(doc, parentAtStart)
        node.x = px(rect.x - o.x)
        node.y = px(rect.y - o.y)
      }
    }
    s.addNode(node, parentAtStart, index)
    s.set({ selection: [node.id], tool: 'move', editingTextId: type === 'text' ? node.id : null })
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    const s = getEditor()
    if (s.tool !== 'move') return
    const hit = hitIdAt(e.clientX, e.clientY)
    if (!hit) return
    const path = pathTo(s.doc, hit)
    const cur = s.selection[0]
    const node = cur ? s.doc.nodes[cur] : null
    if (node?.type === 'text' && !node.locked) {
      s.set({ editingTextId: node.id })
      return
    }
    // dive one level deeper along the hit path
    const i = cur ? path.indexOf(cur) : -1
    const next = path[i + 1]
    if (next) {
      const nn = s.doc.nodes[next]
      s.select([next])
      if (nn.type === 'text' && next === hit) s.set({ editingTextId: next })
    } else if (s.doc.nodes[hit]?.type === 'text') {
      s.select([hit])
      s.set({ editingTextId: hit })
    }
  }

  const openContextMenu = (clientX: number, clientY: number, mod: boolean) => {
    const s = getEditor()
    const hit = hitIdAt(clientX, clientY)
    if (hit) {
      const t = resolveTarget(s.doc, hit, s.selection, mod !== s.view.deepSelect)
      if (t && !s.selection.includes(t)) s.select([t])
    }
    s.set({ contextMenu: { x: clientX, y: clientY } })
  }

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    const g = gesture.current
    // right-drag pan in progress (macOS sends contextmenu on press): decide on release
    if (g?.kind === 'pan' && g.right) return
    if (performance.now() < suppressCtxUntil.current) return
    openContextMenu(e.clientX, e.clientY, isMod(e))
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'))
    if (files.length) insertImageFiles(files, toWorld(e))
  }

  const toolCursor: Record<string, string> = {
    hand: 'grab',
    pen: penClosing ? PEN_CLOSE_CURSOR : PEN_CURSOR,
    frame: 'crosshair',
    rect: 'crosshair',
    ellipse: 'crosshair',
    shader: 'crosshair',
    text: 'text',
    image: 'copy',
    comment: 'cell',
  }
  const cur = cursor ?? (spaceDown ? 'grab' : toolCursor[tool] ?? 'default')

  return (
    <div
      ref={vpRef}
      className="k-viewport"
      style={{ background: page?.background, cursor: cur }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        gesture.current = null
        setCursor(null)
        setCreateRect(null)
        getEditor().set({ drag: null, guides: [], marquee: null })
      }}
      onPointerLeave={() => !gesture.current && getEditor().hoverId && getEditor().set({ hoverId: null })}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <div
        ref={worldRef}
        className="k-world"
        style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})` }}
      >
        {page?.children.map((id) => (
          <NodeView key={id} id={id} />
        ))}
      </div>
      {pixelGrid && camera.zoom >= PIXEL_GRID_ZOOM && (
        <div
          className="k-pixel-grid"
          aria-hidden
          style={{
            backgroundSize: `${camera.zoom}px ${camera.zoom}px`,
            backgroundPosition: `${camera.x}px ${camera.y}px`,
            opacity: Math.min(1, (camera.zoom - PIXEL_GRID_ZOOM) / 4 + 0.35),
          }}
        />
      )}
      <Overlay createRect={createRect} />
    </div>
  )
}

/** pen-nib cursor (tip at 3,3), white-haloed so it reads on any canvas; the closing variant adds a ring */
function penCursor(ring: boolean) {
  const nib =
    '<path d="M15.7 21.3a1 1 0 0 1-1.4 0l-1.6-1.6a1 1 0 0 1 0-1.4l5.6-5.6a1 1 0 0 1 1.4 0l1.6 1.6a1 1 0 0 1 0 1.4z"/>' +
    '<path d="m18 13-1.4-6.9a1 1 0 0 0-.7-.8L3.2 2a1 1 0 0 0-1.2 1.2l3.3 12.7a1 1 0 0 0 .8.7L13 18"/><path d="m2.3 2.3 7.3 7.3"/><circle cx="11" cy="11" r="2"/>'
  const extra = ring ? '<circle cx="20" cy="4" r="2.6"/>' : ''
  const g = (stroke: string, w: number) => `<g fill="none" stroke="${stroke}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${nib}${extra}</g>`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">${g('white', 4)}${g('black', 1.6)}</svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 2 2, crosshair`
}
const PEN_CURSOR = penCursor(false)
const PEN_CLOSE_CURSOR = penCursor(true)

export let overlayStartMove: (clientX: number, clientY: number, pointerId: number) => void = () => {}
export let overlayStartResize: (id: string, handle: string, clientX: number, clientY: number, pointerId: number) => void = () => {}

function pickImage(cb: (files: File[]) => void) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.multiple = true
  input.onchange = () => cb([...(input.files ?? [])])
  input.click()
}
