import { RotateCcw, Trash2 } from 'lucide-react'
import { storage, type ProjectMeta, type TrashItem } from '../platform/storage'
import { askConfirm } from '../ui/Dialogs'
import { ago, errorText, toast } from './home-data'

/** Deleted files until they are restored or purged. */
export function TrashView({ trash, projects, changed }: { trash: TrashItem[] | null; projects: ProjectMeta[]; changed: () => void }) {
  const where = (id: string | null) => (id === null ? 'Drafts' : (projects.find((p) => p.id === id)?.name ?? 'Drafts'))

  const restore = async (t: TrashItem) => {
    try {
      await storage.restore(t.trashId)
      toast(`Restored “${t.name}” to ${where(t.projectId)}`)
    } catch (e) {
      toast(`Couldn’t restore “${t.name}”: ${errorText(e)}`)
    }
    changed()
  }

  const purge = async (t: TrashItem) => {
    const ok = await askConfirm({ title: `Delete “${t.name}” forever?`, body: 'This can’t be undone.', confirmLabel: 'Delete forever', danger: true })
    if (!ok) return
    try {
      await storage.purge(t.trashId)
      toast(`Deleted “${t.name}” forever`)
    } catch (e) {
      toast(`Couldn’t delete “${t.name}”: ${errorText(e)}`)
    }
    changed()
  }

  const emptyAll = async () => {
    const ok = await askConfirm({
      title: 'Empty trash?',
      body: `${trash?.length ?? 0} file${trash?.length === 1 ? '' : 's'} will be deleted forever. This can’t be undone.`,
      confirmLabel: 'Empty trash',
      danger: true,
    })
    if (!ok) return
    try {
      await storage.purge()
      toast('Trash emptied')
    } catch (e) {
      toast(`Couldn’t empty the trash: ${errorText(e)}`)
    }
    changed()
  }

  return (
    <>
      <div className="k-files-head">
        <h1>Trash</h1>
        <span className="k-dim">{trash ? `${trash.length} file${trash.length === 1 ? '' : 's'}` : ''}</span>
        <div className="k-files-head-spacer" />
        <button className="k-btn-ghost" disabled={!trash?.length} onClick={emptyAll}>
          <Trash2 size={13} /> Empty trash
        </button>
      </div>

      {trash && !trash.length && (
        <div className="k-files-empty">
          <p>Trash is empty.</p>
          <p className="k-dim">Files you move to Trash wait here until you restore them or delete them for good.</p>
        </div>
      )}

      <div className="k-files-grid">
        {(trash ?? []).map((t) => (
          <div key={t.trashId} className="k-file-card k-trash-card">
            <div className="k-file-thumb is-dim">{t.thumbnail ? <img src={t.thumbnail} alt="" draggable={false} /> : <span className="k-file-thumb-empty" />}</div>
            <div className="k-file-meta">
              <div>
                <div className="k-file-title">{t.name}</div>
                <div className="k-file-project">
                  <i style={{ background: t.projectId ? (projects.find((p) => p.id === t.projectId)?.color ?? 'var(--k-faint)') : 'var(--k-faint)' }} />
                  {where(t.projectId)}
                </div>
                <div className="k-dim">Deleted {ago(t.deletedAt).replace(/^Edited /, '')}</div>
              </div>
            </div>
            <div className="k-trash-actions">
              <button className="k-btn-ghost" onClick={() => void restore(t)}>
                <RotateCcw size={13} /> Restore
              </button>
              <button className="k-btn-ghost k-trash-forever" title="Delete forever" aria-label={`Delete ${t.name} forever`} onClick={() => void purge(t)}>
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
