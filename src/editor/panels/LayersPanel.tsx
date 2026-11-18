import { useEffect, useMemo, useState } from 'react'
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
import { useEditor, getEditor, ancestors, sortByOrder } from '../store'
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

function LayerRow({ id, depth, expanded, toggle }: { id: string; depth: number; expanded: Set<string>; toggle: (id: string) => void }) {
  const node = useEditor((s) => s.doc.nodes[id])
  const selected = useEditor((s) => s.selection.includes(id))
  const hovered = useEditor((s) => s.hoverId === id)
  const parentSelected = useEditor((s) => {
    const n = s.doc.nodes[id]
    return !!n && ancestors(s.doc, id).some((a) => s.selection.includes(a))
  })
  const [renaming, setRenaming] = useState(false)
  const drop = useLayerDrag((s) => (s.drag && s.drag.overId === id ? (s.drag.pos as DropPos) : null))
  useEffect(() => {
    const f = (e: Event) => {
      const ce = e as CustomEvent<{ id: string; handled?: boolean }>
      if (ce.detail.id !== id) return
      ce.detail.handled = true
      setRenaming(true)
    }
    window.addEventListener('kiln:rename-layer', f)
    return () => window.removeEventListener('kiln:rename-layer', f)
  }, [id])
  if (!node) return null
  const isOpen = expanded.has(id)
  const hasKids = node.children.length > 0
  const kids = [...node.children].reverse()

  return (
    <>
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
        onDoubleClick={() => setRenaming(true)}
        onContextMenu={(e) => {
          e.preventDefault()
          const s = getEditor()
          if (!s.selection.includes(id)) s.select([id])
          s.set({ contextMenu: { x: e.clientX, y: e.clientY } })
        }}
      >
        <button
          className={'k-caret' + (hasKids ? '' : ' is-empty')}
          onClick={(e) => {
            e.stopPropagation()
            toggle(id)
          }}
        >
          {hasKids && <ChevronRight size={12} className={isOpen ? 'k-rot' : ''} />}
        </button>
        <span className="k-layer-icon">
          <TypeIcon node={node} />
        </span>
        {renaming ? (
          <input
            className="k-layer-rename"
            autoFocus
            defaultValue={node.name}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => {
              const v = e.target.value.trim()
              if (v && v !== node.name) getEditor().setProps([id], (n) => void (n.name = v))
              setRenaming(false)
            }}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') setRenaming(false)
            }}
          />
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
      {isOpen && kids.map((c) => <LayerRow key={c} id={c} depth={depth + 1} expanded={expanded} toggle={toggle} />)}
    </>
  )
}

function Layers() {
  const page = useEditor((s) => s.doc.pages.find((p) => p.id === s.pageId))
  const selection = useEditor((s) => s.selection)
  const doc = useEditor((s) => s.doc)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const rootDrop = useLayerDrag((s) => s.drag?.pos === 'root')

  // reveal selected layers
  useEffect(() => {
    if (!selection.length) return
    setExpanded((prev) => {
      const next = new Set(prev)
      let changed = false
      for (const id of selection)
        for (const a of ancestors(getEditor().doc, id))
          if (!next.has(a)) {
            next.add(a)
            changed = true
          }
      return changed ? next : prev
    })
    requestAnimationFrame(() => document.querySelector('.k-layer.is-selected')?.scrollIntoView({ block: 'nearest' }))
  }, [selection])

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const results = useMemo(() => {
    if (!filter.trim()) return null
    const q = filter.toLowerCase()
    return Object.values(doc.nodes).filter((n) => n.pageId === page?.id && (n.name.toLowerCase().includes(q) || n.text?.content.toLowerCase().includes(q)))
  }, [filter, doc, page])

  if (!page) return null
  return (
    <div className="k-layers">
      <div className="k-panel-head">
        <span className="k-panel-title">Layers</span>
        <label className={'k-filter-wrap' + (filter ? ' has-value' : '')}>
          <Search className="k-filter-icon" size={12} strokeWidth={2.25} aria-hidden="true" />
          <input className="k-filter" placeholder="Find…" aria-label="Find layers" value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        </label>
      </div>
      <div className={'k-layer-list' + (rootDrop ? ' is-drop-root' : '')}>
        {results
          ? results.map((n) => (
              <div key={n.id} className={'k-layer' + (selection.includes(n.id) ? ' is-selected' : '')} style={{ paddingLeft: 10 }} onClick={() => getEditor().select([n.id])}>
                <span className="k-layer-icon">
                  <TypeIcon node={n} />
                </span>
                <span className="k-layer-name">{n.name}</span>
              </div>
            ))
          : [...page.children].reverse().map((id) => <LayerRow key={id} id={id} depth={0} expanded={expanded} toggle={toggle} />)}
        {results && !results.length && (
          <div className="k-empty-hint">
            <p>No layers match “{filter}”.</p>
          </div>
        )}
        {!page.children.length && (
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
  const usage = useEditor((s) => {
    const counts: Record<string, number> = {}
    for (const n of Object.values(s.doc.nodes)) {
      for (const f of n.fills) if (f.tokenId) counts[f.tokenId] = (counts[f.tokenId] ?? 0) + 1
      if (n.text?.tokenId) counts[n.text.tokenId] = (counts[n.text.tokenId] ?? 0) + 1
    }
    return JSON.stringify(counts)
  })
  const counts = JSON.parse(usage) as Record<string, number>

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
