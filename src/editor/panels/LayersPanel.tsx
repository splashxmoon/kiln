import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import {
  ChevronRight,
  Circle,
  Eye,
  EyeOff,
  Frame,
  Image as ImageIcon,
  Lock,
  PenTool,
  Unlock,
  Square,
  Type,
  Sparkles,
  Plus,
  FileText,
  Trash2,
  LayoutGrid,
  PanelLeft,
  ChevronDown,
  Check,
  Layers as LayersIcon,
  Search,
} from 'lucide-react'
import { useEditor, getEditor, ancestors, descendants, sortByOrder } from '../store'
import type { KNode, Token } from '../types'
import { PRESETS, insertPreset } from '../presets'
import { createToken } from '../factory'
import { normalizeHex } from '../ui/controls'
import { ColorSwatchButton } from '../../ui/ColorPicker'
import { askConfirm } from '../../ui/Dialogs'
import { Popover } from '../../ui/Popover'
import './layers-filter.css'
import './tokens.css'
import { tokenVarName } from '../style'
import { shortcut, isMod } from '../../platform/keys'

export function TypeIcon({ node, size = 13 }: { node: KNode; size?: number }) {
  const p = { size, strokeWidth: 1.75 }
  switch (node.type) {
    case 'frame':
      return node.parentId === null ? <Frame {...p} /> : <LayoutGrid {...p} />
    case 'rect':
      return <Square {...p} />
    case 'ellipse':
      return <Circle {...p} />
    case 'path':
      return <PenTool {...p} />
    case 'text':
      return <Type {...p} />
    case 'image':
      return <ImageIcon {...p} />
    case 'shader':
      return <Sparkles {...p} />
  }
}

/* ------------------------------------------------------------------ pages */

function Pages() {
  const pages = useEditor((s) => s.doc.pages)
  const pageId = useEditor((s) => s.pageId)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [open, setOpen] = useState(true)
  return (
    <div className="k-pages">
      <div className="k-panel-head">
        <button className="k-panel-title" onClick={() => setOpen(!open)}>
          <ChevronRight size={12} className={open ? 'k-rot' : ''} /> Pages
        </button>
        <span className="k-panel-actions">
          <button className="k-icon-btn k-sm" title="Add page" onClick={() => getEditor().addPage()}>
            <Plus size={12} />
          </button>
          <button className="k-icon-btn k-sm" title={`Hide panel (${shortcut('⌘\\')})`} onClick={() => getEditor().setView({ leftPanel: false })}>
            <PanelLeft size={13} />
          </button>
        </span>
      </div>
      {open &&
        pages.map((p) => (
          <div key={p.id} className={'k-page-row' + (p.id === pageId ? ' is-on' : '')} onClick={() => getEditor().setPage(p.id)} onDoubleClick={() => setRenaming(p.id)}>
            <FileText size={13} strokeWidth={1.75} />
            {renaming === p.id ? (
              <input
                autoFocus
                defaultValue={p.name}
                onBlur={(e) => {
                  if (e.target.value.trim()) getEditor().renamePage(p.id, e.target.value.trim())
                  setRenaming(null)
                }}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  if (e.key === 'Escape') setRenaming(null)
                }}
              />
            ) : (
              <span>{p.name}</span>
            )}
            {pages.length > 1 && (
              <button
                className="k-row-action"
                title="Delete page"
                onClick={async (e) => {
                  e.stopPropagation()
                  const ok = await askConfirm({ title: `Delete “${p.name}”?`, body: 'Everything on this page is removed. You can undo this.', confirmLabel: 'Delete page', danger: true })
                  if (ok) getEditor().deletePage(p.id)
                }}
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        ))}
    </div>
  )
}

/* ------------------------------------------------------------------ layers */

type DropPos = 'before' | 'after' | 'inside'

interface LayerDrag {
  ids: string[]
  label: string
  x: number
  y: number
  overId: string | null
  pos: DropPos | 'root' | null
}
const useLayerDrag = create<{ drag: LayerDrag | null }>(() => ({ drag: null }))
let suppressClickUntil = 0

