/**
 * Unified document storage.
 * - desktop: `<Documents>/Kiln/` via Tauri commands. Drafts are `<id>.kiln` at the top level;
 *   a project is a subfolder with a `project.json`; deleted files go to `.trash/`.
 * - browser: IndexedDB (db `kiln`: stores `files`, `projects`, `trash`), falling back to localStorage
 */
import { nanoid } from 'nanoid'
import type { KDoc } from '../editor/types'
import {
  desktopCreateProject,
  desktopDeleteFile,
  desktopListFiles,
  desktopListProjects,
  desktopListTrash,
  desktopLoadFile,
  desktopMoveFile,
  desktopPurgeTrash,
  desktopRemoveProject,
  desktopRestoreTrash,
  desktopSaveFile,
  desktopUpdateProject,
  isTauri,
} from './tauri'

export interface FileMeta {
  id: string
  name: string
  updatedAt: number
  thumbnail?: string
  /** The project the file is in, or null for Drafts (no project). */
  projectId: string | null
}

/**
 * A project: a named folder of files. On desktop it is a real folder,
 * `<Documents>/Kiln/<folder>/` with a `project.json` (id, name, color, createdAt);
 * `id` is stable and never the folder name, so renaming a project renames its folder only.
 */
export interface ProjectMeta {
  id: string
  name: string
  /** One of PROJECT_COLORS. */
  color: string
  createdAt: number
  /** Latest updatedAt among its files (or createdAt when empty). */
  updatedAt: number
  fileCount: number
}

/** A deleted file, kept until restored or the trash is emptied. */
export interface TrashItem {
  /** Identifies this trash entry (a file can be deleted, restored and deleted again). */
  trashId: string
  id: string
  name: string
  deletedAt: number
  thumbnail?: string
  /** Where it was; restore puts it back there, or in Drafts if that project is gone. */
  projectId: string | null
}

export const PROJECT_COLORS = ['#ff5b1f', '#e8b04b', '#7fc49a', '#6fa8dc', '#a58bd8', '#d77fa1', '#a6a198'] as const

export interface Storage {
  kind: 'desktop' | 'browser'

  /** Every file in every project and in Drafts, newest first. Reads meta only, never whole documents where avoidable. */
  list(): Promise<FileMeta[]>
  load(id: string): Promise<KDoc | null>
  /**
   * Saves a document where it already lives. A file that doesn't exist yet goes into
   * `opts.projectId` (or Drafts when null/omitted); for an existing file `opts` is ignored.
   */
  save(doc: KDoc, opts?: { projectId?: string | null }): Promise<void>
  /** Moves a file to the trash (restorable). */
  remove(id: string): Promise<void>

  listProjects(): Promise<ProjectMeta[]>
  createProject(name: string, color?: string): Promise<ProjectMeta>
  updateProject(id: string, patch: { name?: string; color?: string }): Promise<ProjectMeta>
  /** Deletes a project. Its files go to Drafts ('keep-files') or to the trash ('trash-files'). */
  removeProject(id: string, mode: 'keep-files' | 'trash-files'): Promise<void>
  /** Moves a file into a project, or to Drafts with null. */
  moveFile(id: string, projectId: string | null): Promise<void>

  listTrash(): Promise<TrashItem[]>
  restore(trashId: string): Promise<void>
  /** Deletes for good: one entry, or everything when trashId is omitted. */
  purge(trashId?: string): Promise<void>
}

function toMeta(doc: { id: string; name?: string; updatedAt?: number; thumbnail?: string | null; projectId?: string | null }): FileMeta {
  const meta: FileMeta = { id: doc.id, name: doc.name ?? 'Untitled', updatedAt: doc.updatedAt ?? 0, projectId: doc.projectId ?? null }
  if (doc.thumbnail) meta.thumbnail = doc.thumbnail
  return meta
}

const byRecent = (a: FileMeta, b: FileMeta) => b.updatedAt - a.updatedAt

// ---- shared by the browser backends ------------------------------------------

/** A file as the browser keeps it: the document plus the project it is in. */
type FileRecord = KDoc & { projectId?: string | null }

interface ProjectRecord {
  id: string
  name: string
  color: string
  createdAt: number
}

interface TrashRecord {
  trashId: string
  deletedAt: number
  /** The project the file was in when deleted. */
  projectId: string | null
  doc: KDoc
}

const projectName = (name: string) => name.trim() || 'Untitled project'

