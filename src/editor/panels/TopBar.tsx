import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, Minus, Plus, Play, Keyboard, Command, Check, Search, Undo2, Redo2 } from 'lucide-react'
import { useEditor, getEditor } from '../store'
import { KilnMark } from '../../brand/Logo'
import { zoomBy } from '../Canvas'
import { COMMANDS } from '../commands'
import { exportNode, shaderRuntimeReady } from '../../codegen'
import { Popover } from '../../ui/Popover'
import { AgentIsland } from './AgentIsland'
import { isTauri, isMac, onWindowDragMouseDown } from '../../platform/tauri'
import { WindowControls } from '../../platform/WindowControls'
import { shortcut } from '../../platform/keys'

export function TopBar({ onBack }: { onBack: () => void }) {
  const name = useEditor((s) => s.doc.name)
  const zoom = useEditor((s) => s.camera.zoom)
  const saveState = useEditor((s) => s.saveState)
  const pageName = useEditor((s) => s.doc.pages.find((p) => p.id === s.pageId)?.name)
  const [zoomOpen, setZoomOpen] = useState(false)
  const zoomBtn = useRef<HTMLButtonElement>(null)

  const preview = async () => {
    const s = getEditor()
    const page = s.doc.pages.find((p) => p.id === s.pageId)
    const id = s.selection[0] ?? page?.children[0]
    if (!id) return s.notify('Nothing to preview yet')
    let top = id
    while (s.doc.nodes[top]?.parentId) top = s.doc.nodes[top].parentId!
    try {
      // shader layers need the standalone runtime; wait for it so they export working
      await shaderRuntimeReady
      const res = exportNode(s.doc, top, 'html')
      const html = res.files.find((f) => f.path.endsWith('.html'))?.contents ?? ''
      const css = res.files.find((f) => f.path.endsWith('.css'))?.contents ?? ''
      const inlined = html.replace(/<link rel="stylesheet" href="styles\.css"\s*\/?>/, `<style>${css}</style>`)
      const title = s.doc.nodes[top]?.name || s.doc.name || 'Preview'
      getEditor().set({ preview: { title, html: inlined } })
    } catch (err) {
      console.error('Preview failed', err)
      getEditor().notify('Preview failed: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  return (
    <header className={'k-topbar' + (isTauri && isMac ? ' is-desktop-mac' : '')} onMouseDown={onWindowDragMouseDown}>
      <div className="k-topbar-left">
        <button className="k-brand-btn" onClick={onBack} title="All files">
          <ChevronLeft size={14} />
          <KilnMark size={18} />
        </button>
        <span className="k-topbar-sep" />
        <FileName name={name} />
        <span className="k-crumb">{pageName}</span>
        <span className={'k-save k-save-' + saveState}>{saveState === 'saved' ? (isTauri ? 'Saved to disk' : 'Saved') : saveState === 'saving' ? 'Saving…' : 'Edited'}</span>
      </div>
      <div className="k-topbar-center">
        <AgentIsland />
      </div>
      <div className="k-topbar-right">
        <HistoryButtons />
        <span className="k-topbar-sep" />
        <button className="k-icon-btn" title={`Command palette (${shortcut('⌘K')})`} onClick={() => getEditor().set({ paletteOpen: true })}>
          {/* ⌘ is a Mac key: elsewhere the palette gets a neutral search icon */}
          {isMac ? <Command size={14} /> : <Search size={14} />}
        </button>
        <button className="k-icon-btn" title="Keyboard shortcuts (?)" onClick={() => getEditor().set({ shortcutsOpen: true })}>
          <Keyboard size={14} />
        </button>
        <span className="k-topbar-sep" />
        <div className="k-zoom">
          <button className="k-icon-btn" onClick={() => zoomBy(1 / 1.25)} title="Zoom out (−)">
            <Minus size={14} />
          </button>
          <button ref={zoomBtn} className={'k-zoom-val' + (zoomOpen ? ' is-on' : '')} onClick={() => setZoomOpen(!zoomOpen)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowDown') return
              e.preventDefault()
              e.stopPropagation()
              setZoomOpen(true)
              requestAnimationFrame(() => document.querySelector<HTMLElement>('.k-zoom-menu button:not(:disabled)')?.focus())
            }}
            title="Zoom and view options"
            aria-haspopup="menu"
            aria-expanded={zoomOpen}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button className="k-icon-btn" onClick={() => zoomBy(1.25)} title="Zoom in (+)">
            <Plus size={14} />
          </button>
        </div>
        <ZoomMenu anchor={zoomBtn.current} open={zoomOpen} onClose={() => setZoomOpen(false)} />
        <button className="k-btn-primary k-preview-btn" onClick={preview} title="Open the artboard as a real web page">
          <Play size={11} fill="currentColor" strokeWidth={0} /> Preview
        </button>
        <WindowControls />
      </div>
    </header>
  )
}

/** Undo / redo, greyed out when there's nothing to step back or forward to. */
function HistoryButtons() {
  const canUndo = useEditor((s) => s.history.past.length > 0)
  const canRedo = useEditor((s) => s.history.future.length > 0)
  return (
    <div className="k-history" role="group" aria-label="History">
      <button className="k-icon-btn" title={`Undo (${shortcut('⌘Z')})`} aria-label="Undo" disabled={!canUndo} onClick={() => getEditor().undo()}>
        <Undo2 size={14} />
      </button>
      <button className="k-icon-btn" title={`Redo (${shortcut('⇧⌘Z')})`} aria-label="Redo" disabled={!canRedo} onClick={() => getEditor().redo()}>
        <Redo2 size={14} />
      </button>
    </div>
  )
}

/** File name that edits in place and sizes itself to its text. */
function FileName({ name }: { name: string }) {
  const [value, setValue] = useState(name)
  const cancelled = useRef(false)
  useEffect(() => setValue(name), [name])
  return (
    <span className="k-file-name-wrap" data-value={value || ' '}>
      <input
        className="k-file-name"
        value={value}
        aria-label="File name"
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setValue(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            cancelled.current = true
            setValue(name)
            e.currentTarget.blur()
          }
        }}
        onBlur={() => {
          if (cancelled.current) {
            cancelled.current = false
            return
          }
          const v = value.trim()
          if (v && v !== name) getEditor().update((d) => void (d.name = v))
          else setValue(name)
        }}
      />
    </span>
  )
}

