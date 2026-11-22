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
import { measureSize } from './geometry'

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

/** Delete a layer and what is inside it; a child already moved elsewhere (its parentId says so) stays. */
function removeDeep(d: Draft<KDoc>, id: string) {
  const n = d.nodes[id]
  if (!n) return
  for (const c of n.children) if (d.nodes[c]?.parentId === id) removeDeep(d, c)
  delete d.nodes[id]
}

/* ------------------------------------------------------------------ sync */

/**
 * Lists that hold the same rows in the same order on all three sides (fills, shadows, radii…), so
 * they can be merged row by row: rows with ids keep their ids, and the instance's own rows
 * line up with the main's.
 */
function sameRows(a: unknown, b: unknown, cur: unknown): a is unknown[] {
  if (!Array.isArray(a) || !Array.isArray(b) || !Array.isArray(cur)) return false
  if (a.length !== b.length || cur.length !== a.length) return false
  const id = (v: unknown) => (isPlain(v) ? v.id : undefined)
  return a.every((x, i) => id(x) === id(b[i]) && id(x) === id(cur[i]))
}

/** Three-way merge of one main layer's change (was → now) into a layer mirroring it. */
function merge(target: Rec, was: Rec, now: Rec, skip?: Set<string>) {
  for (const k of new Set([...Object.keys(was), ...Object.keys(now)])) {
    if (skip?.has(k)) continue
    const a = was[k]
    const b = now[k]
    if (a === b) continue
    const cur = target[k]
    if (isPlain(a) && isPlain(b) && isPlain(cur)) merge(cur, a, b)
    // a change inside one row (a fill's opacity) leaves the instance's change to another key of it (its colour)
    else if (sameRows(a, b, cur)) merge(cur as unknown as Rec, a as unknown as Rec, b as unknown as Rec)
    else if (sameValue(cur, a)) {
      if (b === undefined) delete target[k]
      else target[k] = b
    }
  }
}

/** What one sync pass works from. */
interface Pass {
  prev: KDoc
  next: KDoc
  /** main layer id → the layers mirroring it (in `next`) */
  mirrors: Map<string, string[]>
  /** mirrors taken out of a children list because their main layer moved; removed at the end unless re-homed */
  pending: Set<string>
  /** mirrors of deleted main layers: removed at the end, once what moved out of them has moved */
  doomed: Set<string>
}

/** The instance root a layer belongs to, in the draft. */
function rootIn(d: Draft<KDoc>, id: string): string | undefined {
  for (let n: Draft<KNode> | undefined = d.nodes[id]; n; n = n.parentId ? d.nodes[n.parentId] : undefined) if (n.source && d.nodes[n.source]?.main) return n.id
  return undefined
}

/**
 * The instance's layer for main layer `k`, placed in `parentId`: its existing mirror (moved there,
 * so overrides go with it) when the main moved the layer, a fresh copy when the layer is new, or
 * null when the layer was already in the main and the instance has no mirror of it (deleted there).
 */
function adopt(d: Draft<KDoc>, p: Pass, root: string | undefined, k: string, parentId: string, pageId: string): string | null {
  const have = (p.mirrors.get(k) ?? []).find((m) => d.nodes[m] && rootIn(d, m) === root)
  if (have) {
    const from = d.nodes[have].parentId
    if (from && from !== parentId && d.nodes[from]) d.nodes[from].children = d.nodes[from].children.filter((c) => c !== have)
    d.nodes[have].parentId = parentId
    p.pending.delete(have)
    return have
  }
  const home = mainRootOf(p.next, k)?.id
  if (p.prev.nodes[k] && mainRootOf(p.prev, k)?.id === home) return null
  const src = p.next.nodes[k]
  const copy: KNode = JSON.parse(JSON.stringify(src))
  copy.id = uid()
  copy.parentId = parentId
  copy.pageId = pageId
  delete copy.main
  copy.source = k
  copy.children = src.children.filter((c) => p.next.nodes[c]).flatMap((c) => adopt(d, p, root, c, copy.id, pageId) ?? [])
  d.nodes[copy.id] = copy as Draft<KNode>
  return copy.id
}

/**
 * Make an instance layer's children follow the main's: added, removed, moved and reordered.
 * The instance's own layers stay after the layer they followed.
 */
