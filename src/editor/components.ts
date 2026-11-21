/**
 * Components and instances.
 *
 * A main component is an ordinary layer tree whose root has `main: true`. An instance is a real
 * copy of that tree (so the canvas, NodeView and codegen need nothing new) in which every layer
 * has `source`: the id of the main's layer it mirrors. An instance root is a layer whose source
 * is a main root.
 *
 * Keeping instances in step: `syncInstances(prev, next)` runs inside every store update. For
 * each main layer that changed, it merges the change into each layer mirroring it, three-way:
 * a property the instance still has at the main's old value takes the new value; one the
 * instance changed (an override) is kept. Plain objects (text, layout, image…) merge key by
 * key, so changing the main's font size still reaches an instance whose words were changed.
 * Children follow too: added in the main → copied in, removed → removed, reordered → reordered.
 * Deleting a main detaches its instances (they keep their look).
 */
import type { Draft } from 'immer'
import { produce } from 'immer'
import type { KDoc, KNode } from './types'
import { uid } from './factory'
import { getEditor } from './store'

/** Never copied from a main into its instances. */
const NEVER = new Set(['id', 'parentId', 'pageId', 'children', 'source', 'main', 'name'])
/** Also kept on an instance root: where the instance sits is its own. */
const ROOT_OWN = new Set(['x', 'y', 'positioning'])

type Rec = Record<string, unknown>
const isPlain = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Deep equality for layer values. Ids inside values (fill and shadow ids) are ignored: they
 * identify a row in its own list, so an instance's fills equal the main's when they look the same.
 */
export function sameValue(a: unknown, b: unknown, depth = 0): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const bb = b as unknown[]
    return a.length === bb.length && a.every((x, i) => sameValue(x, bb[i], depth + 1))
  }
  const x = a as Rec
  const y = b as Rec
  for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
    if (depth > 0 && k === 'id') continue
    if (!sameValue(x[k], y[k], depth + 1)) return false
  }
  return true
}

/* ------------------------------------------------------------------ queries */

export const isMain = (doc: KDoc, id: string) => !!doc.nodes[id]?.main
/** An instance root: a layer mirroring a main root. */
export function isInstance(doc: KDoc, id: string) {
  const s = doc.nodes[id]?.source
  return !!s && !!doc.nodes[s]?.main
}
/** The instance root a layer belongs to (itself included), if any. */
export function instanceRootOf(doc: KDoc, id: string): KNode | undefined {
  for (let n: KNode | undefined = doc.nodes[id]; n; n = n.parentId ? doc.nodes[n.parentId] : undefined) if (isInstance(doc, n.id)) return n
  return undefined
}
/** The main a layer's instance comes from, if it is (inside) an instance. */
export function mainOf(doc: KDoc, id: string): KNode | undefined {
  const r = instanceRootOf(doc, id)
  return r ? doc.nodes[r.source!] : undefined
}
/** The main root a layer belongs to (itself included), if it is part of a main component. */
export function mainRootOf(doc: KDoc, id: string): KNode | undefined {
  for (let n: KNode | undefined = doc.nodes[id]; n; n = n.parentId ? doc.nodes[n.parentId] : undefined) if (n.main) return n
  return undefined
}
export const instancesOf = (doc: KDoc, mainId: string) => Object.values(doc.nodes).filter((n) => n.source === mainId)
export const mainsOf = (doc: KDoc) => Object.values(doc.nodes).filter((n) => n.main)

/* ------------------------------------------------------------------ copying */

/** Copy a main layer (and what is inside it) as instance layers: new ids, `source` set. */
function cloneAsInstance(doc: KDoc, mainNodeId: string, parentId: string | null, pageId: string, out: KNode[]): string {
  const src = doc.nodes[mainNodeId]
  const copy: KNode = JSON.parse(JSON.stringify(src))
  copy.id = uid()
  copy.parentId = parentId
  copy.pageId = pageId
  delete copy.main
  copy.source = src.id
  out.push(copy)
  copy.children = src.children.filter((c) => doc.nodes[c]).map((c) => cloneAsInstance(doc, c, copy.id, pageId, out))
  return copy.id
}

