import { useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { MoreHorizontal, Trash2, Check } from 'lucide-react'
import { storage, type FileMeta, type ProjectMeta } from '../platform/storage'
import { Popover } from '../ui/Popover'
import { askConfirm, askText } from '../ui/Dialogs'
import { ago, dropTarget, errorText, toast } from './home-data'
import { startCardDrag, justDragged } from './drag'

/** A file card. Drag it onto a sidebar project or Drafts, or pick a destination under "Move to…". */
export function FileCard({
  f,
  projects,
  showProject,
  draggable = true,
  open,
  changed,
}: {
  f: FileMeta
  projects: ProjectMeta[]
  /** Show which project the file is in (Recent and search results). */
  showProject: boolean
  draggable?: boolean
  open: (id: string) => void
  /** Reload the lists after a change. */
  changed: () => void
}) {
  const [menu, setMenu] = useState(false)
  const [moving, setMoving] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const projectName = (id: string | null) => (id === null ? 'Drafts' : (projects.find((p) => p.id === id)?.name ?? 'Deleted project'))
  const projectColor = f.projectId ? projects.find((p) => p.id === f.projectId)?.color : undefined

  const move = async (target: string | null) => {
    if (target === f.projectId) return
    try {
      await storage.moveFile(f.id, target)
      toast(`Moved “${f.name}” to ${projectName(target)}`)
    } catch (e) {
      toast(`Couldn’t move “${f.name}”: ${errorText(e)}`)
    }
    changed()
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (draggable) startCardDrag(e, f.name, (dropId) => void move(dropTarget(dropId)))
  }

  const act = (fn: () => Promise<void> | void) => async () => {
    setMenu(false)
    await fn()
  }

  return (
    <div
      className={'k-file-card' + (menu ? ' is-menu-open' : '')}
      onClick={() => {
        if (!justDragged()) open(f.id)
      }}
      onPointerDown={onPointerDown}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && open(f.id)}
      onContextMenu={(e) => {
        e.preventDefault()
        setMenu(true)
      }}
    >
      <div className="k-file-thumb">{f.thumbnail ? <img src={f.thumbnail} alt="" draggable={false} /> : <span className="k-file-thumb-empty" />}</div>
      <div className="k-file-meta">
        <div>
          <div className="k-file-title">{f.name}</div>
          {showProject && (
            <div className="k-file-project">
              <i style={{ background: projectColor ?? 'var(--k-faint)' }} />
              {projectName(f.projectId)}
            </div>
          )}
          <div className="k-dim">{ago(f.updatedAt)}</div>
        </div>
        <button
          ref={btn}
          className={'k-icon-btn' + (menu || moving ? ' is-on' : '')}
          aria-label="File options"
          title="File options"
          onClick={(e) => {
            e.stopPropagation()
            setMenu(!menu)
          }}
        >
          <MoreHorizontal size={16} />
        </button>
        <Popover anchor={btn.current} open={menu} onClose={() => setMenu(false)} placement="bottom-end" className="k-menu k-file-menu">
          <div onClick={(e) => e.stopPropagation()}>
            <button onClick={act(() => open(f.id))}>Open</button>
            <button
              onClick={act(async () => {
                const name = await askText({ title: 'Rename file', value: f.name, confirmLabel: 'Rename' })
                const doc = name ? await storage.load(f.id) : null
                if (doc && name) {
                  await storage.save({ ...doc, name, updatedAt: Date.now() })
                  changed()
                }
              })}
            >
              Rename
            </button>
            <button
              onClick={act(async () => {
                const doc = await storage.load(f.id)
                if (!doc) return
                const copy = JSON.parse(JSON.stringify(doc))
                copy.id = Math.random().toString(36).slice(2, 14)
                copy.name = doc.name + ' copy'
                copy.updatedAt = Date.now()
                await storage.save(copy, { projectId: f.projectId })
                changed()
              })}
            >
              Duplicate
            </button>
            <button
              onClick={() => {
                setMenu(false)
                setMoving(true)
              }}
            >
              Move to…
            </button>
            <div className="k-menu-sep" />
            <button
              className="is-danger"
              onClick={act(async () => {
                const ok = await askConfirm({
                  title: `Move “${f.name}” to Trash?`,
                  body: 'You can restore it from Trash until you empty it.',
                  confirmLabel: 'Move to Trash',
                  danger: true,
                })
                if (!ok) return
                try {
                  await storage.remove(f.id)
                  toast(`Moved “${f.name}” to Trash`)
                } catch (e) {
                  toast(`Couldn’t move “${f.name}” to Trash: ${errorText(e)}`)
                }
                changed()
              })}
            >
              <span>Move to Trash</span>
              <Trash2 size={14} />
            </button>
          </div>
        </Popover>
        <Popover anchor={btn.current} open={moving} onClose={() => setMoving(false)} placement="bottom-end" className="k-menu k-file-menu k-home-move-menu">
          <div onClick={(e) => e.stopPropagation()}>
            <div className="k-home-menu-heading">Move to</div>
            <MoveItem label="Drafts" color={undefined} current={f.projectId === null} onPick={() => void move(null)} close={() => setMoving(false)} />
            {projects.map((p) => (
              <MoveItem key={p.id} label={p.name} color={p.color} current={f.projectId === p.id} onPick={() => void move(p.id)} close={() => setMoving(false)} />
            ))}
            {!projects.length && <div className="k-home-menu-hint">No projects yet. Create one with + in the sidebar.</div>}
          </div>
        </Popover>
      </div>
    </div>
  )
}

function MoveItem({ label, color, current, onPick, close }: { label: string; color: string | undefined; current: boolean; onPick: () => void; close: () => void }) {
  return (
    <button
      aria-checked={current}
      role="menuitemradio"
      className={current ? 'is-current' : undefined}
      onClick={() => {
        close()
        if (!current) onPick()
      }}
    >
      <span className="k-home-menu-item">
        <i className="k-proj-dot-sm" style={{ background: color ?? 'var(--k-faint)' }} />
        {label}
      </span>
      {current && <Check size={13} />}
    </button>
  )
}
