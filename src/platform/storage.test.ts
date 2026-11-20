import { beforeAll, describe, expect, it, vi } from 'vitest'
import { DOC_VERSION, NewerFileError } from '../editor/migrate'
import { emptyDoc } from '../editor/factory'
import type { KDoc } from '../editor/types'

// The wrapper every load and save goes through, over the browser's localStorage backend
// (node has no indexedDB, so that is the one it picks), backed here by a Map.
let storage: typeof import('./storage').storage
const mem = new Map<string, string>()

beforeAll(async () => {
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    key: (i: number) => [...mem.keys()][i] ?? null,
    get length() {
      return mem.size
    },
    clear: () => mem.clear(),
  })
  storage = (await import('./storage')).storage
})

const stored = (id: string) => JSON.parse([...mem.entries()].find(([k]) => k.endsWith(id))![1])

describe('storage wrapper', () => {
  it('stamps the current version on save', async () => {
    const doc = { ...emptyDoc('Old'), version: undefined } as KDoc
    await storage.save(doc)
    expect(stored(doc.id).version).toBe(DOC_VERSION)
  })

  it('migrates on load', async () => {
    const doc = emptyDoc('Legacy')
    await storage.save(doc)
    const key = [...mem.keys()].find((k) => k.endsWith(doc.id))!
    const raw = JSON.parse(mem.get(key)!)
    delete raw.version
    delete raw.tokens
    mem.set(key, JSON.stringify(raw))
    const loaded = await storage.load(doc.id)
    expect(loaded?.version).toBe(DOC_VERSION)
    expect(loaded?.tokens).toEqual([])
  })

  it('refuses to save over a file from a newer Kiln', async () => {
    const doc = { ...emptyDoc('Future'), version: DOC_VERSION + 1 }
    await expect(storage.save(doc)).rejects.toBeInstanceOf(NewerFileError)
    expect([...mem.keys()].some((k) => k.endsWith(doc.id))).toBe(false)
  })
})