function syncChildren(d: Draft<KDoc>, p: Pass, inst: Draft<KNode>, was: KNode, now: KNode) {
  const before = new Set(was.children)
  const after = new Set(now.children)
  const mine = [...inst.children]
  const bySource = new Map<string, string>()
  for (const c of mine) {
    const s = d.nodes[c]?.source
    if (s && after.has(s) && !bySource.has(s)) bySource.set(s, c)
  }
  const home = mainRootOf(p.next, now.id)?.id
  // the instance's own layers, by the main layer whose mirror they came after (null: first)
  const ownAfter = new Map<string | null, string[]>()
  let anchor: string | null = null
  for (const c of mine) {
    const s = d.nodes[c]?.source
    if (s && bySource.get(s) === c) anchor = s
    else if (s && before.has(s) && !after.has(s)) {
      // gone from here in the main: moved within it (the mirror moves too), or deleted
      if (p.next.nodes[s] && mainRootOf(p.next, s)?.id === home) p.pending.add(c)
      else p.doomed.add(c)
    } else (ownAfter.get(anchor) ?? ownAfter.set(anchor, []).get(anchor)!).push(c)
  }
  const root = rootIn(d, inst.id)
  const out: string[] = [...(ownAfter.get(null) ?? [])]
  for (const k of now.children) {
    const have = bySource.get(k) ?? (before.has(k) ? null : adopt(d, p, root, k, inst.id, inst.pageId))
    if (have) out.push(have)
    // else: the instance deleted it, an override that stays
    out.push(...(ownAfter.get(k) ?? []))
    ownAfter.delete(k)
  }
  ownAfter.delete(null)
  for (const rest of ownAfter.values()) out.push(...rest) // they followed a layer the main took out
  if (out.length !== mine.length || out.some((c, i) => c !== mine[i])) inst.children = out
}

/** What a sync did that the person should hear about. */
type Report = { loops: number; detached: number }

/**
 * Unlink a layer and what is inside it from the main it mirrors. Whole instances inside stay
 * linked: a real one (mirroring a main root) is left alone, and a mirror of an instance the main
 * holds becomes an instance of that one's main. With `keepInner` false, every link inside goes.
 */
function unlink(d: Draft<KDoc>, id: string, root = true, keepInner = true) {
  const n = d.nodes[id]
  if (!n) return
  const src = n.source ? d.nodes[n.source] : undefined
  if (keepInner && !root && src?.main) return
  if (keepInner && !root && src?.source) n.source = src.source
  else delete n.source
  n.children.forEach((c) => unlink(d, c, false, keepInner))
}

/** An instance root that isn't in an auto-layout frame can't fill: it keeps its own size mode. */
function keepFree(d: Draft<KDoc>, n: Draft<KNode>, w: KNode['widthMode'], h: KNode['heightMode']) {
  const parent = n.parentId ? d.nodes[n.parentId] : undefined
  if (parent?.layout.mode === 'flex') return
  if (n.widthMode === 'fill') n.widthMode = w === 'fill' ? 'fixed' : w
  if (n.heightMode === 'fill') n.heightMode = h === 'fill' ? 'fixed' : h
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
    for (const h of cut) unlink(d, h.id, true, false) // everything inside it too: any of it could close the loop again
  })
}

/** Mirrors this edit moved out of every instance (dragged onto the canvas, say): they stop following. */
function dropStrays(prev: KDoc, next: KDoc, changed: string[]): KDoc {
  const strays = changed.filter((id) => {
    const n = next.nodes[id]
    return !!n?.source && !next.nodes[n.source]?.main && prev.nodes[id]?.parentId !== n.parentId && !instanceRootOf(next, id)
  })
  if (!strays.length) return next
  return produce(next, (d) => {
    for (const id of strays) unlink(d, id)
  })
}

