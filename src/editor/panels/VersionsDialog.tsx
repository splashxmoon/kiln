/**
 * Version history: the open file's named versions and timed snapshots (storage.listVersions), a
 * read-only preview of each, "Name this version", Restore as one undo step, and Delete for named
 * ones. Menus.tsx mounts the host. Commands reach it by window events, like batch rename:
 * `kiln:versions` (file.versions) opens it, `kiln:save-version` (file.saveVersion, ⌥⌘S) names a
 * version without opening it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Bookmark, Clock, History, RotateCcw, Trash2, X } from 'lucide-react'
import { getEditor, useEditor } from '../store'
import { storage, type VersionMeta } from '../../platform/storage'
import { askConfirm, askText } from '../../ui/Dialogs'
import { shortcut } from '../../platform/keys'
import { snapshotNode } from '../snapshot'
import { applyVersion } from './applyVersion'
import { isNewerThanApp, NewerFileError } from '../migrate'
import type { KDoc } from '../types'
import './versions.css'

const OPEN_EVENT = 'kiln:versions'
const SAVE_EVENT = 'kiln:save-version'
const CHANGED_EVENT = 'kiln:versions-changed'
const changed = () => window.dispatchEvent(new CustomEvent(CHANGED_EVENT))

const THUMB_SIZE = 360

/** An image scaled down to a small JPG (file-card thumbnails are larger PNGs). */
async function smallJpeg(url: string): Promise<string | null> {
  const img = new Image()
  img.src = url
  await img.decode()
  const k = Math.min(1, THUMB_SIZE / Math.max(img.naturalWidth, img.naturalHeight, 1))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(img.naturalWidth * k))
  c.height = Math.max(1, Math.round(img.naturalHeight * k))
  const g = c.getContext('2d')
  if (!g) return null
  g.fillStyle = '#fff' // a JPG has no transparency
  g.fillRect(0, 0, c.width, c.height)
  g.drawImage(img, 0, 0, c.width, c.height)
  return c.toDataURL('image/jpeg', 0.82)
}

/**
 * The open document with a fresh thumbnail: the first artboard of the page on screen (only drawn
 * layers can be snapshot), else of the first page, else the file's own card thumbnail (the page on
 * screen may be empty). A small JPG, since every version keeps its own (browser storage is small).
 */
async function openDocWithThumbnail(): Promise<KDoc> {
  const s = getEditor()
  const doc = s.doc
  const boards = [doc.pages.find((p) => p.id === s.pageId)?.children[0], doc.pages[0]?.children[0]]
  let thumbnail: string | null | undefined
  for (const id of new Set(boards)) {
    if (!id || thumbnail) continue
    thumbnail = await snapshotNode(id, { maxSize: THUMB_SIZE, format: 'jpeg' }).catch(() => null)
  }
  if (!thumbnail) {
    const card = doc.thumbnail || (await storage.list().catch(() => [])).find((f) => f.id === doc.id)?.thumbnail
    if (card) thumbnail = await smallJpeg(card).catch(() => null)
  }
  return thumbnail ? { ...doc, thumbnail } : doc
}

/** Asks for a name and keeps the open document, as it is now, as a named version. */
async function saveNamedVersion(): Promise<VersionMeta | null> {
  const name = await askText({
    title: 'Name this version',
    body: 'Named versions stay until you delete them. Kiln also keeps one by itself every ten minutes while you work.',
    placeholder: 'Before the redesign',
    confirmLabel: 'Save version',
  })
  if (!name) return null
  try {
    const doc = await openDocWithThumbnail()
    const v = await storage.saveVersion(doc.id, name, doc)
    getEditor().notify(`Saved version “${name}”`)
    changed()
    return v
  } catch (e) {
    getEditor().notify('Could not save the version: ' + (e as Error).message)
    return null
  }
}

/* ------------------------------------------------------------------ host */

export function VersionsHost() {
  const [fileId, setFileId] = useState<string | null>(null)
  const docId = useEditor((s) => s.doc.id)
  useEffect(() => {
    const open = () => setFileId(getEditor().doc.id)
    const save = () => void saveNamedVersion()
    window.addEventListener(OPEN_EVENT, open)
    window.addEventListener(SAVE_EVENT, save)
    return () => {
      window.removeEventListener(OPEN_EVENT, open)
      window.removeEventListener(SAVE_EVENT, save)
    }
  }, [])
  const close = useCallback(() => setFileId(null), [])
  // another file was opened meanwhile: this history isn't its, and it stays closed on coming back
  if (fileId && fileId !== docId) setFileId(null)
  if (!fileId || fileId !== docId) return null
  return <VersionsDialog key={fileId} fileId={fileId} close={close} />
}

/* ------------------------------------------------------------------ dialog */

const DAY_MS = 86_400_000

function dayLabel(t: number, now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (t >= start) return 'Today'
  if (t >= start - DAY_MS) return 'Yesterday'
  const d = new Date(t)
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' })
}

const timeLabel = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