function removeDeep(d: Draft<KDoc>, id: string) {
  const n = d.nodes[id]
  if (!n) return
  for (const c of n.children) removeDeep(d, c)
  delete d.nodes[id]
}

/* ------------------------------------------------------------------ sync */

/** Three-way merge of one main layer's change (was → now) into a layer mirroring it. */
function merge(target: Rec, was: Rec, now: Rec, skip?: Set<string>) {
  for (const k of new Set([...Object.keys(was), ...Object.keys(now)])) {
    if (skip?.has(k)) continue
    const a = was[k]
    const b = now[k]
    if (a === b) continue
    const cur = target[k]
    if (isPlain(a) && isPlain(b) && isPlain(cur)) merge(cur, a, b)
    else if (sameValue(cur, a)) {
      if (b === undefined) delete target[k]
      else target[k] = b
    }
  }
}

/** Make an instance layer's children follow the main's: added, removed and reordered. */
function syncChildren(d: Draft<KDoc>, next: KDoc, inst: Draft<KNode>, was: KNode, now: KNode) {
  const before = new Set(was.children)
  const after = new Set(now.children)
  const mine = [...inst.children]
  const bySource = new Map<string, string>()
  for (const c of mine) {
    const s = d.nodes[c]?.source
    if (s && !bySource.has(s)) bySource.set(s, c)
  }
  const out: string[] = []
  for (const k of now.children) {
    const have = bySource.get(k)
    if (have) out.push(have)
    else if (!before.has(k)) {
      // new in the main: copy it in
      const made: KNode[] = []
      const id = cloneAsInstance(next, k, inst.id, inst.pageId, made)
      for (const m of made) d.nodes[m.id] = m as Draft<KNode>
      out.push(id)
    }
    // else: the instance deleted it, an override that stays
  }
  for (const c of mine) {
    const s = d.nodes[c]?.source
    if (s && before.has(s) && !after.has(s)) removeDeep(d, c) // removed from the main
    else if (!s || !after.has(s) || bySource.get(s) !== c) out.push(c) // the instance's own layers stay, at the end
  }
  if (out.length !== mine.length || out.some((c, i) => c !== mine[i])) inst.children = out
}

/** What a sync did that the person should hear about. */
type Report = { loops: number; detached: number }

function clearSource(d: Draft<KDoc>, id: string) {
  const n = d.nodes[id]
  if (!n) return
  delete n.source
  n.children.forEach((c) => clearSource(d, c))
}

/**
 * Detach instances that would hold themselves: an instance of M inside M's own tree, or inside
 * a main that M (through the instances it holds) already holds. Syncing those copies the
 * instance into itself, pass after pass.
 */
function breakLoops(prev: KDoc, doc: KDoc, report: Report): KDoc {
  const held: { id: string; inside: string; of: string }[] = []
  for (const id in doc.nodes) {
    const n = doc.nodes[id]
    if (!n.source || !n.parentId || !doc.nodes[n.source]?.main) continue
    const x = mainRootOf(doc, n.parentId)
    if (x) held.push({ id, inside: x.id, of: n.source })
  }
  if (!held.length) return doc
  const holds = new Map<string, Set<string>>() // main → the mains it holds instances of
  for (const h of held) (holds.get(h.inside) ?? holds.set(h.inside, new Set()).get(h.inside)!).add(h.of)
  const reaches = (from: string, to: string, seen: Set<string>): boolean => {
    if (from === to) return true
    if (seen.has(from)) return false
    seen.add(from)
    return [...(holds.get(from) ?? [])].some((m) => reaches(m, to, seen))
  }
  const bad = held.filter((h) => reaches(h.of, h.inside, new Set()))
  if (!bad.length) return doc
  // a loop always has a link this edit made (older ones were broken when made): cut only those
  const isNew = (h: (typeof held)[number]) => prev.nodes[h.id]?.source !== h.of || mainRootOf(prev, h.id)?.id !== h.inside
  const cut = bad.some(isNew) ? bad.filter(isNew) : bad
  report.loops += cut.length
  return produce(doc, (d) => {
    for (const h of cut) clearSource(d, h.id)
  })
}

