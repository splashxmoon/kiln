/**
 * Data and helpers for the home screen: loads files, projects and the trash through
 * the storage interface, creates files, and holds the toast messages.
 */
import { useCallback, useEffect, useState } from 'react'
import { storage, PROJECT_COLORS, StorageBlockedError, type FileMeta, type ProjectMeta, type TrashItem } from '../platform/storage'
import { starterDoc, blankDoc } from '../editor/template'

/** What the main area shows: a sidebar item or a project. */
export type HomeView = { kind: 'recent' } | { kind: 'drafts' } | { kind: 'trash' } | { kind: 'project'; id: string }

/** Drop targets on the sidebar: `drafts` or `project:<id>`. */
export const DROP_DRAFTS = 'drafts'
export const dropIdForProject = (id: string) => 'project:' + id

/** The project a drop target means: null for Drafts, the project id otherwise. */
export function dropTarget(dropId: string): string | null {
  return dropId === DROP_DRAFTS ? null : dropId.slice('project:'.length)
}

export function ago(t: number) {
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 60) return 'Edited just now'
  if (s < 3600) return `Edited ${Math.round(s / 60)} min ago`
  if (s < 86400) return `Edited ${Math.round(s / 3600)} h ago`
  return `Edited ${new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}

export function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e)
}

/** The first colour no project uses yet; once all are in use, the colours repeat in order. */
export function nextColor(projects: ProjectMeta[]): string {
  const used = new Set(projects.map((p) => p.color))
  return PROJECT_COLORS.find((c) => !used.has(c)) ?? PROJECT_COLORS[projects.length % PROJECT_COLORS.length]
}

/** Creates a blank or starter file, in a project or in Drafts, and returns its id. */
export async function createFile(kind: 'blank' | 'starter', projectId: string | null = null) {
  const doc = kind === 'starter' ? starterDoc() : blankDoc()
  await storage.save(doc, { projectId })
  return doc.id
}

// ---- toasts ----------------------------------------------------------------

type ToastListener = (text: string) => void
let toastListener: ToastListener | null = null

/** Shows a short message at the bottom of the home screen (see ToastHost). */
export function toast(text: string) {
  toastListener?.(text)
}

export function subscribeToast(fn: ToastListener): () => void {
  toastListener = fn
  return () => {
    if (toastListener === fn) toastListener = null
  }
}

// ---- data ------------------------------------------------------------------

export interface HomeData {
  files: FileMeta[] | null
  projects: ProjectMeta[] | null
  trash: TrashItem[] | null
  refresh: () => Promise<void>
}

/** A read that may not be available yet: logs and returns the fallback instead of failing the screen. */
function soft<T>(p: Promise<T>, fallback: T, what: string): Promise<T> {
  return p.catch((e: unknown) => {
    console.warn(`[kiln] ${what} failed:`, e)
    // another Kiln tab holds the old storage open: say so instead of showing an empty library
    if (e instanceof StorageBlockedError) toast(e.message)
    return fallback
  })
}

export function useHomeData(): HomeData {
  const [data, setData] = useState<Omit<HomeData, 'refresh'>>({ files: null, projects: null, trash: null })
  const refresh = useCallback(async () => {
    const [files, projects, trash] = await Promise.all([
      soft(storage.list(), [] as FileMeta[], 'list files'),
      soft(storage.listProjects(), [] as ProjectMeta[], 'list projects'),
      soft(storage.listTrash(), [] as TrashItem[], 'list trash'),
    ])
    setData({ files, projects, trash })
  }, [])
  useEffect(() => {
    void refresh()
  }, [refresh])
  return { ...data, refresh }
}