function newProject(name: string, color?: string): ProjectRecord {
  return { id: 'p' + nanoid(10), name: projectName(name), color: color || PROJECT_COLORS[0], createdAt: Date.now() }
}

function patchProject(p: ProjectRecord, patch: { name?: string; color?: string }): ProjectRecord {
  return { ...p, name: patch.name !== undefined ? projectName(patch.name) : p.name, color: patch.color || p.color }
}

/** Projects with their file counts and latest edit, most recently edited first. */
function projectMetas(projects: ProjectRecord[], files: FileMeta[]): ProjectMeta[] {
  return projects
    .map((p) => {
      const mine = files.filter((f) => f.projectId === p.id)
      const updatedAt = mine.reduce((t, f) => Math.max(t, f.updatedAt), p.createdAt)
      return { id: p.id, name: p.name, color: p.color, createdAt: p.createdAt, updatedAt, fileCount: mine.length }
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** The document without the storage-only projectId field. */
function bareDoc(f: FileRecord): KDoc {
  const doc = { ...f }
  delete doc.projectId
  return doc
}

function toTrashRecord(f: FileRecord): TrashRecord {
  const deletedAt = Date.now()
  return { trashId: `${f.id}-${deletedAt}-${nanoid(4)}`, deletedAt, projectId: f.projectId ?? null, doc: bareDoc(f) }
}

function trashItem(t: TrashRecord): TrashItem {
  const item: TrashItem = { trashId: t.trashId, id: t.doc.id, name: t.doc.name ?? 'Untitled', deletedAt: t.deletedAt, projectId: t.projectId }
  if (t.doc.thumbnail) item.thumbnail = t.doc.thumbnail
  return item
}

const byDeleted = (a: TrashItem, b: TrashItem) => b.deletedAt - a.deletedAt

function checkMode(mode: string) {
  if (mode !== 'keep-files' && mode !== 'trash-files') throw new Error(`Unknown removeProject mode "${mode}"`)
}

const noProject = (id: string) => new Error(`That project doesn't exist anymore (${id})`)

// ---- desktop ---------------------------------------------------------------

const desktopStorage: Storage = {
  kind: 'desktop',
  async list() {
    return (await desktopListFiles()).map(toMeta)
  },
  async load(id) {
    return ((await desktopLoadFile(id)) as KDoc | null) ?? null
  },
  save: (doc, opts) => desktopSaveFile(doc, opts?.projectId ?? null),
  remove: (id) => desktopDeleteFile(id),
  listProjects: () => desktopListProjects(),
  createProject: (name, color) => desktopCreateProject(projectName(name), color ?? null),
  updateProject: (id, patch) => desktopUpdateProject(id, patch.name !== undefined ? { ...patch, name: projectName(patch.name) } : patch),
  removeProject: async (id, mode) => {
    checkMode(mode)
    await desktopRemoveProject(id, mode)
  },
  moveFile: (id, projectId) => desktopMoveFile(id, projectId),
  async listTrash() {
    return (await desktopListTrash()).map((t) => {
      const item: TrashItem = { trashId: t.trashId, id: t.id, name: t.name, deletedAt: t.deletedAt, projectId: t.projectId ?? null }
      if (t.thumbnail) item.thumbnail = t.thumbnail
      return item
    })
  },
  restore: (trashId) => desktopRestoreTrash(trashId),
  purge: (trashId) => desktopPurgeTrash(trashId ?? null),
}

// ---- IndexedDB -------------------------------------------------------------

const DB_NAME = 'kiln'
const DB_VERSION = 2
const FILES = 'files'
const PROJECTS = 'projects'
const TRASH = 'trash'
type StoreName = typeof FILES | typeof PROJECTS | typeof TRASH

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

/** The one open request's result (an open stays pending while the upgrade is blocked). */
let dbPromise: Promise<IDBDatabase> | null = null
/** True while that open is blocked by another tab holding an older version. */
let upgradeBlocked = false

/** How long to wait for an older Kiln tab to let go before telling the user. */
const BLOCKED_MS = 3000

/**
 * Another tab still runs older Kiln code and holds the database open, so the upgrade
 * can't finish. Storage calls reject with this (instead of hanging) until that tab is
 * closed or reloaded; the upgrade then finishes by itself and calls work again.
 */
export class StorageBlockedError extends Error {
  constructor() {
    super('Close or reload other Kiln tabs to finish updating storage')
    this.name = 'StorageBlockedError'
  }
}

function openDb(): Promise<IDBDatabase> {
  // One open request for the page's lifetime: a second request would queue behind a
  // blocked one and never hear about the block, so blocked calls wait on this one.
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION)
    open.onupgradeneeded = () => {
      // v1 had `files` only; v2 adds projects and trash. Existing files have no projectId = Drafts.
      const db = open.result
      if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(PROJECTS)) db.createObjectStore(PROJECTS, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(TRASH)) db.createObjectStore(TRASH, { keyPath: 'trashId' })
    }
    open.onsuccess = () => {
      upgradeBlocked = false
      const db = open.result
      // a newer version opened in another tab: let it upgrade, reopen on next use
      db.onversionchange = () => {
        db.close()
        dbPromise = null
      }
      resolve(db)
    }
    open.onerror = () => {
      upgradeBlocked = false
      reject(open.error)
    }
    // an older tab still holds the old version open (tabs running current code close on
    // versionchange): the request stays pending and completes once that tab lets go
    open.onblocked = () => {
      upgradeBlocked = true
      console.warn('[kiln] storage upgrade is waiting for another Kiln tab to close')
    }
  }).catch((err: unknown) => {
    dbPromise = null
    throw err
  })
  const db = dbPromise
  // fail loudly rather than hang every call while blocked: after BLOCKED_MS, or after a short
  // grace when we already know (the old tab may have just closed and the upgrade be finishing)
  return new Promise<IDBDatabase>((resolve, reject) => {
    const check = () => (upgradeBlocked ? reject(new StorageBlockedError()) : (timer = window.setTimeout(check, BLOCKED_MS)))
    let timer = window.setTimeout(check, upgradeBlocked ? 500 : BLOCKED_MS)
    db.then(
      (d) => {
        window.clearTimeout(timer)
        resolve(d)
      },
      (err: unknown) => {
        window.clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/**
 * Runs `fn` in one transaction over `stores` and resolves once it commits, so a resolved
 * write is durable. If `fn` throws, the transaction is aborted and nothing is written.
 */
async function inTx<T>(
  stores: StoreName[],
  mode: IDBTransactionMode,
  fn: (store: (name: StoreName) => IDBObjectStore) => Promise<T>,
): Promise<T> {
  const db = await openDb()
  const tx = db.transaction(stores, mode)
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
  })
  done.catch(() => {}) // observed below; avoids an unhandled rejection while fn runs
  let result: T
  try {
    result = await fn((name) => tx.objectStore(name))
  } catch (err) {
    try {
      tx.abort()
    } catch {
      // already finished
    }
    throw err
  }
  await done
  return result
}

const getAll = <T>(s: IDBObjectStore) => req(s.getAll() as IDBRequest<T[]>)
const getOne = <T>(s: IDBObjectStore, key: string) => req(s.get(key) as IDBRequest<T | undefined>)

const idbStorage: Storage = {
  kind: 'browser',
  async list() {
    const files = await inTx([FILES], 'readonly', (st) => getAll<FileRecord>(st(FILES)))
    return files.map(toMeta).sort(byRecent)
  },
  async load(id) {
    return (await inTx([FILES], 'readonly', (st) => getOne<FileRecord>(st(FILES), id))) ?? null
  },
  async save(doc, opts) {
    await inTx([FILES, PROJECTS], 'readwrite', async (st) => {
      const prev = await getOne<FileRecord>(st(FILES), doc.id)
      // an existing file stays where it is; only a new one goes into opts.projectId
      const projectId = prev ? (prev.projectId ?? null) : (opts?.projectId ?? null)
      if (!prev && projectId && !(await getOne<ProjectRecord>(st(PROJECTS), projectId))) throw noProject(projectId)
      await req(st(FILES).put({ ...doc, projectId }))
    })
  },
  async remove(id) {
    await inTx([FILES, TRASH], 'readwrite', async (st) => {
      const f = await getOne<FileRecord>(st(FILES), id)
      if (!f) return
      await req(st(TRASH).put(toTrashRecord(f)))
      await req(st(FILES).delete(id))
    })
  },

  async listProjects() {
    return inTx([FILES, PROJECTS], 'readonly', async (st) => {
      const [projects, files] = await Promise.all([getAll<ProjectRecord>(st(PROJECTS)), getAll<FileRecord>(st(FILES))])
      return projectMetas(projects, files.map(toMeta))
    })
  },
  async createProject(name, color) {
    const p = newProject(name, color)
    await inTx([PROJECTS], 'readwrite', (st) => req(st(PROJECTS).add(p)))
    return projectMetas([p], [])[0]
  },
  async updateProject(id, patch) {
    return inTx([FILES, PROJECTS], 'readwrite', async (st) => {
      const p = await getOne<ProjectRecord>(st(PROJECTS), id)
      if (!p) throw noProject(id)
      const next = patchProject(p, patch)
      await req(st(PROJECTS).put(next))
      return projectMetas([next], (await getAll<FileRecord>(st(FILES))).map(toMeta))[0]
    })
  },
  async removeProject(id, mode) {
    checkMode(mode)
    await inTx([FILES, PROJECTS, TRASH], 'readwrite', async (st) => {
      const files = (await getAll<FileRecord>(st(FILES))).filter((f) => f.projectId === id)
      for (const f of files) {
        if (mode === 'keep-files') {
          await req(st(FILES).put({ ...f, projectId: null }))
        } else {
          await req(st(TRASH).put(toTrashRecord(f)))
          await req(st(FILES).delete(f.id))
        }
      }
      await req(st(PROJECTS).delete(id))
    })
  },
  async moveFile(id, projectId) {
    await inTx([FILES, PROJECTS], 'readwrite', async (st) => {
      const f = await getOne<FileRecord>(st(FILES), id)
      if (!f) throw new Error(`That file doesn't exist anymore (${id})`)
      if (projectId && !(await getOne<ProjectRecord>(st(PROJECTS), projectId))) throw noProject(projectId)
      if ((f.projectId ?? null) !== projectId) await req(st(FILES).put({ ...f, projectId }))
    })
  },

  async listTrash() {
    const trash = await inTx([TRASH], 'readonly', (st) => getAll<TrashRecord>(st(TRASH)))
    return trash.map(trashItem).sort(byDeleted)
  },
  async restore(trashId) {
    await inTx([FILES, PROJECTS, TRASH], 'readwrite', async (st) => {
      const t = await getOne<TrashRecord>(st(TRASH), trashId)
      if (!t) throw new Error('That item is no longer in the trash')
      // back into its project if that still exists, else Drafts
      const projectId = t.projectId && (await getOne<ProjectRecord>(st(PROJECTS), t.projectId)) ? t.projectId : null
      // a file with the same id came back meanwhile: keep both
      const taken = await getOne<FileRecord>(st(FILES), t.doc.id)
      const doc = taken ? { ...t.doc, id: nanoid(10) } : t.doc
      await req(st(FILES).put({ ...doc, projectId }))
      await req(st(TRASH).delete(trashId))
    })
  },
  async purge(trashId) {
    await inTx([TRASH], 'readwrite', (st) => req(trashId === undefined ? st(TRASH).clear() : st(TRASH).delete(trashId)))
  },
}

// ---- localStorage fallback -------------------------------------------------

const LS_FILE = 'kiln:file:'
const LS_PROJECT = 'kiln:project:'
const LS_TRASH = 'kiln:trash:'

/** Every parseable value stored under `prefix`. */
function lsAll<T>(prefix: string): T[] {
  const out: T[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key?.startsWith(prefix)) continue
    try {
      out.push(JSON.parse(localStorage.getItem(key) ?? '') as T)
    } catch {
      console.warn(`[kiln] skipping corrupt entry ${key}`)
    }
  }
  return out
}

function lsGet<T>(key: string): T | null {
  const raw = localStorage.getItem(key)
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

const lsSet = (key: string, value: unknown) => localStorage.setItem(key, JSON.stringify(value))

function lsTrash(f: FileRecord) {
  const t = toTrashRecord(f)
  lsSet(LS_TRASH + t.trashId, t)
  localStorage.removeItem(LS_FILE + f.id)
}

const localStorageStorage: Storage = {
  kind: 'browser',
  async list() {
    return lsAll<FileRecord>(LS_FILE).map(toMeta).sort(byRecent)
  },
  async load(id) {
    const raw = localStorage.getItem(LS_FILE + id)
    return raw ? (JSON.parse(raw) as FileRecord) : null
  },
  async save(doc, opts) {
    const prev = lsGet<FileRecord>(LS_FILE + doc.id)
    const projectId = prev ? (prev.projectId ?? null) : (opts?.projectId ?? null)
    if (!prev && projectId && !lsGet(LS_PROJECT + projectId)) throw noProject(projectId)
    lsSet(LS_FILE + doc.id, { ...doc, projectId })
  },
  async remove(id) {
    const f = lsGet<FileRecord>(LS_FILE + id)
    if (f) lsTrash(f)
  },

  async listProjects() {
    return projectMetas(lsAll<ProjectRecord>(LS_PROJECT), lsAll<FileRecord>(LS_FILE).map(toMeta))
  },
  async createProject(name, color) {
    const p = newProject(name, color)
    lsSet(LS_PROJECT + p.id, p)
    return projectMetas([p], [])[0]
  },
  async updateProject(id, patch) {
    const p = lsGet<ProjectRecord>(LS_PROJECT + id)
    if (!p) throw noProject(id)
    const next = patchProject(p, patch)
    lsSet(LS_PROJECT + id, next)
    return projectMetas([next], lsAll<FileRecord>(LS_FILE).map(toMeta))[0]
  },
  async removeProject(id, mode) {
    checkMode(mode)
    for (const f of lsAll<FileRecord>(LS_FILE)) {
      if (f.projectId !== id) continue
      if (mode === 'keep-files') lsSet(LS_FILE + f.id, { ...f, projectId: null })
      else lsTrash(f)
    }
    localStorage.removeItem(LS_PROJECT + id)
  },
  async moveFile(id, projectId) {
    const f = lsGet<FileRecord>(LS_FILE + id)
    if (!f) throw new Error(`That file doesn't exist anymore (${id})`)
    if (projectId && !lsGet(LS_PROJECT + projectId)) throw noProject(projectId)
    lsSet(LS_FILE + id, { ...f, projectId })
  },

  async listTrash() {
    return lsAll<TrashRecord>(LS_TRASH).map(trashItem).sort(byDeleted)
  },
  async restore(trashId) {
    const t = lsGet<TrashRecord>(LS_TRASH + trashId)
    if (!t) throw new Error('That item is no longer in the trash')
    const projectId = t.projectId && lsGet(LS_PROJECT + t.projectId) ? t.projectId : null
    const doc = lsGet(LS_FILE + t.doc.id) ? { ...t.doc, id: nanoid(10) } : t.doc
    lsSet(LS_FILE + doc.id, { ...doc, projectId })
    localStorage.removeItem(LS_TRASH + trashId)
  },
  async purge(trashId) {
    if (trashId !== undefined) return localStorage.removeItem(LS_TRASH + trashId)
    for (const t of lsAll<TrashRecord>(LS_TRASH)) localStorage.removeItem(LS_TRASH + t.trashId)
  },
}

// ---- browser: IndexedDB with a lazy fallback --------------------------------

let browserBackend: Promise<Storage> | null = null

function pickBrowserBackend(): Promise<Storage> {
  browserBackend ??= (async () => {
    if (typeof indexedDB === 'undefined') return localStorageStorage
    try {
      await openDb()
      return idbStorage
    } catch (err) {
      // blocked by an old tab: the files are there, just locked; falling back would show
      // an empty localStorage instead. Fail this call and try again on the next one.
      if (err instanceof StorageBlockedError) {
        browserBackend = null
        throw err
      }
      console.warn('[kiln] IndexedDB unavailable, using localStorage', err)
      return localStorageStorage
    }
  })()
  return browserBackend
}

const browserStorage: Storage = {
  kind: 'browser',
  list: async () => (await pickBrowserBackend()).list(),
  load: async (id) => (await pickBrowserBackend()).load(id),
  save: async (doc, opts) => (await pickBrowserBackend()).save(doc, opts),
  remove: async (id) => (await pickBrowserBackend()).remove(id),
  listProjects: async () => (await pickBrowserBackend()).listProjects(),
  createProject: async (name, color) => (await pickBrowserBackend()).createProject(name, color),
  updateProject: async (id, patch) => (await pickBrowserBackend()).updateProject(id, patch),
  removeProject: async (id, mode) => (await pickBrowserBackend()).removeProject(id, mode),
  moveFile: async (id, projectId) => (await pickBrowserBackend()).moveFile(id, projectId),
  listTrash: async () => (await pickBrowserBackend()).listTrash(),
  restore: async (trashId) => (await pickBrowserBackend()).restore(trashId),
  purge: async (trashId) => (await pickBrowserBackend()).purge(trashId),
}

export const storage: Storage = isTauri ? desktopStorage : browserStorage
