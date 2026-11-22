import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { DOC_VERSION, NewerFileError } from '../editor/migrate'
import { emptyDoc } from '../editor/factory'
import type { KDoc } from '../editor/types'

// The wrapper every load and save goes through, over the browser's localStorage backend
// (node has no indexedDB, so that is the one it picks), backed here by a Map that can be given
// a size limit, like a real browser's quota.
let storage: typeof import('./storage').storage
let autosToPrune: typeof import('./storage').autosToPrune
let BUDGET: number
let WEB_THUMB_MAX: number
const mem = new Map<string, string>()
let quota = Infinity
const used = () => [...mem].reduce((n, [k, v]) => n + k.length + v.length, 0)

beforeAll(async () => {
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => {
      const next = used() - (mem.has(k) ? k.length + mem.get(k)!.length : 0) + k.length + String(v).length
      if (next > quota) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
      mem.set(k, String(v))
    },
    removeItem: (k: string) => void mem.delete(k),
    key: (i: number) => [...mem.keys()][i] ?? null,
    get length() {
      return mem.size
    },
    clear: () => mem.clear(),
  })
  ;({ storage, autosToPrune, WEB_VERSION_BUDGET: BUDGET, WEB_VERSION_THUMB_MAX: WEB_THUMB_MAX } = await import('./storage'))
})

afterEach(() => {
  quota = Infinity
  vi.useRealTimers()
})

const fileKey = (id: string) => `kiln:file:${id}`
const stored = (id: string) => JSON.parse(mem.get(fileKey(id))!)

describe('storage wrapper', () => {
  it('stamps the current version on save', async () => {
    const doc = { ...emptyDoc('Old'), version: undefined } as KDoc
    await storage.save(doc)
    expect(stored(doc.id).version).toBe(DOC_VERSION)
  })

  it('migrates on load', async () => {
    const doc = emptyDoc('Legacy')
    await storage.save(doc)
    const raw = stored(doc.id)
    delete raw.version
    delete raw.tokens
    mem.set(fileKey(doc.id), JSON.stringify(raw))
    const loaded = await storage.load(doc.id)
    expect(loaded?.version).toBe(DOC_VERSION)
    expect(loaded?.tokens).toEqual([])
  })

  it('refuses to save over a file from a newer Kiln', async () => {
    const doc = { ...emptyDoc('Future'), version: DOC_VERSION + 1 }
    await expect(storage.save(doc)).rejects.toBeInstanceOf(NewerFileError)
    expect(mem.has(fileKey(doc.id))).toBe(false)
  })
})

const MIN = 60_000
const DAY = 86_400_000
const T0 = Date.UTC(2026, 10, 18, 9)

/** A saved file at time `at`, returned as saved. */
async function savedAt(at: number, name = 'File', base?: KDoc) {
  vi.useFakeTimers({ now: at, toFake: ['Date'] })
  const doc = { ...(base ?? emptyDoc(name)), name, updatedAt: at }
  await storage.save(doc)
  return doc
}

