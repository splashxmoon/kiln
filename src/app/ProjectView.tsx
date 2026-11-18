import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MoreHorizontal, Trash2, Palette, Pencil } from 'lucide-react'
import { storage, PROJECT_COLORS, type FileMeta, type ProjectMeta } from '../platform/storage'
import { Popover } from '../ui/Popover'
import { errorText, toast, createFile } from './home-data'
import { FileCard } from './FileCard'
import { StartCards } from './StartCards'

/** One project: header (name, colour, menu, tabs), start cards, and its files. */
export function ProjectView({
  project,
  files,
  projects,
  open,
  changed,
  gone,
}: {
  project: ProjectMeta
  files: FileMeta[]
  projects: ProjectMeta[]
  open: (id: string) => void
  changed: () => void
  /** The project was deleted: leave this view. */
  gone: () => void
}) {
  const make = async (kind: 'blank' | 'starter') => {
    try {
      open(await createFile(kind, project.id))
    } catch (e) {
      toast(`Couldn’t create the file: ${errorText(e)}`)
    }
  }
  return (
    <>
      <ProjectHeader project={project} count={files.length} changed={changed} gone={gone} />
      <StartCards make={make} />
      {!files.length ? (
        <div className="k-files-empty k-project-empty">
          <span className="k-project-empty-dot" style={{ background: project.color }} />
          <p>
            <b>{project.name}</b> is empty.
          </p>
          <p className="k-dim">Start a file here, or drag files onto this project in the sidebar. Any file’s ··· menu also has Move to…</p>
          <button className="k-btn-primary" onClick={() => make('blank')}>
            New file
          </button>
        </div>
      ) : (
        <div className="k-files-grid">
          {files.map((f) => (
            <FileCard key={f.id} f={f} projects={projects} showProject={false} open={open} changed={changed} />
          ))}
        </div>
      )}
    </>
  )
}

function ProjectHeader({ project, count, changed, gone }: { project: ProjectMeta; count: number; changed: () => void; gone: () => void }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(project.name)
  const [menu, setMenu] = useState(false)
  const [colours, setColours] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const menuBtn = useRef<HTMLButtonElement>(null)
  const dot = useRef<HTMLButtonElement>(null)
  const cancelled = useRef(false)

  const patch = async (p: { name?: string; color?: string }) => {
    try {
      await storage.updateProject(project.id, p)
      changed()
    } catch (e) {
      toast(`Couldn’t update the project: ${errorText(e)}`)
    }
  }

  // Enter and Escape both end the edit by blurring the field, so this always runs and the
  // cancel flag never outlives the edit that set it.
  const commitName = () => {
    const skip = cancelled.current
    cancelled.current = false
    setEditing(false)
    const v = name.trim()
    if (!skip && v && v !== project.name) void patch({ name: v })
    else setName(project.name)
  }

  return (
    <>
      <div className="k-proj-head">
        <button ref={dot} className="k-proj-dot" style={{ background: project.color }} aria-label="Change colour" title="Change colour" onClick={() => setColours(!colours)} />
        {editing ? (
          <input
            className="k-proj-name-input"
            value={name}
            autoFocus
            aria-label="Project name"
            spellCheck={false}
            autoComplete="off"
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') {
                cancelled.current = true
                e.currentTarget.blur()
              }
            }}
            onBlur={commitName}
          />
        ) : (
          <h1 className="k-proj-title">
            <button
              className="k-proj-name"
              title="Rename project"
              aria-label={`Rename project ${project.name}`}
              onClick={() => {
                setName(project.name)
                setEditing(true)
              }}
            >
              {project.name}
              <Pencil size={13} className="k-proj-name-edit" aria-hidden />
            </button>
          </h1>
        )}
        <span className="k-dim k-proj-count">{count === 1 ? '1 file' : `${count} files`}</span>
        <div className="k-proj-spacer" />
        <button ref={menuBtn} className={'k-icon-btn' + (menu ? ' is-on' : '')} aria-label="Project options" title="Project options" onClick={() => setMenu(!menu)}>
          <MoreHorizontal size={16} />
        </button>
      </div>

      <div className="k-proj-tabs" role="tablist">
        <button role="tab" aria-selected className="k-proj-tab is-active">
          Files
        </button>
        <button role="tab" aria-selected={false} className="k-proj-tab" disabled title="The project board is coming in a later update">
          Board <span className="k-proj-soon">· soon</span>
        </button>
      </div>

      <Popover anchor={dot.current} open={colours} onClose={() => setColours(false)} placement="bottom-start" className="k-proj-colour-pop">
        <ColourSwatches
          current={project.color}
          onPick={(c) => {
            setColours(false)
            if (c !== project.color) void patch({ color: c })
          }}
        />
      </Popover>

      <Popover anchor={menuBtn.current} open={menu} onClose={() => setMenu(false)} placement="bottom-end" className="k-menu k-file-menu">
        <div>
          <button
            onClick={() => {
              setMenu(false)
              setName(project.name)
              setEditing(true)
            }}
          >
            Rename
          </button>
          <button
            onClick={() => {
              setMenu(false)
              setColours(true)
            }}
          >
            <span>Change colour</span>
            <Palette size={14} />
          </button>
          <div className="k-menu-sep" />
          <button
            className="is-danger"
            onClick={() => {
              setMenu(false)
              setDeleting(true)
            }}
          >
            <span>Delete project</span>
            <Trash2 size={14} />
          </button>
        </div>
      </Popover>

      {deleting && <DeleteProjectDialog project={project} count={count} onCancel={() => setDeleting(false)} onDone={() => { setDeleting(false); gone() }} />}
    </>
  )
}

function ColourSwatches({ current, onPick }: { current: string; onPick: (c: string) => void }) {
  return (
    <div className="k-proj-swatches" role="radiogroup" aria-label="Project colour">
      {PROJECT_COLORS.map((c) => (
        <button
          key={c}
          role="radio"
          aria-checked={c === current}
          aria-label={c}
          title={c}
          className={'k-proj-swatch' + (c === current ? ' is-on' : '')}
          style={{ background: c }}
          onClick={() => onPick(c)}
        />
      ))}
    </div>
  )
}

/** Deleting a project: its files either go to Drafts or to the trash with it. */
function DeleteProjectDialog({ project, count, onCancel, onDone }: { project: ProjectMeta; count: number; onCancel: () => void; onDone: () => void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        e.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [onCancel])

  const run = async (mode: 'keep-files' | 'trash-files') => {
    try {
      await storage.removeProject(project.id, mode)
      toast(mode === 'keep-files' ? `Deleted “${project.name}”. Its files are in Drafts` : `Deleted “${project.name}” and its files`)
      onDone()
    } catch (e) {
      toast(`Couldn’t delete “${project.name}”: ${errorText(e)}`)
      onCancel()
    }
  }

  return createPortal(
    <div className="k-dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="k-dialog k-proj-delete-dialog" role="dialog" aria-modal="true" aria-label={`Delete ${project.name}`}>
        <h2>Delete “{project.name}”?</h2>
        <div className="k-dialog-body">
          {count === 0 ? 'This project is empty.' : count === 1 ? 'It has 1 file. Choose what happens to it.' : `It has ${count} files. Choose what happens to them.`}
        </div>
        <div className="k-dialog-actions">
          <button type="button" className="k-btn-ghost" onClick={onCancel} autoFocus>
            Cancel
          </button>
          <button type="button" className="k-btn-ghost" onClick={() => void run('keep-files')}>
            Keep files (move to Drafts)
          </button>
          <button type="button" className="k-btn-danger" onClick={() => void run('trash-files')}>
            Delete files too
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
