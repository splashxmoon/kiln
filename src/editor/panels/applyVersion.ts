/**
 * Restore's last step (VersionsDialog.tsx), apart from the dialog so it can be tested: a version's
 * content goes into the open document as one undo step.
 */
import { produce, type Draft } from 'immer'
import { getEditor } from '../store'
import type { KDoc } from '../types'

/** Editor.tsx listens for it and drops its file-card snapshot of the canvas that was replaced. */
export const RESTORED_EVENT = 'kiln:version-restored'

/**
 * Puts a version's content into the open document as one undo step. The file keeps its id and
 * name; pages, layers, tokens and comments come from the version, exactly as they were kept.
 * (Not through update(): that syncs component instances against the current mains, which would
 * change the restored instances.) `thumbnail` is the version's own, shown on the file card until
 * a fresh snapshot of the restored canvas replaces it.
 */
export function applyVersion(v: KDoc, thumbnail?: string) {
  const s = getEditor()
  const next = produce(s.doc, (d: Draft<KDoc>) => {
    d.pages = v.pages as Draft<KDoc>['pages']
    d.nodes = v.nodes as Draft<KDoc>['nodes']
    d.tokens = v.tokens as Draft<KDoc>['tokens']
    d.comments = v.comments as Draft<KDoc>['comments']
  })
  if (next === s.doc) return
  s.checkpoint() // the undo step: the document as it is now
  const pageId = next.pages.some((p) => p.id === s.pageId) ? s.pageId : next.pages[0]?.id
  // later than the last save even with the clock set back: storage drops a save older than the
  // one on disk, so the restore would show as saved without ever being written
  const updatedAt = Math.max(Date.now(), s.doc.updatedAt + 1)
  const doc = { ...next, updatedAt, thumbnail: thumbnail ?? next.thumbnail }
  s.set({ doc, saveState: 'unsaved', pageId, selection: [], hoverId: null, editingTextId: null })
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(RESTORED_EVENT, { detail: doc.id }))
}
