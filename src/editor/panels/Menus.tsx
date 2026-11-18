import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { useEditor, getEditor } from '../store'
import { COMMANDS, runCommand } from '../commands'
import { shortcut } from '../../platform/keys'

/* ------------------------------------------------------------------ palette */

function score(q: string, label: string) {
  const a = label.toLowerCase()
  const b = q.toLowerCase().trim()
  if (!b) return 1
  if (a.startsWith(b)) return 3
  if (a.includes(b)) return 2
  // subsequence
  let i = 0
  for (const ch of a) if (ch === b[i]) i++
  return i === b.length ? 1 : 0
}

export function CommandPalette() {
  const open = useEditor((s) => s.paletteOpen)
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const results = useMemo(
    () =>
      COMMANDS.filter((c) => !c.enabled || c.enabled())
        .map((c) => ({ c, s: Math.max(score(q, c.label), score(q, c.group + ' ' + c.label) - 1) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 40)
        .map((x) => x.c),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [q, open],
  )
  useEffect(() => {
    if (open) {
      setQ('')
      setIdx(0)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open])
  if (!open) return null
  const close = () => getEditor().set({ paletteOpen: false })
  const exec = (id: string) => {
    close()
    runCommand(id)
  }
  return (
    <div className="k-modal-backdrop" onPointerDown={close}>
      <div className="k-palette" onPointerDown={(e) => e.stopPropagation()} role="dialog" aria-label="Command palette">
        <div className="k-palette-input">
          <Search size={16} />
          <input
            ref={inputRef}
            value={q}
            placeholder="Search commands, insert components…"
            onChange={(e) => {
              setQ(e.target.value)
              setIdx(0)
            }}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Escape') close()
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setIdx((i) => Math.min(results.length - 1, i + 1))
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setIdx((i) => Math.max(0, i - 1))
              }
              if (e.key === 'Enter' && results[idx]) exec(results[idx].id)
            }}
          />
        </div>
        <div className="k-palette-list">
          {results.map((c, i) => (
            <button key={c.id} className={i === idx ? 'is-on' : ''} onMouseEnter={() => setIdx(i)} onClick={() => exec(c.id)}>
              <span className="k-dim k-palette-group">{c.group}</span>
              <span>{c.label}</span>
              {c.checked && <span className={'k-palette-state' + (c.checked() ? ' is-on' : '')}>{c.checked() ? 'On' : 'Off'}</span>}
              {c.keys && <kbd>{c.keys}</kbd>}
            </button>
          ))}
          {!results.length && <div className="k-empty-hint">No matching commands.</div>}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ context menu */

const CTX: (string | '-')[] = [
  'edit.copy',
  'edit.cut',
  'edit.duplicate',
  'edit.delete',
  '-',
  'layout.wrapFlex',
  'layout.wrap',
  'layout.unwrap',
  'layout.flex',
  '-',
  'order.front',
  'order.forward',
  'order.backward',
  'order.back',
  '-',
  'layer.hide',
  'layer.lock',
  'edit.rename',
  '-',
  'view.sel',
  'view.code',
  'export.png',
]

export function ContextMenu() {
  const menu = useEditor((s) => s.contextMenu)
  const hasSel = useEditor((s) => s.selection.length > 0)
  if (!menu) return null
  const items = hasSel ? CTX : ['view.fit', 'edit.selectAll', '-', 'page.add', 'insert.desktop', 'insert.mobile']
  return (
    <div className="k-modal-backdrop is-clear" onPointerDown={() => getEditor().set({ contextMenu: null })} onContextMenu={(e) => e.preventDefault()}>
      <div
        className="k-menu k-ctx"
        ref={(el) => {
          if (!el) return
          // place after measuring so the menu never runs off-screen
          const r = el.getBoundingClientRect()
          const m = 8
          el.style.left = Math.max(m, Math.min(menu.x, window.innerWidth - r.width - m)) + 'px'
          el.style.top = Math.max(m, menu.y + r.height > window.innerHeight - m ? menu.y - r.height : menu.y) + 'px'
          el.style.visibility = 'visible'
        }}
        style={{ left: menu.x, top: menu.y, visibility: 'hidden' }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {items.map((id, i) => {
          if (id === '-') return <div key={i} className="k-menu-sep" />
          const c = COMMANDS.find((c) => c.id === id)
          if (!c) return null
          const enabled = !c.enabled || c.enabled()
          return (
            <button
              key={id}
              disabled={!enabled}
              onClick={() => {
                getEditor().set({ contextMenu: null })
                runCommand(id)
              }}
            >
              <span className="k-menu-label">{c.label}</span>
              {c.keys && <kbd>{c.keys}</kbd>}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ shortcuts */

export function ShortcutsSheet() {
  const open = useEditor((s) => s.shortcutsOpen)
  if (!open) return null
  const groups: Record<string, typeof COMMANDS> = {}
  for (const c of COMMANDS) if (c.keys) (groups[c.group] ??= []).push(c)
  // ⌘ ⌥ ⇧ on the Mac, Ctrl Alt Shift elsewhere
  const [mod, alt, shift] = [shortcut('⌘'), shortcut('⌥'), shortcut('⇧')]
  const extra = [
    ['Pan', 'Space + drag · scroll'],
    ['Zoom', `${mod} + scroll · pinch · + −`],
    ['Deep select', `${mod} + click`],
    ['Enter frame', 'Double-click'],
    ['Duplicate while dragging', `${alt} + drag`],
    ['Reparent into frame', `drag onto it (${mod} for artboards)`],
    ['Resize from centre', `${alt} + drag handle`],
    ['Nudge', `← → ↑ ↓ (${shift} ×10)`],
  ]
  return (
    <div className="k-modal-backdrop" onPointerDown={() => getEditor().set({ shortcutsOpen: false })}>
      <div className="k-shortcuts" onPointerDown={(e) => e.stopPropagation()} role="dialog" aria-label="Keyboard shortcuts">
        <div className="k-shortcuts-head">
          <b>Keyboard shortcuts</b>
          <button className="k-icon-btn" title="Close" onClick={() => getEditor().set({ shortcutsOpen: false })}>
            <X size={14} />
          </button>
        </div>
        <div className="k-shortcuts-grid">
          {Object.entries(groups).map(([g, cs]) => (
            <div key={g}>
              <div className="k-sheet-title">{g}</div>
              {cs.map((c) => (
                <div key={c.id} className="k-kv">
                  <span>{c.label}</span>
                  <kbd>{c.keys}</kbd>
                </div>
              ))}
            </div>
          ))}
          <div>
            <div className="k-sheet-title">Canvas</div>
            {extra.map(([a, b]) => (
              <div key={a} className="k-kv">
                <span>{a}</span>
                <kbd>{b}</kbd>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

export function Toast() {
  const toast = useEditor((s) => s.toast)
  if (!toast) return null
  return (
    <div className="k-toast" role="status" key={toast.id}>
      {toast.text}
    </div>
  )
}