/** One pass: spread what changed in mains between prev and next into their instances. */
function syncOnce(prev: KDoc, next: KDoc, report: Report): KDoc {
  if (prev.nodes === next.nodes) return next
  const changed: string[] = []
  for (const id in next.nodes) if (next.nodes[id] !== prev.nodes[id]) changed.push(id)
  for (const id in prev.nodes) if (!next.nodes[id]) changed.push(id)
  const relevant = changed.filter((id) => mainRootOf(next, id) || mainRootOf(prev, id))
  if (!relevant.length) return next
  next = breakLoops(prev, next, report)

  const mirrors = new Map<string, string[]>()
  for (const id in next.nodes) {
    const s = next.nodes[id].source
    if (s) (mirrors.get(s) ?? mirrors.set(s, []).get(s)!).push(id)
  }
  return produce(next, (d) => {
    for (const id of relevant) {
      const was = prev.nodes[id]
      const now = next.nodes[id]
      if (!was || !now) continue
      for (const iid of mirrors.get(id) ?? []) {
        const inst = d.nodes[iid]
        if (!inst) continue
        merge(inst as unknown as Rec, was as unknown as Rec, now as unknown as Rec, now.main ? new Set([...NEVER, ...ROOT_OWN]) : NEVER)
        if (was.children !== now.children) syncChildren(d, next, inst, was, now)
      }
    }
    // layers mirroring something deleted from a main (a deleted main, say) are detached
    for (const id in next.nodes) {
      const s = next.nodes[id].source
      if (s && prev.nodes[s] && !next.nodes[s] && d.nodes[id]) {
        delete d.nodes[id].source
        if (prev.nodes[s].main) report.detached++
      }
    }
  })
}

/**
 * Spread main changes between `prev` and `next` into instances. Returns `next` itself when no
 * main changed. Runs a few passes, so an instance placed inside another main reaches that
 * main's instances in the same step.
 */
export function syncInstances(prev: KDoc, next: KDoc): KDoc {
  const report: Report = { loops: 0, detached: 0 }
  let base = prev
  let cur = next
  for (let i = 0; i < 4; i++) {
    const out = syncOnce(base, cur, report)
    if (out === cur) break
    base = cur
    cur = out
  }
  const say: string[] = []
  if (report.loops) say.push('An instance can’t go inside its own component, so it was detached.')
  if (report.detached) say.push(`${report.detached} instance${report.detached > 1 ? 's' : ''} detached because their main was deleted.`)
  // after the store has taken the update (and after a "Cut" toast from the same action)
  if (say.length) queueMicrotask(() => getEditor().notify(say.join(' ')))
  return cur
}

/* ------------------------------------------------------------------ paste */

/** Where cut-and-pasted mains went in this session: an old main layer id → the layer pasted for it. */
const moved = new Map<string, string>()

/**
 * Fix the component links of freshly pasted layers (pre-order, as cloneSubtree gives them) for
 * `doc`, the file they go into. A copy of a main whose main is gone (cut, or from another file)
 * becomes the main itself, and later pastes of it become its instances; any other link to a
 * layer that isn't there is dropped. Changes `nodes` in place.
 */
export function relinkPasted(doc: KDoc, nodes: KNode[], fromMain: (pastedId: string) => boolean) {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const promote = (n: KNode) => {
    if (n.source) moved.set(n.source, n.id)
    delete n.source
    for (const c of n.children) {
      const k = byId.get(c)
      if (k) promote(k)
    }
  }
  for (const n of nodes) {
    const s = n.source
    if (!s || doc.nodes[s]) continue
    const to = moved.get(s)
    if (to && doc.nodes[to]) n.source = to
    else if (fromMain(n.id)) {
      promote(n)
      n.main = true
    } else delete n.source
  }
}