function dropTargetAt(x: number, y: number, ids: string[]): Pick<LayerDrag, 'overId' | 'pos'> {
  const hit = document.elementFromPoint(x, y)
  const row = hit?.closest<HTMLElement>('.k-layer[data-layer-id]')
  const doc = getEditor().doc
  if (!row) return hit?.closest('.k-layer-list') ? { overId: null, pos: 'root' } : { overId: null, pos: null }
  const id = row.dataset.layerId!
  const node = doc.nodes[id]
  // never drop into the dragged layers themselves or their descendants
  if (!node || ids.includes(id) || ancestors(doc, id).some((a) => ids.includes(a))) return { overId: null, pos: null }
  const r = row.getBoundingClientRect()
  const t = (y - r.top) / r.height
  const pos: DropPos = node.type === 'frame' ? (t < 0.28 ? 'before' : t > 0.72 ? 'after' : 'inside') : t < 0.5 ? 'before' : 'after'
  return { overId: id, pos }
}

function startLayerDrag(e: React.PointerEvent, id: string) {
  if (e.button !== 0 || (e.target as Element).closest('button, input')) return
  const sx = e.clientX
  const sy = e.clientY
  let started = false
  const list = (e.currentTarget as HTMLElement).closest<HTMLElement>('.k-layer-list')
  const move = (ev: PointerEvent) => {
    if (!started) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return
      started = true
      const s = getEditor()
      const ids = s.selection.includes(id) ? sortByOrder(s.doc, s.selection, s.pageId) : [id]
      const first = s.doc.nodes[ids[0]]
      useLayerDrag.setState({ drag: { ids, label: first?.name ?? 'Layer', x: ev.clientX, y: ev.clientY, overId: null, pos: null } })
      document.body.classList.add('k-dragging-layers')
    }
    // auto-scroll near the list edges
    if (list) {
      const r = list.getBoundingClientRect()
      if (ev.clientY < r.top + 24) list.scrollTop -= 8
      else if (ev.clientY > r.bottom - 24) list.scrollTop += 8
    }
    const d = useLayerDrag.getState().drag
    if (!d) return
    const t = dropTargetAt(ev.clientX, ev.clientY, d.ids)
    useLayerDrag.setState({ drag: { ...d, x: ev.clientX, y: ev.clientY, ...t } })
    getEditor().set({ hoverId: t.overId })
  }
  const end = (commit: boolean) => {
    window.removeEventListener('pointermove', move, true)
    window.removeEventListener('pointerup', up, true)
    window.removeEventListener('pointercancel', cancel, true)
    window.removeEventListener('keydown', key, true)
    document.body.classList.remove('k-dragging-layers')
    const d = useLayerDrag.getState().drag
    useLayerDrag.setState({ drag: null })
    if (!started) return
    suppressClickUntil = Date.now() + 80
    if (!commit || !d || !d.pos) return
    const s = getEditor()
    const doc = s.doc
    if (d.pos === 'root') s.reparent(d.ids, null, null, undefined)
    else if (d.overId && d.pos === 'inside') s.reparent(d.ids, d.overId, doc.nodes[d.overId].children.length, undefined)
    else if (d.overId) {
      const target = doc.nodes[d.overId]
      const parentId = target.parentId
      const siblings = parentId ? doc.nodes[parentId].children : doc.pages.find((p) => p.id === s.pageId)!.children
      const idx = siblings.indexOf(d.overId)
      // the panel lists front-most first, so "before" (above) means later in paint order
      s.reparent(d.ids, parentId, d.pos === 'before' ? idx + 1 : idx, undefined)
    }
  }
  const up = () => end(true)
  const cancel = () => end(false)
  const key = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape') return
    ev.stopPropagation()
    ev.preventDefault()
    end(false)
  }
  window.addEventListener('pointermove', move, true)
  window.addEventListener('pointerup', up, true)
  window.addEventListener('pointercancel', cancel, true)
  window.addEventListener('keydown', key, true)
}

