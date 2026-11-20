/**
 * File format versions. Every document is run through `migrate()` when it is opened, so a
 * file saved by any older Kiln still opens after the format changes.
 *
 * To change the format: bump DOC_VERSION, add a step to STEPS that turns version N-1 into N
 * (mutating the plain JSON object), and add a test for it in migrate.test.ts. Steps run in
 * order, so each only needs to know about the version just before it.
 */
import type { KDoc } from './types'

export const DOC_VERSION = 1

type Json = Record<string, unknown>
type Step = (doc: Json) => void

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** STEPS[n] upgrades a version-n document to version n+1. */
const STEPS: Step[] = [
  // 0 → 1: documents from before versioning. Fill in arrays older builds sometimes left out,
  // and drop links to layers that no longer exist (a crash mid-edit could leave them), which
  // would otherwise break rendering and code export.
  (doc) => {
    doc.tokens = arr(doc.tokens)
    doc.comments = arr(doc.comments)
    const nodes: Json = isObj(doc.nodes) ? doc.nodes : {}
    doc.nodes = nodes
    for (const [id, n] of Object.entries(nodes)) {
      if (!isObj(n)) {
        delete nodes[id]
        continue
      }
      n.id = id
      n.children = arr(n.children)
      n.fills = arr(n.fills)
      n.shadows = arr(n.shadows)
      if (n.parentId !== null && (typeof n.parentId !== 'string' || !isObj(nodes[n.parentId]))) n.parentId = null
    }
    for (const n of Object.values(nodes) as Json[]) n.children = (n.children as unknown[]).filter((c) => typeof c === 'string' && isObj(nodes[c]))
    doc.pages = arr(doc.pages)
      .filter(isObj)
      .map((p) => ({ ...p, children: arr(p.children).filter((c) => typeof c === 'string' && isObj(nodes[c])) }))
  },
]

if (STEPS.length !== DOC_VERSION) throw new Error('migrate.ts: STEPS must have one step per version')

export class UnreadableFileError extends Error {
  constructor(why: string) {
    super(`This isn't a Kiln file Kiln can open (${why})`)
    this.name = 'UnreadableFileError'
  }
}

/**
 * Bring a stored document up to DOC_VERSION. Takes the raw parsed JSON and returns a new
 * object when anything changed (the input is never modified). A file from a newer Kiln is
 * returned as it is; `isNewerThanApp` marks it read-only (storage refuses to save it).
 */
export function migrate(raw: unknown): KDoc {
  if (!isObj(raw)) throw new UnreadableFileError('not an object')
  if (typeof raw.id !== 'string' || !raw.id) throw new UnreadableFileError('no id')
  const from = typeof raw.version === 'number' && Number.isFinite(raw.version) ? Math.max(0, Math.floor(raw.version)) : 0
  if (from >= DOC_VERSION) return checked(raw)
  const doc = structuredClone(raw)
  for (let v = from; v < DOC_VERSION; v++) {
    STEPS[v](doc)
    doc.version = v + 1
  }
  return checked(doc)
}

/** The least the editor needs to open a file, whatever its version: layers and at least one page. */
function checked(doc: Json): KDoc {
  if (!isObj(doc.nodes)) throw new UnreadableFileError('no layers')
  if (!Array.isArray(doc.pages) || !doc.pages.length || !doc.pages.every(isObj)) throw new UnreadableFileError('no pages')
  return doc as unknown as KDoc
}

/** Saving a file from a newer Kiln would write this version's format under the newer label. */
export class NewerFileError extends Error {
  constructor() {
    super('This file was saved by a newer Kiln. Update Kiln to save changes to it.')
    this.name = 'NewerFileError'
  }
}

/** Saved by a newer Kiln than this one: it opens, but parts of it may not show or survive a save. */
export const isNewerThanApp = (doc: KDoc) => (doc.version ?? 0) > DOC_VERSION