/** Zoom actions, then canvas behaviour and display toggles (all are commands, so ⌘K finds them too). */
const ZOOM_MENU: (string | null)[] = [
  'view.in',
  'view.out',
  'view.100',
  'view.fit',
  'view.sel',
  null,
  'view.zoomCenters',
  'view.numberKeys',
  'view.invertZoom',
  'view.wheelZoom',
  'view.rightPan',
  null,
  'view.pixelGrid',
  'view.snapPixel',
  'view.layoutGuides',
  'view.presence',
  'view.deepSelect',
  null,
  'view.comments',
]

function ZoomMenu({ anchor, open, onClose }: { anchor: HTMLElement | null; open: boolean; onClose: () => void }) {
  // re-render when toggles or the selection change
  useEditor((s) => s.view)
  useEditor((s) => s.selection.length)
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') return // the popover closes itself
    e.stopPropagation() // keep arrows / Enter away from the canvas shortcuts
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
    e.preventDefault()
    const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[e.key === 'ArrowUp' && i < 0 ? items.length - 1 : next]?.focus()
  }
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} placement="bottom-end" className="k-menu k-zoom-menu" role="menu" label="Zoom and view options">
      <div onKeyDown={onKeyDown}>
        {ZOOM_MENU.map((id, i) => {
          if (!id) return <div key={'sep' + i} className="k-menu-sep" />
          const c = COMMANDS.find((c) => c.id === id)
          if (!c) return null
          const toggle = !!c.checked
          const on = c.checked?.() ?? false
          return (
            <button
              key={id}
              role={toggle ? 'menuitemcheckbox' : 'menuitem'}
              aria-checked={toggle ? on : undefined}
              disabled={c.enabled ? !c.enabled() : false}
              onClick={() => {
                c.run()
                // toggles keep the menu open so several can be set in one go
                if (!toggle) onClose()
              }}
            >
              <span className="k-menu-check">{on && <Check size={12} strokeWidth={2.25} />}</span>
              <span className="k-menu-label">{c.label}</span>
              {c.keys && <kbd>{c.keys}</kbd>}
            </button>
          )
        })}
      </div>
    </Popover>
  )
}