function LayerDragGhost() {
  const drag = useLayerDrag((s) => s.drag)
  if (!drag) return null
  return createPortal(
    <div className="k-drag-ghost" style={{ left: drag.x, top: drag.y }}>
      {drag.label}
      {drag.ids.length > 1 && <b>{drag.ids.length}</b>}
    </div>,
    document.body,
  )
}

/** Every layer row is this tall (`.k-layer` in editor.css); the list draws only the rows in view. */
const ROW_H = 28
/** Rows drawn above and below the visible ones, so fast scrolling doesn't show gaps. */
const OVERSCAN = 10
/** `.k-layer-list` top padding */
const LIST_PAD = 2

interface Row {
  id: string
  depth: number
}

/** The tree as the panel lists it (front-most first), through open frames only. */
function flattenRows(nodes: Record<string, KNode>, roots: readonly string[], expanded: Set<string>): Row[] {
  const out: Row[] = []
  const walk = (ids: readonly string[], depth: number) => {
    for (let i = ids.length - 1; i >= 0; i--) {
      const n = nodes[ids[i]]
      if (!n) continue
      out.push({ id: n.id, depth })
      if (n.children.length && expanded.has(n.id)) walk(n.children, depth + 1)
    }
  }
  walk(roots, 0)
  return out
}

/** Whether a frame that contains `id` is selected. */
function underSelection(nodes: Record<string, KNode>, id: string, selected: Set<string>) {
  for (let p = nodes[id]?.parentId; p; p = nodes[p]?.parentId) if (selected.has(p)) return true
  return false
}

