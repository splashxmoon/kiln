import { useState } from 'react'
import { Plus, Search, FolderOpen } from 'lucide-react'
import { storage, type FileMeta, type ProjectMeta } from '../platform/storage'
import { isTauri, isMac, desktopRevealFolder, onWindowDragMouseDown } from '../platform/tauri'
import { fileManagerName } from '../platform/os'
import { WindowControls } from '../platform/WindowControls'
import { KilnLogo } from '../brand/Logo'
import { askText } from '../ui/Dialogs'
import { createFile, errorText, nextColor, toast, useHomeData, type HomeView } from './home-data'
import { FileCard } from './FileCard'
import { Sidebar } from './Sidebar'
import { StartCards } from './StartCards'
import { ProjectView } from './ProjectView'
import { TrashView } from './TrashView'
import { ToastHost } from './Toast'
import '../editor/editor.css'
import './files.css'
import './projects.css'

/** The home screen: a sidebar (Recent, Drafts, projects, Trash) and the view it selects. Search covers every file. */
export function Files({ view, open }: { view: HomeView; open: (id: string) => void }) {
  const { files, projects, trash, refresh } = useHomeData()
  const [q, setQ] = useState('')
  const term = q.trim().toLowerCase()
  const searching = term !== ''
  const allProjects = projects ?? []
  const projectOf = (id: string) => allProjects.find((p) => p.id === id)

  const newFile = async (kind: 'blank' | 'starter' = 'blank') => {
    // inside a project a new file goes into it; everywhere else it goes to Drafts
    const into = view.kind === 'project' ? view.id : null
    try {
      open(await createFile(kind, into))
    } catch (e) {
      toast(`Couldn’t create the file: ${errorText(e)}`)
    }
  }

  const newProject = async () => {
    const name = await askText({ title: 'New project', placeholder: 'Project name', confirmLabel: 'Create' })
    if (!name) return
    try {
      const p = await storage.createProject(name, nextColor(allProjects))
      location.hash = '#/project/' + p.id
    } catch (e) {
      toast(`Couldn’t create the project: ${errorText(e)}`)
    }
    void refresh()
  }

  const listFiles = (list: FileMeta[] | null, keep: (f: FileMeta) => boolean) => (list ?? []).filter(keep)

  return (
    <div className="k-app k-home">
      <header className={'k-files-top' + (isTauri && isMac ? ' is-desktop-mac' : '')} onMouseDown={onWindowDragMouseDown}>
        <a href="#/" className="k-files-logo" aria-label="Kiln home">
          <KilnLogo size={20} />
        </a>
        <div className="k-files-search" data-no-drag>
          <Search size={14} />
          <input placeholder="Search all files" value={q} spellCheck={false} autoComplete="off" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQ('')} />
        </div>
        <div className="k-row" style={{ gap: 8 }}>
          {isTauri && (
            <button className="k-btn-ghost" onClick={() => desktopRevealFolder()}>
              <FolderOpen size={13} /> Show in {fileManagerName}
            </button>
          )}
          <button className="k-btn-primary" onClick={() => void newFile('blank')}>
            <Plus size={14} /> New file
          </button>
          <WindowControls />
        </div>
      </header>

      <div className="k-home-body">
        <Sidebar view={view} files={files} projects={projects} trashCount={trash ? trash.length : null} onNewProject={() => void newProject()} />

        <main className="k-home-main">
          <div className="k-files-main">
            {searching ? (
              <SearchResults
                term={term}
                q={q}
                files={files}
                projects={allProjects}
                open={open}
                changed={() => void refresh()}
                onClear={() => setQ('')}
              />
            ) : view.kind === 'trash' ? (
              <TrashView trash={trash} projects={allProjects} changed={() => void refresh()} />
            ) : view.kind === 'project' ? (
              projects && !projectOf(view.id) ? (
                <div className="k-files-empty">
                  <p>This project no longer exists.</p>
                  <a className="k-btn-ghost" href="#/files">
                    Back to Recent
                  </a>
                </div>
              ) : projects ? (
                <ProjectView
                  key={view.id}
                  project={projectOf(view.id)!}
                  files={listFiles(files, (f) => f.projectId === view.id)}
                  projects={allProjects}
                  open={open}
                  changed={() => void refresh()}
                  gone={() => {
                    location.hash = '#/files'
                    void refresh()
                  }}
                />
              ) : (
                <SkeletonGrid />
              )
            ) : (
              <ListView
                view={view}
                files={files}
                projects={allProjects}
                open={open}
                changed={() => void refresh()}
                make={(kind) => void newFile(kind)}
              />
            )}
          </div>
        </main>
      </div>
      <ToastHost />
    </div>
  )
}

/** Recent and Drafts: the start cards, then the files in that list. */
function ListView({
  view,
  files,
  projects,
  open,
  changed,
  make,
}: {
  view: HomeView
  files: FileMeta[] | null
  projects: ProjectMeta[]
  open: (id: string) => void
  changed: () => void
  make: (kind: 'blank' | 'starter') => void
}) {
  const drafts = view.kind === 'drafts'
  const shown = (files ?? []).filter((f) => !drafts || f.projectId === null)
  return (
    <>
      <StartCards make={make} note={!drafts} />
      <div className="k-files-head">
        <h1>{drafts ? 'Drafts' : 'Recent'}</h1>
        <span className="k-dim">{files ? `${shown.length} file${shown.length === 1 ? '' : 's'}` : ''}</span>
      </div>

      {!files && <SkeletonGrid />}
      {files && !shown.length && (
        <div className="k-files-empty">
          {drafts ? (
            <p>No drafts. Files that aren’t in a project end up here.</p>
          ) : (
            <>
              <p>No files yet.</p>
              <button className="k-btn-primary" onClick={() => make('starter')}>
                Open the starter file
              </button>
            </>
          )}
        </div>
      )}
      <div className="k-files-grid">
        {shown.map((f) => (
          <FileCard key={f.id} f={f} projects={projects} showProject={!drafts} open={open} changed={changed} />
        ))}
      </div>
    </>
  )
}

function SearchResults({
  term,
  q,
  files,
  projects,
  open,
  changed,
  onClear,
}: {
  term: string
  q: string
  files: FileMeta[] | null
  projects: ProjectMeta[]
  open: (id: string) => void
  changed: () => void
  onClear: () => void
}) {
  const hits = (files ?? []).filter((f) => f.name.toLowerCase().includes(term))
  return (
    <>
      <div className="k-files-head">
        <h1>Results</h1>
        <span className="k-dim">
          {files ? `${hits.length} of ${files.length} file${files.length === 1 ? '' : 's'} match “${q.trim()}”` : ''}
        </span>
      </div>
      {files && !hits.length && (
        <div className="k-files-empty">
          <p>No files match “{q.trim()}”.</p>
          <button className="k-btn-ghost" onClick={onClear}>
            Clear search
          </button>
        </div>
      )}
      <div className="k-files-grid">
        {hits.map((f) => (
          <FileCard key={f.id} f={f} projects={projects} showProject open={open} changed={changed} />
        ))}
      </div>
    </>
  )
}

function SkeletonGrid() {
  return (
    <div className="k-files-grid">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="k-file-card is-skeleton" aria-hidden>
          <div className="k-file-thumb" />
          <div className="k-file-meta">
            <div>
              <div className="k-skel-line" style={{ width: '60%' }} />
              <div className="k-skel-line is-dim" style={{ width: '38%' }} />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