function sizeLabel(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

const titleOf = (v: VersionMeta) => v.name ?? 'Autosave'

interface Loaded {
  pages: number
  layers: number
}

function VersionsDialog({ fileId, close }: { fileId: string; close: () => void }) {
  const [list, setList] = useState<VersionMeta[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [details, setDetails] = useState<Record<string, Loaded | 'missing'>>({})
  /** another Kiln dialog (name / confirm) is open on top: Escape is its */
  const asking = useRef(false)
  const listRef = useRef<HTMLDivElement>(null)
  const readOnly = useEditor((s) => isNewerThanApp(s.doc))

  // the list, read again whenever a version is saved, deleted or restored
  useEffect(() => {
    let live = true
    const load = () =>
      storage.listVersions(fileId).then(
        (next) => {
          if (!live) return
          setList(next)
          setError(null)
          setSelectedId((cur) => (cur && next.some((v) => v.versionId === cur) ? cur : (next[0]?.versionId ?? null)))
        },
        (e: unknown) => {
          if (!live) return
          setError((e as Error).message)
          setList([])
        },
      )
    void load()
    window.addEventListener(CHANGED_EVENT, load)
    return () => {
      live = false
      window.removeEventListener(CHANGED_EVENT, load)
    }
  }, [fileId])

  useEffect(() => {
    listRef.current?.focus()
    const key = (e: KeyboardEvent) => {
      // a Kiln dialog on top (name, confirm; also one opened with ⌥⌘S) takes its own Escape
      if (e.key !== 'Escape' || asking.current || document.querySelectorAll('.k-dialog').length > 1) return
      e.stopPropagation()
      e.preventDefault()
      close()
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [close])

  const selected = list?.find((v) => v.versionId === selectedId) ?? null

  // the preview's page and layer counts: read the version once it is picked
  useEffect(() => {
    if (!selected || details[selected.versionId]) return
    let live = true
    storage
      .loadVersion(fileId, selected.versionId)
      .then((doc) => {
        if (!live) return
        const info: Loaded | 'missing' = doc ? { pages: doc.pages.length, layers: Object.keys(doc.nodes).length } : 'missing'
        setDetails((m) => ({ ...m, [selected.versionId]: info }))
      })
      .catch(() => live && setDetails((m) => ({ ...m, [selected.versionId]: 'missing' })))
    return () => {
      live = false
    }
  }, [fileId, selected, details])

  /** rows with a day heading before the first of each day */
  const rows = useMemo(() => {
    const out: ({ kind: 'day'; label: string } | { kind: 'version'; v: VersionMeta })[] = []
    let last = ''
    for (const v of list ?? []) {
      const label = dayLabel(v.createdAt)
      if (label !== last) out.push({ kind: 'day', label })
      last = label
      out.push({ kind: 'version', v })
    }
    return out
  }, [list])

  const ask = async <T,>(fn: () => Promise<T>): Promise<T> => {
    asking.current = true
    try {
      return await fn()
    } finally {
      asking.current = false
      listRef.current?.focus()
    }
  }

  const nameNow = async () => {
    const v = await ask(saveNamedVersion)
    if (v) setSelectedId(v.versionId)
  }

  const restore = async (meta: VersionMeta) => {
    if (busy) return
    setBusy(true)
    const s = getEditor()
    try {
      const v = await storage.loadVersion(fileId, meta.versionId)
      if (!v) throw new Error('That version no longer exists')
      if (isNewerThanApp(v)) throw new NewerFileError()
      // what is there now is kept too, so it can be found here later and not only through Undo
      await storage.saveVersion(fileId, null, await openDocWithThumbnail()).catch(() => null)
      if (getEditor().doc.id !== fileId) return
      applyVersion(v, meta.thumbnail)
      changed()
      s.notify(`Restored ${meta.name ? `“${meta.name}”` : `the autosave from ${dayLabel(meta.createdAt).toLowerCase()} ${timeLabel(meta.createdAt)}`}. ${shortcut('⌘Z')} brings back what you had.`)
      close()
    } catch (e) {
      s.notify('Could not restore this version: ' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (meta: VersionMeta) => {
    const ok = await ask(() =>
      askConfirm({ title: `Delete “${titleOf(meta)}”?`, body: 'This version is removed for good. The file itself stays as it is.', confirmLabel: 'Delete version', danger: true }),
    )
    if (!ok) return
    // the selection moves to the row below (or above, for the last), not back to the top
    const i = list?.findIndex((v) => v.versionId === meta.versionId) ?? -1
    const neighbour = i < 0 ? undefined : (list?.[i + 1] ?? list?.[i - 1])
    try {
      await storage.deleteVersion(fileId, meta.versionId)
      if (meta.versionId === selectedId && neighbour) setSelectedId(neighbour.versionId)
      changed()
    } catch (e) {
      getEditor().notify('Could not delete the version: ' + (e as Error).message)
    }
  }

  const onListKey = (e: ReactKeyboardEvent) => {
    if (!list?.length) return
    const i = list.findIndex((v) => v.versionId === selectedId)
    const move = (to: number) => {
      e.preventDefault()
      const next = list[Math.max(0, Math.min(list.length - 1, to))]
      setSelectedId(next.versionId)
      listRef.current?.querySelector(`[data-version="${next.versionId}"]`)?.scrollIntoView({ block: 'nearest' })
    }
    if (e.key === 'ArrowDown') move(i + 1)
    else if (e.key === 'ArrowUp') move(i - 1)
    else if (e.key === 'Home') move(0)
    else if (e.key === 'End') move(list.length - 1)
  }

  const info = selected ? details[selected.versionId] : undefined

  return createPortal(
    <div className="k-dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="k-dialog k-versions" role="dialog" aria-modal="true" aria-labelledby="k-versions-title" onKeyDown={(e) => e.stopPropagation()}>
        <header className="k-versions-head">
          <History size={15} aria-hidden />
          <h2 id="k-versions-title">Version history</h2>
          <button type="button" className="k-btn-ghost k-versions-name" onClick={() => void nameNow()} title={`Name this version (${shortcut('⌥⌘S')})`}>
            <Bookmark size={13} aria-hidden /> Name this version
          </button>
          <button type="button" className="k-versions-close" onClick={close} aria-label="Close">
            <X size={15} />
          </button>
        </header>

        <div className="k-versions-body">
          <div
            ref={listRef}
            className="k-versions-list"
            role="listbox"
            aria-label="Versions"
            aria-activedescendant={selectedId ? `k-version-${selectedId}` : undefined}
            tabIndex={0}
            onKeyDown={onListKey}
          >
            {list === null && <p className="k-versions-note">Loading…</p>}
            {error && <p className="k-versions-note is-bad">Couldn't read the versions: {error}</p>}
            {list?.length === 0 && !error && (
              <p className="k-versions-note">No versions yet. Kiln keeps one every ten minutes while you work, and you can name one now.</p>
            )}
            {rows.map((r) =>
              r.kind === 'day' ? (
                <div key={'d' + r.label} className="k-versions-day">
                  {r.label}
                </div>
              ) : (
                <div
                  key={r.v.versionId}
                  id={`k-version-${r.v.versionId}`}
                  data-version={r.v.versionId}
                  role="option"
                  aria-selected={r.v.versionId === selectedId}
                  className={'k-versions-row' + (r.v.versionId === selectedId ? ' is-selected' : '')}
                  onClick={() => setSelectedId(r.v.versionId)}
                  onDoubleClick={() => !readOnly && void restore(r.v)}
                >
                  <span className="k-versions-thumb">{r.v.thumbnail ? <img src={r.v.thumbnail} alt="" draggable={false} /> : <Clock size={13} aria-hidden />}</span>
                  <span className="k-versions-text">
                    <span className={'k-versions-title' + (r.v.name ? '' : ' is-auto')}>{titleOf(r.v)}</span>
                    <span className="k-versions-time">{timeLabel(r.v.createdAt)}</span>
                  </span>
                  {r.v.name && <Bookmark size={12} className="k-versions-badge" aria-label="Named" />}
                </div>
              ),
            )}
          </div>

          <div className="k-versions-preview" aria-live="polite">
            {selected ? (
              <>
                <div className="k-versions-shot">
                  {selected.thumbnail ? <img src={selected.thumbnail} alt={`Preview of ${titleOf(selected)}`} draggable={false} /> : <span>No preview for this version</span>}
                </div>
                <div className="k-versions-meta">
                  <h3>{titleOf(selected)}</h3>
                  <p>
                    {dayLabel(selected.createdAt)}, {timeLabel(selected.createdAt)} · {sizeLabel(selected.size)}
                  </p>
                  <p>
                    {info === 'missing'
                      ? "This version can't be read."
                      : info
                        ? `${info.pages} page${info.pages === 1 ? '' : 's'} · ${info.layers} layer${info.layers === 1 ? '' : 's'}`
                        : ' '}
                  </p>
                  {readOnly ? (
                    <p className="k-versions-hint">This file is from a newer Kiln and is read-only here, so nothing can be restored into it.</p>
                  ) : (
                    !selected.name && <p className="k-versions-hint">Autosaves are thinned out over time. Name a version to keep it.</p>
                  )}
                </div>
                <div className="k-versions-actions">
                  {selected.name && (
                    <button type="button" className="k-btn-ghost k-versions-delete" onClick={() => void remove(selected)} disabled={busy}>
                      <Trash2 size={13} aria-hidden /> Delete
                    </button>
                  )}
                  <button
                    type="button"
                    className="k-btn-primary"
                    onClick={() => void restore(selected)}
                    disabled={busy || readOnly || info === 'missing'}
                    // a disabled button gets no pointer events, so its title would show as a native
                    // tooltip: the read-only reason is the hint line above instead
                    title={busy || readOnly || info === 'missing' ? undefined : 'Replace the file’s content with this version (one undo step)'}
                  >
                    <RotateCcw size={13} aria-hidden /> {busy ? 'Restoring…' : 'Restore'}
                  </button>
                </div>
              </>
            ) : (
              list !== null && <div className="k-versions-shot is-empty"><History size={22} aria-hidden /></div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