/** The slice of `count` rows that is in view in the scrolling list `el`. */
function useRowWindow(el: HTMLDivElement | null, count: number) {
  const [view, setView] = useState({ top: 0, height: 900 })
  useLayoutEffect(() => {
    if (!el) return
    const update = () => setView((v) => (v.top === el.scrollTop && v.height === el.clientHeight ? v : { top: el.scrollTop, height: el.clientHeight }))
    update()
    el.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [el])
  // capped: after the list shrinks (a filter, a collapse) the old scroll position can be past the end
  const start = Math.min(count, Math.max(0, Math.floor((view.top - LIST_PAD) / ROW_H) - OVERSCAN))
  const end = Math.min(count, Math.ceil((view.top - LIST_PAD + view.height) / ROW_H) + OVERSCAN)
  return { start, end }
}

/** Scrolls the list just enough to show row `index`. */
function scrollRowIntoView(el: HTMLElement, index: number) {
  const top = LIST_PAD + index * ROW_H
  if (top < el.scrollTop) el.scrollTop = top
  else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight
}

interface LayerRowProps {
  id: string
  depth: number
  open: boolean
  selected: boolean
  parentSelected: boolean
  renaming: boolean
  /** `deep`: also every frame inside it (Alt-click on the arrow) */
  toggle: (id: string, deep?: boolean) => void
  setRenaming: (id: string | null) => void
}

/** One row. Memoised: a row draws again only when its own layer, hover or drop state changes. */
const LayerRow = memo(function LayerRow({ id, depth, open, selected, parentSelected, renaming, toggle, setRenaming }: LayerRowProps) {
  const node = useEditor((s) => s.doc.nodes[id])
  const hovered = useEditor((s) => s.hoverId === id)
  const drop = useLayerDrag((s) => (s.drag && s.drag.overId === id ? (s.drag.pos as DropPos) : null))
  if (!node) return null
  const hasKids = node.children.length > 0

  return (
    <div
      className={
        'k-layer' +
        (selected ? ' is-selected' : '') +
        (parentSelected ? ' is-child-of-selected' : '') +
        (hovered ? ' is-hovered' : '') +
        (!node.visible ? ' is-hidden' : '') +
        (drop ? ' drop-' + drop : '')
      }
      style={{ paddingLeft: 12 + depth * 12 }}
      data-layer-id={id}
      onPointerDown={(e) => !renaming && startLayerDrag(e, id)}
      onPointerEnter={() => getEditor().set({ hoverId: id })}
      onPointerLeave={() => getEditor().hoverId === id && getEditor().set({ hoverId: null })}
      onClick={(e) => {
        if (Date.now() < suppressClickUntil) return
        const s = getEditor()
        if (e.shiftKey || isMod(e)) s.select([id], true)
        else s.select([id])
      }}
      onDoubleClick={() => setRenaming(id)}
      onContextMenu={(e) => {
        e.preventDefault()
        const s = getEditor()
        if (!s.selection.includes(id)) s.select([id])
        s.set({ contextMenu: { x: e.clientX, y: e.clientY } })
      }}
    >
      <button
        className={'k-caret' + (hasKids ? '' : ' is-empty')}
        title={hasKids ? (open ? 'Collapse (Alt-click: and everything inside)' : 'Expand (Alt-click: and everything inside)') : undefined}
        onClick={(e) => {
          e.stopPropagation()
          toggle(id, e.altKey)
        }}
      >
        {hasKids && <ChevronRight size={12} className={open ? 'k-rot' : ''} />}
      </button>
      <span className="k-layer-icon">
        <TypeIcon node={node} />
      </span>
      {renaming ? (
        <RenameInput id={id} name={node.name} done={() => setRenaming(null)} />
      ) : (
        <span className="k-layer-name">{node.name}</span>
      )}
      {node.binding && <span className="k-layer-bind" title={'Bound to ' + node.binding}>{'{ }'}</span>}
      <span className="k-layer-actions">
        <button
          className={node.locked ? 'is-pinned' : ''}
          title={node.locked ? 'Unlock' : 'Lock'}
          onClick={(e) => {
            e.stopPropagation()
            getEditor().setProps([id], (n) => void (n.locked = !n.locked))
          }}
        >
          {node.locked ? <Lock size={12} /> : <Unlock size={12} />}
        </button>
        <button
          className={!node.visible ? 'is-pinned' : ''}
          title={node.visible ? 'Hide' : 'Show'}
          onClick={(e) => {
            e.stopPropagation()
            getEditor().setProps([id], (n) => void (n.visible = !n.visible))
          }}
        >
          {node.visible ? <Eye size={12} /> : <EyeOff size={12} />}
        </button>
      </span>
    </div>
  )
})

/**
 * The inline rename field. Enter or leaving the field saves, Esc cancels. If its row scrolls out
 * of the drawn window (the list is virtualised) the field unmounts without a blur: it saves then too.
 */
function RenameInput({ id, name, done }: { id: string; name: string; done: () => void }) {
  // the typed text is kept here: by the time an unmount's cleanup runs, the input ref is gone
  const value = useRef(name)
  const settled = useRef(false)
  const mounted = useRef(false)
  const finish = useRef<(save: boolean) => void>(() => {})
  useLayoutEffect(() => {
    finish.current = (save) => {
      if (settled.current) return
      settled.current = true
      const v = value.current.trim()
      if (save && v && v !== getEditor().doc.nodes[id]?.name) getEditor().setProps([id], (n) => void (n.name = v))
      done()
    }
  })
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      // a real unmount (the row scrolled out) saves; StrictMode's test unmount in dev remounts
      // straight away, before this runs, so the field stays open
      queueMicrotask(() => {
        if (!mounted.current) finish.current(true)
      })
    }
  }, [])
  return (
    <input
      className="k-layer-rename"
      autoFocus
      defaultValue={name}
      onChange={(e) => (value.current = e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => finish.current(true)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') finish.current(true)
        if (e.key === 'Escape') finish.current(false)
      }}
    />
  )
}

const NO_CHILDREN: readonly string[] = []

