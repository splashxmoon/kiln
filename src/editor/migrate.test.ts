import { describe, expect, it } from 'vitest'
import { DOC_VERSION, isNewerThanApp, migrate, UnreadableFileError, versionToSave } from './migrate'
import { emptyDoc } from './factory'
import type { KDoc } from './types'

/** A file as Kiln saved it before versioning, with the gaps old builds could leave. */
function legacyFile() {
  return {
    id: 'legacy1',
    name: 'Old file',
    createdAt: 1,
    updatedAt: 2,
    pages: [{ id: 'p1', name: 'Page 1', children: ['a', 'ghost'], background: '#fff' }],
    nodes: {
      a: { id: 'a', type: 'frame', name: 'Board', pageId: 'p1', parentId: null, children: ['b', 'gone'], fills: [], shadows: [] },
      b: { id: 'b', type: 'rect', name: 'Box', pageId: 'p1', parentId: 'a' }, // no children / fills / shadows
      orphan: { id: 'orphan', type: 'rect', name: 'Lost', pageId: 'p1', parentId: 'deleted', children: [] },
    },
    // no tokens, no comments
  }
}

describe('migrate', () => {
  it('upgrades a file from before versioning to the current version', () => {
    const doc = migrate(legacyFile())
    expect(doc.version).toBe(DOC_VERSION)
    expect(doc.tokens).toEqual([])
    expect(doc.comments).toEqual([])
  })

  it('fills in arrays old builds left out', () => {
    const b = migrate(legacyFile()).nodes.b
    expect(b.children).toEqual([])
    expect(b.fills).toEqual([])
    expect(b.shadows).toEqual([])
  })

  it('drops links to layers that no longer exist', () => {
    const doc = migrate(legacyFile())
    expect(doc.pages[0].children).toEqual(['a'])
    expect(doc.nodes.a.children).toEqual(['b'])
    expect(doc.nodes.orphan.parentId).toBeNull()
  })

  it('never changes the object it was given', () => {
    const raw = legacyFile()
    const before = JSON.stringify(raw)
    migrate(raw)
    expect(JSON.stringify(raw)).toBe(before)
  })

  it('returns a current file as it is', () => {
    const doc = emptyDoc('Fresh')
    expect(doc.version).toBe(DOC_VERSION)
    expect(migrate(doc)).toBe(doc)
  })

  it('opens a file from a newer Kiln without touching it, and flags it', () => {
    const newer = { ...emptyDoc(), version: DOC_VERSION + 5, futureField: { x: 1 } }
    const doc = migrate(newer)
    expect(doc).toBe(newer)
    expect(isNewerThanApp(doc)).toBe(true)
    expect(versionToSave(doc)).toBe(DOC_VERSION + 5) // an older app never relabels it
  })

  it('stamps the current version on save for old files', () => {
    expect(versionToSave({ ...emptyDoc(), version: undefined } as KDoc)).toBe(DOC_VERSION)
  })

  it('refuses things that are not Kiln files', () => {
    expect(() => migrate(null)).toThrow(UnreadableFileError)
    expect(() => migrate([])).toThrow(UnreadableFileError)
    expect(() => migrate({ name: 'no id' })).toThrow(UnreadableFileError)
  })
})