describe('versions in the browser', () => {
  it('keeps an automatic version on save, then one every ten minutes', async () => {
    const doc = await savedAt(T0, 'Timed')
    await savedAt(T0 + 4 * MIN, 'Timed', doc)
    await savedAt(T0 + 9 * MIN, 'Timed', doc)
    expect((await storage.listVersions(doc.id)).map((v) => v.createdAt)).toEqual([T0])
    await savedAt(T0 + 10 * MIN, 'Timed again', doc)
    const list = await storage.listVersions(doc.id)
    expect(list.map((v) => [v.name, v.createdAt])).toEqual([
      [null, T0 + 10 * MIN],
      [null, T0],
    ])
    expect((await storage.loadVersion(doc.id, list[0].versionId))?.name).toBe('Timed again')
  })

  it('names versions, lists them newest first, migrates on load and deletes', async () => {
    const doc = await savedAt(T0, 'Named')
    vi.setSystemTime(T0 + MIN)
    const open = { ...doc, name: 'Open, not saved yet', thumbnail: 'data:image/png;base64,AAAA' }
    const named = (await storage.saveVersion(doc.id, '  Before the redesign  ', open))!
    expect(named.name).toBe('Before the redesign')
    expect(named.thumbnail).toBe('data:image/png;base64,AAAA')
    vi.setSystemTime(T0 + 2 * MIN)
    const fromSaved = (await storage.saveVersion(doc.id, 'As saved'))!
    expect((await storage.listVersions(doc.id)).map((v) => v.name)).toEqual(['As saved', 'Before the redesign', null])
    expect((await storage.loadVersion(doc.id, named.versionId))?.name).toBe('Open, not saved yet')
    expect((await storage.loadVersion(doc.id, fromSaved.versionId))?.name).toBe('Named')

    // an old-format version opens in the current format
    const key = `kiln:vdoc:${doc.id}:${fromSaved.versionId}`
    const raw = JSON.parse(mem.get(key)!)
    delete raw.version
    delete raw.comments
    mem.set(key, JSON.stringify(raw))
    const loaded = await storage.loadVersion(doc.id, fromSaved.versionId)
    expect(loaded?.version).toBe(DOC_VERSION)
    expect(loaded?.comments).toEqual([])

    await storage.deleteVersion(doc.id, named.versionId)
    expect((await storage.listVersions(doc.id)).map((v) => v.name)).toEqual(['As saved', null])
    expect(await storage.loadVersion(doc.id, named.versionId)).toBeNull()
    expect(mem.has(`kiln:vdoc:${doc.id}:${named.versionId}`)).toBe(false)
  })

  it('refuses versions of a newer file and of a document that is not the file', async () => {
    const doc = await savedAt(T0, 'Checked')
    await expect(storage.saveVersion(doc.id, 'Future', { ...doc, version: DOC_VERSION + 1 })).rejects.toBeInstanceOf(NewerFileError)
    await expect(storage.saveVersion(doc.id, 'Other', emptyDoc('Other'))).rejects.toThrow(/id/)
    await expect(storage.saveVersion('no-such-file', 'X')).rejects.toThrow(/doesn't exist/)
  })

  it('restores a version as the file, keeping its id and what it replaced', async () => {
    const doc = await savedAt(T0, 'One')
    const v1 = (await storage.saveVersion(doc.id, 'One'))!
    await savedAt(T0 + 2 * MIN, 'Two', doc)
    vi.setSystemTime(T0 + 3 * MIN)
    const restored = await storage.restoreVersion(doc.id, v1.versionId)
    expect(restored.id).toBe(doc.id)
    expect(restored.name).toBe('One')
    expect(stored(doc.id).name).toBe('One')
    expect(stored(doc.id).updatedAt).toBeGreaterThan(T0 + 2 * MIN)
    const before = (await storage.listVersions(doc.id)).find((v) => v.name === null && v.createdAt === T0 + 3 * MIN)!
    expect((await storage.loadVersion(doc.id, before.versionId))?.name).toBe('Two')
    await expect(storage.restoreVersion(doc.id, 'n1-gone')).rejects.toThrow(/no longer exists/)

    // a version saved by a newer Kiln doesn't go back over the file
    const future = (await storage.saveVersion(doc.id, 'Future?'))!
    const key = `kiln:vdoc:${doc.id}:${future.versionId}`
    mem.set(key, JSON.stringify({ ...JSON.parse(mem.get(key)!), version: DOC_VERSION + 1 }))
    await expect(storage.restoreVersion(doc.id, future.versionId)).rejects.toBeInstanceOf(NewerFileError)
  })

  it('prunes automatic versions harder than desktop, never named ones', async () => {
    const doc = await savedAt(T0 - 40 * DAY, 'Pruned')
    await storage.saveVersion(doc.id, 'Kept forever')
    // four a day for 40 days, oldest first, as a file would collect them
    for (let d = 39; d >= 0; d--) {
      for (let q = 3; q >= 0; q--) {
        vi.setSystemTime(T0 - d * DAY - q * 2 * 60 * MIN)
        await storage.saveVersion(doc.id, null)
      }
    }
    const list = await storage.listVersions(doc.id)
    const autos = list.filter((v) => v.name === null)
    // the 10 newest (days 0 and 1, two of day 2) plus the newest of days 3 to 6
    expect(autos.length).toBe(10 + 4)
    expect(autos.every((v) => T0 - v.createdAt < 7 * DAY)).toBe(true)
    expect(list.some((v) => v.name === 'Kept forever')).toBe(true)
    // pruned documents are gone, not just unlisted
    const docs = [...mem.keys()].filter((k) => k.startsWith(`kiln:vdoc:${doc.id}:`))
    expect(docs.length).toBe(list.length)
  })

  it('makes room when storage is full, and fails soft for automatic versions', async () => {
    // only this file's versions, so what can be dropped is known
    for (const k of [...mem.keys()]) if (k.startsWith('kiln:v')) mem.delete(k)
    const doc = await savedAt(T0, 'Full')
    for (let i = 1; i <= 5; i++) {
      vi.setSystemTime(T0 + i * MIN)
      await storage.saveVersion(doc.id, null)
    }
    expect((await storage.listVersions(doc.id)).length).toBe(6)
    // room for the file but barely any more: a named version pushes out the oldest automatic ones
    quota = used() + 200
    vi.setSystemTime(T0 + 10 * MIN)
    const named = await storage.saveVersion(doc.id, 'Fits after cleanup')
    expect(named?.name).toBe('Fits after cleanup')
    const after = await storage.listVersions(doc.id)
    expect(after[0].versionId).toBe(named!.versionId)
    expect(after.filter((v) => v.name === null).length).toBeLessThan(6)

    // nothing left to drop: an automatic version is skipped, a named one says why
    quota = used() + 10
    for (const v of after.filter((v) => v.name === null)) await storage.deleteVersion(doc.id, v.versionId)
    quota = used() + 10
    expect(await storage.saveVersion(doc.id, null)).toBeNull()
    await expect(storage.saveVersion(doc.id, 'Too big')).rejects.toThrow(/Not enough browser storage/)
    // and saving the file still works when its timed version has no room
    vi.setSystemTime(T0 + 30 * MIN)
    quota = used() + 20 // the file grows by nothing: same size, just rewritten
    await expect(storage.save({ ...doc, updatedAt: T0 + 30 * MIN })).resolves.toBeUndefined()
  })

  it('keeps versions within their budget, and one file never empties the history of another', async () => {
    for (const k of [...mem.keys()]) if (k.startsWith('kiln:v')) mem.delete(k)
    const versionChars = () => [...mem].filter(([k]) => k.startsWith('kiln:v')).reduce((n, [k, v]) => n + k.length + v.length, 0)
    const small = await savedAt(T0, 'Small')
    vi.setSystemTime(T0 + MIN)
    await storage.saveVersion(small.id, null)
    const big = await savedAt(T0, 'Big')
    // bigger than the whole budget: skipped (automatic) or refused (named), nothing else dropped
    const huge = { ...big, thumbnail: 'x'.repeat(BUDGET) }
    expect(await storage.saveVersion(big.id, null, huge)).toBeNull()
    await expect(storage.saveVersion(big.id, 'Huge', huge)).rejects.toThrow(/Not enough browser storage/)
    expect((await storage.listVersions(small.id)).length).toBe(2)
    // each of these takes about 40% of the budget: the third makes room by dropping the big
    // file's own oldest, never the small file's
    const heavy = { ...big, thumbnail: 'y'.repeat(BUDGET * 0.4) }
    for (let i = 1; i <= 3; i++) {
      vi.setSystemTime(T0 + i * 2 * MIN)
      expect(await storage.saveVersion(big.id, null, heavy)).not.toBeNull()
      expect(versionChars()).toBeLessThanOrEqual(BUDGET)
    }
    expect((await storage.listVersions(big.id)).map((v) => v.createdAt)).toEqual([T0 + 6 * MIN, T0 + 4 * MIN])
    expect((await storage.listVersions(small.id)).length).toBe(2)
  })

  it('keeps a thumbnail once, and leaves an oversized one out of an automatic version', async () => {
    const card = 'data:image/png;base64,' + 'A'.repeat(WEB_THUMB_MAX) // like a file card PNG
    const doc = await savedAt(T0, 'Thumbs')
    await savedAt(T0 + 10 * MIN, 'Thumbs', { ...doc, thumbnail: card })
    const [auto] = await storage.listVersions(doc.id)
    // no canvas here: the card can't be redrawn smaller, so the version has no preview
    expect(auto.createdAt).toBe(T0 + 10 * MIN)
    expect(auto.thumbnail).toBeUndefined()

    vi.setSystemTime(T0 + 11 * MIN)
    const shot = 'data:image/jpeg;base64,BBBB'
    const named = (await storage.saveVersion(doc.id, 'With a preview', { ...doc, thumbnail: shot }))!
    expect(named.thumbnail).toBe(shot)
    const raw = JSON.parse(mem.get(`kiln:vdoc:${doc.id}:${named.versionId}`)!)
    expect(raw.thumbnail).toBeUndefined()
    // restoring through storage gives the file card the version's thumbnail back
    vi.setSystemTime(T0 + 12 * MIN)
    expect((await storage.restoreVersion(doc.id, named.versionId)).thumbnail).toBe(shot)
    expect(stored(doc.id).thumbnail).toBe(shot)
  })

  it('keeps versions in the trash and removes them on purge', async () => {
    const doc = await savedAt(T0, 'Trashed')
    await storage.saveVersion(doc.id, 'Named')
    await storage.remove(doc.id)
    expect((await storage.listVersions(doc.id)).length).toBe(2)
    const other = await savedAt(T0, 'Other trashed')
    await storage.remove(other.id)
    const trash = await storage.listTrash()
    await storage.purge(trash.find((t) => t.id === doc.id)!.trashId)
    expect(await storage.listVersions(doc.id)).toEqual([])
    expect([...mem.keys()].some((k) => k.includes(doc.id))).toBe(false)
    expect((await storage.listVersions(other.id)).length).toBe(1)
    await storage.purge()
    expect(await storage.listVersions(other.id)).toEqual([])
  })

  it('applies the pruning rule like the desktop', () => {
    const now = Date.UTC(2026, 10, 18, 23)
    const autos = Array.from({ length: 72 }, (_, h) => ({ versionId: `a${h}`, createdAt: now - h * 60 * MIN }))
    const drop = new Set(autosToPrune(autos, now, 3, 2))
    expect(autos.map((a) => a.versionId).filter((id) => !drop.has(id))).toEqual(['a0', 'a1', 'a2', 'a24'])
  })

  it('keeps making automatic versions after the clock went back', async () => {
    const doc = await savedAt(T0, 'Clock')
    // twelve made while the clock was three hours ahead, the same day
    for (let i = 0; i < 12; i++) {
      vi.setSystemTime(T0 + 3 * 60 * MIN + i * 10 * MIN)
      await storage.saveVersion(doc.id, null)
    }
    // the clock put right: the next timed one is made, and not pruned straight away
    await savedAt(T0 + 15 * MIN, 'Clock', doc)
    const list = await storage.listVersions(doc.id)
    expect(list.some((v) => v.createdAt === T0 + 15 * MIN)).toBe(true)
    // and those are left alone: the ten they had pruned themselves down to, by their own clock
    expect(list.filter((v) => v.createdAt > T0 + 60 * MIN).length).toBe(10)
  })

  it('restoring in the editor is one undo step, and its save is never older than the last', async () => {
    const { getEditor } = await import('../editor/store')
    const { applyVersion } = await import('../editor/panels/applyVersion')
    const doc = emptyDoc('Open')
    const kept = { ...doc, pages: [...doc.pages, { ...doc.pages[0], id: 'p-kept', name: 'Kept page' }] }
    // the clock is an hour behind the last edit
    vi.useFakeTimers({ now: T0, toFake: ['Date'] })
    getEditor().loadDoc({ ...doc, updatedAt: T0 + 60 * MIN })
    applyVersion(kept, 'data:image/jpeg;base64,VVVV')
    const s = getEditor()
    expect(s.doc.pages.map((p) => p.id)).toEqual(kept.pages.map((p) => p.id))
    expect(s.doc.updatedAt).toBeGreaterThan(T0 + 60 * MIN)
    expect(s.doc.thumbnail).toBe('data:image/jpeg;base64,VVVV')
    expect(s.saveState).toBe('unsaved')
    getEditor().undo()
    expect(getEditor().doc.pages.length).toBe(doc.pages.length)
  })

  it('lists the first version of a file once', async () => {
    const doc = await savedAt(T0, 'First of its kind')
    expect(mem.has(`kiln:vlist:${doc.id}`)).toBe(true)
    mem.delete(`kiln:vlist:${doc.id}`) // as if never written, or lost
    vi.setSystemTime(T0 + MIN)
    const named = (await storage.saveVersion(doc.id, 'Second'))!
    const ids = (await storage.listVersions(doc.id)).map((v) => v.versionId)
    expect(ids.length).toBe(2)
    expect(new Set(ids).size).toBe(2)
    expect(ids[0]).toBe(named.versionId)
  })

  it('a damaged version list neither throws nor strands the versions it listed', async () => {
    const doc = await savedAt(T0, 'Damaged list')
    vi.setSystemTime(T0 + MIN)
    const named = (await storage.saveVersion(doc.id, 'Kept'))!
    const docs = () => [...mem.keys()].filter((k) => k.startsWith(`kiln:vdoc:${doc.id}:`)).length
    for (const bad of ['{bad', '{}', '"x"']) {
      mem.set(`kiln:vlist:${doc.id}`, bad)
      const list = await storage.listVersions(doc.id)
      // found again from the stored documents, so they can still be opened, deleted and freed
      expect(list.length).toBe(docs())
      expect(list.some((v) => v.versionId === named.versionId && v.name !== null)).toBe(true)
    }
    vi.setSystemTime(T0 + 2 * MIN)
    await storage.saveVersion(doc.id, 'Another')
    expect((await storage.listVersions(doc.id)).length).toBe(docs())
  })

  it('makes room in old automatic versions when a file save would not fit', async () => {
    for (const k of [...mem.keys()]) if (k.startsWith('kiln:v')) mem.delete(k)
    const doc = await savedAt(T0, 'Crowded')
    for (let i = 1; i <= 3; i++) {
      vi.setSystemTime(T0 + i * MIN)
      await storage.saveVersion(doc.id, null, { ...doc, thumbnail: 'z'.repeat(200_000) })
    }
    quota = used() + 1000
    const bigger = { ...doc, name: 'Crowded ' + 'n'.repeat(5000), updatedAt: T0 + 5 * MIN }
    await expect(storage.save(bigger)).resolves.toBeUndefined()
    expect(stored(doc.id).name).toBe(bigger.name)
  })

  it('restoring through storage refuses when what it replaces cannot be kept', async () => {
    const doc = await savedAt(T0, 'Mine')
    vi.setSystemTime(T0 + MIN)
    const v = (await storage.saveVersion(doc.id, 'Old'))!
    await savedAt(T0 + 2 * MIN, 'Newer work', doc)
    // no automatic version to drop either: only named ones are left for this file
    for (const a of (await storage.listVersions(doc.id)).filter((x) => x.name === null)) await storage.deleteVersion(doc.id, a.versionId)
    quota = used() + 50
    vi.setSystemTime(T0 + 3 * MIN)
    await expect(storage.restoreVersion(doc.id, v.versionId)).rejects.toThrow(/storage/)
    expect(stored(doc.id).name).toBe('Newer work')
  })
})