/* ------------------------------------------------------------------ editing (one undo step each) */

/** Why a layer can't become a main component, or null when it can. */
export function cannotMakeComponent(doc: KDoc, id: string): string | null {
  const n = doc.nodes[id]
  if (!n) return 'Select a layer first.'
  if (n.main) return `“${n.name}” is already a component.`
  if (n.parentId && mainRootOf(doc, n.parentId)) return 'This layer is inside a component. Make the outer layer a component instead.'
  const r = instanceRootOf(doc, id)
  if (r && r.id !== id) return 'This layer is inside an instance. Detach the instance first.'
  const inside = (x: string): boolean => doc.nodes[x]?.children.some((c) => doc.nodes[c]?.main || inside(c)) ?? false
  if (inside(id)) return 'This layer holds a component. Components inside components aren’t supported yet.'
  return null
}

/** Turn a layer into a main component (an instance is detached first). Returns false when it can't. */
export function makeComponent(id: string): boolean {
  const s = getEditor()
  const why = cannotMakeComponent(s.doc, id)
  if (why) {
    s.notify(why)
    return false
  }
  s.update((d) => {
    clearSource(d, id)
    d.nodes[id].main = true
  })
  return true
}

/**
 * Insert an instance of a main: top-level on `pageId` at (x, y), or inside `parentId`.
 * Returns the new instance root's id.
 */
export function createInstance(mainId: string, at: { pageId: string; x: number; y: number; parentId?: string | null }): string | null {
  const s = getEditor()
  const main = s.doc.nodes[mainId]
  if (!main?.main) return null
  if (at.parentId && mainRootOf(s.doc, at.parentId)?.id === mainId) {
    s.notify('An instance can’t go inside its own component.')
    return null
  }
  const made: KNode[] = []
  const rootId = cloneAsInstance(s.doc, mainId, at.parentId ?? null, at.pageId, made)
  const root = made.find((n) => n.id === rootId)!
  root.x = Math.round(at.x)
  root.y = Math.round(at.y)
  root.positioning = 'auto'
  // a main sized to fill its parent keeps its width and height as a free-standing copy
  if (!at.parentId) {
    if (root.widthMode === 'fill') root.widthMode = 'fixed'
    if (root.heightMode === 'fill') root.heightMode = 'fixed'
  }
  s.insertNodes(made, [rootId], at.parentId ?? null)
  s.set({ selection: [rootId] })
  return rootId
}

/** Unlink an instance (the one the layer is in) from its main; it keeps its look. */
export function detach(id: string): boolean {
  const s = getEditor()
  const r = instanceRootOf(s.doc, id)
  if (!r) return false
  s.update((d) => clearSource(d, r.id))
  return true
}

/**
 * Put an instance layer (and everything inside it) back to how its main is: properties and
 * children. Where an instance root sits, and layer names, stay.
 */
export function resetOverrides(id: string): boolean {
  const s = getEditor()
  const doc = s.doc
  const n = doc.nodes[id]
  const m = n?.source ? doc.nodes[n.source] : undefined
  if (!n || !m) return false
  const own = isInstance(doc, id) ? new Set([...NEVER, ...ROOT_OWN]) : NEVER
  s.update((d) => {
    const x = d.nodes[id] as unknown as Rec
    const main = m as unknown as Rec
    for (const k of new Set([...Object.keys(x), ...Object.keys(main)])) {
      if (own.has(k)) continue
      if (main[k] === undefined) delete x[k]
      else if (!sameValue(x[k], main[k])) x[k] = JSON.parse(JSON.stringify(main[k]))
    }
    const target = d.nodes[id]
    for (const c of target.children) removeDeep(d, c)
    const made: KNode[] = []
    target.children = m.children.filter((c) => doc.nodes[c]).map((c) => cloneAsInstance(doc, c, id, target.pageId, made))
    for (const k of made) d.nodes[k.id] = k as Draft<KNode>
  })
  return true
}