function Layers() {
  const roots = useEditor((s) => s.doc.pages.find((p) => p.id === s.pageId)?.children)
  const pageId = useEditor((s) => s.pageId)
  const nodes = useEditor((s) => s.doc.nodes)
  const selection = useEditor((s) => s.selection)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [filter, setFilter] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const rootDrop = useLayerDrag((s) => s.drag?.pos === 'root')
  const [listEl, setListEl] = useState<HTMLDivElement | null>(null)
  /** what to bring into view once its frames are open: the selection, or a layer being renamed */
  const reveal = useRef<'selection' | string | null>(null)

  const selected = useMemo(() => new Set(selection), [selection])
  const rows = useMemo(() => flattenRows(nodes, roots ?? NO_CHILDREN, expanded), [nodes, roots, expanded])
  const results = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return null
    return Object.values(nodes).filter((n) => n.pageId === pageId && (n.name.toLowerCase().includes(q) || n.text?.content.toLowerCase().includes(q)))
  }, [filter, nodes, pageId])
  const count = results ? results.length : rows.length
  const { start, end } = useRowWindow(listEl, count)

  const expandTo = useCallback((ids: string[]) => {
    setExpanded((prev) => {
      let next: Set<string> | null = null
      const doc = getEditor().doc
      for (const id of ids)
        for (const a of ancestors(doc, id))
          if (!prev.has(a)) {
            next ??= new Set(prev)
            next.add(a)
          }
      return next ?? prev
    })
  }, [])

  /** Whether every frame holding these layers is open in the panel (deleted layers count as shown). */
  const allOpen = (ids: string[], open: Set<string>) => ids.every((id) => ancestors(getEditor().doc, id).every((a) => open.has(a)))

  /** Scrolls to the first row `want` names, if that row is listed. */
  const scrollTo = useCallback(
    (want: 'selection' | string, list: Row[], sel: Set<string>) => {
      if (!listEl) return
      const i = want === 'selection' ? list.findIndex((r) => sel.has(r.id)) : list.findIndex((r) => r.id === want)
      if (i >= 0) scrollRowIntoView(listEl, i)
    },
    [listEl],
  )

  // reveal a new selection: scroll to it now if its frames are open, else open them and
  // scroll once they are (the effect below). Layout effects, so no frame shows the old place.
  useLayoutEffect(() => {
    if (!selection.length || results) return
    if (allOpen(selection, expanded)) return scrollTo('selection', rows, selected)
    reveal.current = 'selection'
    expandTo(selection)
    // only a new selection reveals; edits and scrolling later never jump the list. It runs again
    // when a search is cleared (a result picked while searching is shown in place) and once the
    // list element exists (the Layers tab opening with a selection already made)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, !!results, listEl])

  useLayoutEffect(() => {
    const want = reveal.current
    if (!want || results) return
    // wait for the frames being opened; a deleted layer counts as open and just clears this
    if (!allOpen(want === 'selection' ? selection : [want], expanded)) return
    reveal.current = null
    scrollTo(want, rows, selected)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows])

  /** this render's rows and open frames, for the rename event (it arrives outside a render) */
  const latest = useRef({ rows, expanded })
  useLayoutEffect(() => {
    latest.current = { rows, expanded }
  })

  // ⌘R and the context menu's "Rename" ask for an inline rename (commands.ts falls back to a dialog)
  useEffect(() => {
    const f = (e: Event) => {
      const { detail } = e as CustomEvent<{ id: string; handled?: boolean }>
      if (results || !getEditor().doc.nodes[detail.id]) return
      detail.handled = true
      setRenamingId(detail.id)
      const { rows, expanded } = latest.current
      if (allOpen([detail.id], expanded)) return scrollTo(detail.id, rows, new Set())
      reveal.current = detail.id
      expandTo([detail.id])
    }
    window.addEventListener('kiln:rename-layer', f)
    return () => window.removeEventListener('kiln:rename-layer', f)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, expandTo, scrollTo])

  const toggle = useCallback(
    (id: string, deep = false) =>
      setExpanded((prev) => {
        const n = new Set(prev)
        const open = !n.has(id)
        const ids = deep ? [id, ...descendants(getEditor().doc, id)] : [id]
        for (const x of ids) {
          if (open && getEditor().doc.nodes[x]?.children.length) n.add(x)
          else if (!open) n.delete(x)
        }
        return n
      }),
    [],
  )

  if (!roots) return null
  const slice = (results ?? rows).slice(start, end)
  return (
    <div className="k-layers">
      <div className="k-panel-head">
        <span className="k-panel-title">Layers</span>
        <label className={'k-filter-wrap' + (filter ? ' has-value' : '')}>
          <Search className="k-filter-icon" size={12} strokeWidth={2.25} aria-hidden="true" />
          <input className="k-filter" placeholder="Find…" aria-label="Find layers" value={filter} onChange={(e) => {
              setFilter(e.target.value)
              if (listEl) listEl.scrollTop = 0
            }} onKeyDown={(e) => e.stopPropagation()} />
        </label>
      </div>
      <div ref={setListEl} className={'k-layer-list' + (rootDrop ? ' is-drop-root' : '')}>
        {start > 0 && <div style={{ height: start * ROW_H }} aria-hidden="true" />}
        {results
          ? (slice as KNode[]).map((n) => (
              <div key={n.id} className={'k-layer' + (selected.has(n.id) ? ' is-selected' : '')} style={{ paddingLeft: 10 }} onClick={() => getEditor().select([n.id])}>
                <span className="k-layer-icon">
                  <TypeIcon node={n} />
                </span>
                <span className="k-layer-name">{n.name}</span>
              </div>
            ))
          : (slice as Row[]).map((r) => (
              <LayerRow
                key={r.id}
                id={r.id}
                depth={r.depth}
                open={expanded.has(r.id)}
                selected={selected.has(r.id)}
                parentSelected={underSelection(nodes, r.id, selected)}
                renaming={renamingId === r.id}
                toggle={toggle}
                setRenaming={setRenamingId}
              />
            ))}
        {end < count && <div style={{ height: (count - end) * ROW_H }} aria-hidden="true" />}
        {results && !results.length && (
          <div className="k-empty-hint">
            <p>No layers match “{filter}”.</p>
          </div>
        )}
        {!roots.length && (
          <div className="k-empty-hint">
            <p>This page is empty.</p>
            <p>
              Press <kbd>F</kbd> and click to add a frame, or open <b>Assets</b>.
            </p>
          </div>
        )}
      </div>
      <LayerDragGhost />
    </div>
  )
}

/* ------------------------------------------------------------------ assets */

function Assets() {
  const groups = useMemo(() => {
    const g: Record<string, typeof PRESETS> = {}
    for (const p of PRESETS) (g[p.group] ??= []).push(p)
    return g
  }, [])
  return (
    <div className="k-assets">
      {Object.entries(groups).map(([group, items]) => (
        <div key={group} className="k-asset-group">
          <div className="k-asset-title">{group}</div>
          <div className="k-asset-grid">
            {items.map((p) => (
              <button key={p.id} className="k-asset" onClick={() => insertPreset(p.id)} title={p.description}>
                <span className="k-asset-thumb" style={{ background: p.thumb }}>
                  {p.glyph}
                </span>
                <span>{p.label}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ tokens */

function Tokens() {
  const tokens = useEditor((s) => s.doc.tokens)
  const [adding, setAdding] = useState(false)
  // counted when the layers change, not on every store update (pan, hover, drag)
  const nodes = useEditor((s) => s.doc.nodes)
  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const n of Object.values(nodes)) {
      for (const f of n.fills) if (f.tokenId) c[f.tokenId] = (c[f.tokenId] ?? 0) + 1
      if (n.text?.tokenId) c[n.text.tokenId] = (c[n.text.tokenId] ?? 0) + 1
    }
    return c
  }, [nodes])

  return (
    <div className="k-tokens k-tk">
      <div className="k-tk-head">
        <span className="k-tk-title">Colors</span>
        {tokens.length > 0 && <span className="k-tk-count">{tokens.length}</span>}
        <button type="button" className={'k-tk-add-btn' + (adding ? ' is-on' : '')} title="New colour token" aria-label="New colour token" onClick={() => setAdding((a) => !a)}>
          <Plus size={13} strokeWidth={2.25} />
        </button>
      </div>

      {tokens.length === 0 && !adding ? (
        <div className="k-tk-empty">
          <div className="k-tk-empty-swatches" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
          <p className="k-tk-empty-title">No colour tokens yet</p>
          <p className="k-tk-empty-sub">Name a colour once and reuse it everywhere. Exports as a CSS variable.</p>
          <button type="button" className="k-btn-primary k-btn-sm" onClick={() => setAdding(true)}>
            <Plus size={12} strokeWidth={2.5} /> New colour
          </button>
        </div>
      ) : (
        <ul className="k-tk-list">
          {tokens.map((t) => (
            <TokenRow key={t.id} token={t} uses={counts[t.id] ?? 0} />
          ))}
        </ul>
      )}

      {adding && <TokenDraft onDone={() => setAdding(false)} />}

      {tokens.length > 0 && <p className="k-tk-note">Tokens export as CSS variables. Change one and every layer using it updates.</p>}
    </div>
  )
}

function TokenRow({ token: t, uses }: { token: Token; uses: number }) {
  const remove = () =>
    getEditor().update((d) => {
      d.tokens = d.tokens.filter((x) => x.id !== t.id)
      for (const n of Object.values(d.nodes)) {
        for (const f of n.fills)
          if (f.tokenId === t.id) {
            f.color = t.value
            delete f.tokenId
          }
        if (n.text?.tokenId === t.id) {
          n.text.color = t.value
          delete n.text.tokenId
        }
      }
    })
  return (
    <li className="k-tk-row">
      <ColorSwatchButton
        className="k-swatch k-tk-swatch"
        value={t.value}
        placement="right-start"
        label={'Edit ' + t.name}
        onChange={(hex, k) =>
          getEditor().update((d) => {
            const x = d.tokens.find((x) => x.id === t.id)
            if (x) x.value = hex
          }, 'token-' + t.id + k)
        }
      />
      <span className="k-tk-text">
        <input
          key={t.name}
          className="k-tk-name"
          defaultValue={t.name}
          aria-label="Token name"
          spellCheck={false}
          autoComplete="off"
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') {
              e.currentTarget.value = t.name
              e.currentTarget.blur()
            }
          }}
          onBlur={(e) => {
            const v = e.target.value.trim()
            if (!v) e.target.value = t.name
            else if (v !== t.name)
              getEditor().update((d) => {
                const x = d.tokens.find((x) => x.id === t.id)
                if (x) x.name = v
              })
          }}
        />
        <span className="k-tk-meta">
          <span className="k-tk-var">{tokenVarName(t)}</span>
          <span className={'k-tk-uses' + (uses ? '' : ' is-unused')}>{uses ? `${uses} layer${uses === 1 ? '' : 's'}` : 'unused'}</span>
        </span>
      </span>
      <span className="k-tk-hex">{t.value.toUpperCase()}</span>
      <button type="button" className="k-tk-del" title="Delete token (layers keep the colour)" aria-label={'Delete ' + t.name} onClick={remove}>
        <Trash2 size={12} />
      </button>
    </li>
  )
}

/** The inline card for a new token: colour, name, hex. Enter adds, Escape cancels. */
function TokenDraft({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('')
  const [hex, setHex] = useState('#FF5B1F')
  const valid = normalizeHex(hex)
  const add = () => {
    if (!name.trim() || !valid) return
    getEditor().update((d) => void d.tokens.push(createToken(name.trim(), valid)))
    onDone()
  }
  const keys = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation()
    if (e.key === 'Escape') onDone()
  }
  return (
    <form
      className="k-tk-draft"
      onSubmit={(e) => {
        e.preventDefault()
        add()
      }}
    >
      <div className="k-tk-draft-row">
        <ColorSwatchButton className="k-swatch k-tk-swatch" value={valid ?? '#000000'} placement="right-start" label="Pick colour" onChange={(h) => setHex(h.toUpperCase())} />
        <input className="k-tk-field" placeholder="Name, e.g. brand/accent" value={name} autoFocus spellCheck={false} autoComplete="off" onChange={(e) => setName(e.target.value)} onKeyDown={keys} />
      </div>
      <div className="k-tk-draft-row">
        <input className={'k-tk-field k-tk-field-hex' + (valid ? '' : ' is-bad')} value={hex} spellCheck={false} autoComplete="off" aria-label="Hex value" onChange={(e) => setHex(e.target.value)} onKeyDown={keys} />
        <button type="button" className="k-btn-sm k-tk-cancel" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="k-btn-primary k-btn-sm" disabled={!name.trim() || !valid}>
          Add
        </button>
      </div>
    </form>
  )
}

/* ------------------------------------------------------------------ panel */

/** What's left of the panel while it is hidden: a floating card with the file, a page switcher and the way back. */
export function LeftPanelCollapsed() {
  const open = useEditor((s) => s.view.leftPanel)
  const name = useEditor((s) => s.doc.name)
  const pages = useEditor((s) => s.doc.pages)
  const pageId = useEditor((s) => s.pageId)
  const [menu, setMenu] = useState(false)
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  if (open) return null
  const page = pages.find((p) => p.id === pageId)
  const onMenuKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') return
    e.stopPropagation()
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button')]
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
  }
  return (
    <div className="k-left-mini" onPointerDown={(e) => e.stopPropagation()}>
      <span className="k-left-mini-icon">
        <LayersIcon size={14} />
      </span>
      <div className="k-left-mini-text">
        <b title={name}>{name}</b>
        <button ref={setAnchor} className={'k-left-mini-page' + (menu ? ' is-on' : '')} onClick={() => setMenu(!menu)} aria-haspopup="menu" aria-expanded={menu} title="Switch page">
          <span>{page?.name}</span>
          <ChevronDown size={12} />
        </button>
      </div>
      <button className="k-icon-btn" title={`Show panel (${shortcut('⌘\\')})`} onClick={() => getEditor().setView({ leftPanel: true })}>
        <PanelLeft size={14} />
      </button>
      <Popover anchor={anchor} open={menu} onClose={() => setMenu(false)} placement="bottom-start" className="k-menu k-page-menu" role="menu" label="Pages">
        <div onKeyDown={onMenuKey}>
          {pages.map((p) => (
            <button
              key={p.id}
              role="menuitemradio"
              aria-checked={p.id === pageId}
              onClick={() => {
                getEditor().setPage(p.id)
                setMenu(false)
              }}
            >
              <span className="k-menu-check">{p.id === pageId && <Check size={12} strokeWidth={2.25} />}</span>
              <span className="k-menu-label">{p.name}</span>
            </button>
          ))}
          <div className="k-menu-sep" />
          <button
            role="menuitem"
            onClick={() => {
              getEditor().addPage()
              setMenu(false)
            }}
          >
            <span className="k-menu-check">
              <Plus size={12} />
            </span>
            <span className="k-menu-label">New page</span>
          </button>
        </div>
      </Popover>
    </div>
  )
}

export function LeftPanel() {
  const tab = useEditor((s) => s.leftTab)
  const open = useEditor((s) => s.view.leftPanel)
  if (!open) return null
  return (
    <aside className="k-left">
      <Pages />
      <div className="k-tabs">
        {(['layers', 'assets', 'tokens'] as const).map((t) => (
          <button key={t} className={tab === t ? 'is-on' : ''} onClick={() => getEditor().set({ leftTab: t })}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {tab === 'layers' && <Layers />}
      {tab === 'assets' && <Assets />}
      {tab === 'tokens' && <Tokens />}
    </aside>
  )
}