/** One pass: spread what changed in mains between prev and next into their instances. */
function syncOnce(prev: KDoc, next: KDoc, report: Report): KDoc {
  if (prev.nodes === next.nodes) return next
  const changed: string[] = []
  for (const id in next.nodes) if (next.nodes[id] !== prev.nodes[id]) changed.push(id)
  for (const id in prev.nodes) if (!next.nodes[id]) changed.push(id)
  next = dropStrays(prev, next, changed)
  const relevant = changed.filter((id) => mainRootOf(next, id) || mainRootOf(prev, id))
  if (!relevant.length) return next
  next = breakLoops(prev, next, report)

  const mirrors = new Map<string, string[]>()
  for (const id in next.nodes) {
    const s = next.nodes[id].source
    if (s) (mirrors.get(s) ?? mirrors.set(s, []).get(s)!).push(id)
  }
  const pass: Pass = { prev, next, mirrors, pending: new Set(), doomed: new Set() }
  return produce(next, (d) => {
    for (const id of relevant) {
      const was = prev.nodes[id]
      const now = next.nodes[id]
      if (!was || !now) continue
      for (const iid of mirrors.get(id) ?? []) {
        const inst = d.nodes[iid]
        if (!inst) continue
        const { widthMode, heightMode } = inst
        merge(inst as unknown as Rec, was as unknown as Rec, now as unknown as Rec, now.main ? new Set([...NEVER, ...ROOT_OWN]) : NEVER)
        if (now.main) keepFree(d, inst, widthMode, heightMode)
        if (was.children !== now.children) syncChildren(d, pass, inst, was, now)
      }
    }
    // mirrors whose main layer moved somewhere this instance doesn't follow (a part it deleted) go
    for (const id of pass.doomed) removeDeep(d, id)
    for (const id of pass.pending) {
      const n = d.nodes[id]
      if (n && !(n.parentId && d.nodes[n.parentId]?.children.includes(id))) removeDeep(d, id)
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

/**
 * Fix the component links of freshly pasted layers for `doc`, the file they go into. A copy of a
 * main whose main isn't there (it was cut, or comes from another file) becomes that main again
 * and takes back the main's own layer ids, so any later paste of the same clipboard (after a
 * reload too, with nothing kept in memory) finds it and becomes its instance. Any other link to
 * a layer that isn't there is dropped. Changes `nodes` in place and returns the renames
 * (pasted id → id taken back), which the caller applies to its list of roots.
 */
export function relinkPasted(
  doc: KDoc,
  nodes: KNode[],
  fromMain: (pastedId: string) => boolean,
  /** the link the original layer had, for layers copied from inside a main */
  linkOf: (pastedId: string) => string | undefined = () => undefined,
): Map<string, string> {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const rename = new Map<string, string>()
  const taken = new Set<string>()
  const promote = (n: KNode) => {
    const s = n.source
    delete n.source
    const back = linkOf(n.id)
    if (back && doc.nodes[back]) n.source = back // an instance inside the main stays one
    if (s && !doc.nodes[s] && !taken.has(s)) {
      rename.set(n.id, s)
      taken.add(s)
    }
    for (const c of n.children) {
      const k = byId.get(c)
      if (k) promote(k)
    }
  }
  // mains first, so copies of them in the same paste link to them
  for (const n of nodes) {
    if (n.source && !doc.nodes[n.source] && !taken.has(n.source) && fromMain(n.id)) {
      promote(n)
      n.main = true
    }
  }
  for (const n of nodes) if (n.source && !doc.nodes[n.source] && !taken.has(n.source)) delete n.source
  if (rename.size) {
    for (const n of nodes) {
      n.id = rename.get(n.id) ?? n.id
      if (n.parentId) n.parentId = rename.get(n.parentId) ?? n.parentId
      n.children = n.children.map((c) => rename.get(c) ?? c)
    }
  }
  return rename
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
    unlink(d, id)
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
    const drawn = measureSize(mainId)
    if (root.widthMode === 'fill') {
      root.widthMode = 'fixed'
      if (drawn) root.width = Math.round(drawn.w)
    }
    if (root.heightMode === 'fill') {
      root.heightMode = 'fixed'
      if (drawn) root.height = Math.round(drawn.h)
    }
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
  s.update((d) => unlink(d, r.id))
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
    const { widthMode, heightMode } = d.nodes[id]
    const x = d.nodes[id] as unknown as Rec
    const main = m as unknown as Rec
    for (const k of new Set([...Object.keys(x), ...Object.keys(main)])) {
      if (own.has(k)) continue
      if (main[k] === undefined) delete x[k]
      else if (!sameValue(x[k], main[k])) x[k] = JSON.parse(JSON.stringify(main[k]))
    }
    const target = d.nodes[id]
    if (own !== NEVER) keepFree(d, target, widthMode, heightMode) // an instance root
    for (const c of target.children) removeDeep(d, c)
    const made: KNode[] = []
    target.children = m.children.filter((c) => doc.nodes[c]).map((c) => cloneAsInstance(doc, c, id, target.pageId, made))
    for (const k of made) d.nodes[k.id] = k as Draft<KNode>
  })
  return true
}
