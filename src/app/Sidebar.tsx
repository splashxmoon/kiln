import type { ReactNode } from 'react'
import { Clock, FileText, Plus, Trash2 } from 'lucide-react'
import type { FileMeta, ProjectMeta } from '../platform/storage'
import { dropIdForProject, DROP_DRAFTS, type HomeView } from './home-data'

/** The left sidebar: Recent, Drafts, projects (with a + to add one) and Trash. Rows are drop targets for dragged files. */
export function Sidebar({
  view,
  files,
  projects,
  trashCount,
  onNewProject,
}: {
  view: HomeView
  files: FileMeta[] | null
  projects: ProjectMeta[] | null
  trashCount: number | null
  onNewProject: () => void
}) {
  const drafts = files ? files.filter((f) => f.projectId === null).length : null
  const isActive = (v: HomeView) => JSON.stringify(v) === JSON.stringify(view)
  return (
    <nav className="k-home-side" aria-label="Files">
      <SideRow href="#/files" active={isActive({ kind: 'recent' })} icon={<Clock size={14} />} label="Recent" count={files?.length} />
      <SideRow href="#/drafts" active={isActive({ kind: 'drafts' })} icon={<FileText size={14} />} label="Drafts" count={drafts ?? undefined} dropId={DROP_DRAFTS} />

      <div className="k-side-head">
        <span>Projects</span>
        <button className="k-side-add" title="New project" aria-label="New project" onClick={onNewProject}>
          <Plus size={13} />
        </button>
      </div>
      {projects && !projects.length && <div className="k-side-empty">No projects yet</div>}
      {(projects ?? []).map((p) => (
        <SideRow
          key={p.id}
          href={'#/project/' + p.id}
          active={isActive({ kind: 'project', id: p.id })}
          icon={<i className="k-proj-dot-sm" style={{ background: p.color }} />}
          label={p.name}
          count={p.fileCount}
          dropId={dropIdForProject(p.id)}
        />
      ))}

      <div className="k-side-foot">
        <SideRow href="#/trash" active={isActive({ kind: 'trash' })} icon={<Trash2 size={14} />} label="Trash" count={trashCount ?? undefined} />
      </div>
    </nav>
  )
}

function SideRow({
  href,
  active,
  icon,
  label,
  count,
  dropId,
}: {
  href: string
  active: boolean
  icon: ReactNode
  label: string
  count?: number
  dropId?: string
}) {
  return (
    <a href={href} className={'k-side-item' + (active ? ' is-active' : '')} aria-current={active ? 'page' : undefined} data-drop={dropId} title={label}>
      <span className="k-side-icon">{icon}</span>
      <span className="k-side-label">{label}</span>
      {count !== undefined && <span className="k-side-count">{count}</span>}
    </a>
  )
}
