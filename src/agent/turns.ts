/**
 * Agent turns in the undo history.
 *
 * 1. One undo per turn. While a turn runs (store.agentTurn is set), every undo step the agent's
 *    tools push is noted. When the turn ends, if only the agent edited, its steps fold into one,
 *    so a single undo takes the whole turn back. If the person edited (or undid) during the turn,
 *    the steps stay separate so their own edits keep their own undo steps.
 * 2. "Revert this turn". Each finished turn keeps the document from before and after it.
 *    `revertTurn()` puts back only what the agent changed, layer by layer, and leaves alone
 *    anything changed since (by the person or a later turn). It is one undoable step itself.
 *
 * It watches the store instead of being called from each provider, so in-app runs, CLI agents
 * and terminal agents over MCP (Editor.tsx's bridge) are all covered the same way.
 */
import { useSyncExternalStore } from 'react'
import type { Draft } from 'immer'
import { getEditor, useEditor } from '../editor/store'
import type { KDoc } from '../editor/types'

/* ------------------------------------------------------------------ who is writing */

let writing = 0
/** Wrap an agent tool's run: undo steps pushed meanwhile count as the agent's. */
export async function asAgent<T>(fn: () => Promise<T>): Promise<T> {
  writing++
  try {
    return await fn()
  } finally {
    writing--
  }
}

/* ------------------------------------------------------------------ finished turns */

export interface TurnRecord {
  /** the turn's agentTurn.startedAt */
  id: number
  provider: string
  before: KDoc
  after: KDoc
  /** layers the agent's own edits touched during the turn */
  agentIds: string[]
  /** layers the person touched during the turn (their edits, undo or redo): never reverted */
  personIds: string[]
  /** layers the agent added, changed or removed */
  changed: number
  reverted: boolean
  /** the document just before the revert, so an undo of the revert un-marks it */
  preRevert?: KDoc
}

/** the last few turns that changed the document, oldest first */
let turns: TurnRecord[] = []
const KEEP = 20
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export function getTurn(id: number | undefined) {
  return id === undefined ? undefined : turns.find((t) => t.id === id)
}

/** The turn record for a turn id, re-rendering when it changes (e.g. once reverted). */
export function useTurn(id: number | undefined) {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => getTurn(id),
  )
}

/** The most recent finished turn that changed the document, if it is the given turn. */
export const lastTurnId = () => turns[turns.length - 1]?.id

/** Count layers whose content differs between two documents (immer keeps unchanged ones identical). */
export function changedLayers(a: KDoc, b: KDoc) {
  return changedIds(a, b).length
}

/** The layers that differ between two documents (immer keeps unchanged ones identical). */
function changedIds(a: KDoc, b: KDoc): string[] {
  if (a.nodes === b.nodes) return []
  const out: string[] = []
  for (const id in a.nodes) if (a.nodes[id] !== b.nodes[id]) out.push(id)
  for (const id in b.nodes) if (!(id in a.nodes)) out.push(id)
  return out
}

/* ------------------------------------------------------------------ watching the store */

interface Open {
  id: number
  provider: string
  before: KDoc
  /** the first undo entry the agent pushed in this turn (the doc as the turn found it) */
  firstEntry: KDoc | null
  agentEdits: boolean
  /** the person edited, undid or redid during the turn */
  foreign: boolean
  agentIds: Set<string>
  personIds: Set<string>
}
let open: Open | null = null

/**
 * The same document content. Undo and redo hand back a history entry restamped (store.ts), a new
 * object over the same pages, layers, tokens and comments, so identity alone would miss it.
 */
function sameDoc(a: KDoc | undefined, b: KDoc) {
  return a === b || (!!a && a.id === b.id && a.name === b.name && a.pages === b.pages && a.nodes === b.nodes && a.tokens === b.tokens && a.comments === b.comments)
}

function onStoreChange(s: ReturnType<typeof getEditor>, prev: ReturnType<typeof getEditor>) {
  // a turn ends, or hands straight over to another (a terminal agent's turn, then one sent here)
  if (open && s.agentTurn?.startedAt !== open.id) {
    const t = open
    open = null
    finish(t)
  }
  // a turn starts
  if (s.agentTurn && !open) {
    open = { id: s.agentTurn.startedAt, provider: s.agentTurn.provider, before: s.doc, firstEntry: null, agentEdits: false, foreign: false, agentIds: new Set(), personIds: new Set() }
  }
  if (open && s.doc !== prev.doc && s.doc.id === prev.doc.id) {
    // whose edit was it, and which layers did it touch (the store records the undo step and the
    // new doc in separate updates, so this goes by who is writing; undo and redo are the person's)
    const into = writing > 0 ? open.agentIds : open.personIds
    for (const id of changedIds(prev.doc, s.doc)) into.add(id)
  }
  // undo history moved during the turn: whose was it?
  if (open && s.history !== prev.history) {
    const a = s.history.past
    const b = prev.history.past
    // a new step: the list got longer, or stayed at the limit with a new last entry
    const grew = a.length > b.length || (a.length === b.length && a.at(-1) !== b.at(-1))
    const undoOrRedo = s.history.future.length !== prev.history.future.length && s.history.future.length > 0
    if (undoOrRedo) open.foreign = true
    else if (grew) {
      if (writing > 0) {
        open.agentEdits = true
        open.firstEntry ??= s.history.past.at(-1) ?? null
      } else open.foreign = true
    }
  }
  // undoing a revert brings the turn's changes back: it can be reverted again
  if (s.doc !== prev.doc && turns.some((t) => t.reverted && sameDoc(t.preRevert, s.doc))) {
    turns = turns.map((t) => (t.reverted && sameDoc(t.preRevert, s.doc) ? { ...t, reverted: false, preRevert: undefined } : t))
    emit()
  }
}

function finish(t: Open) {
  const s = getEditor()
  if (!t.agentEdits || sameDoc(s.doc, t.before) || s.doc.id !== t.before.id) return
  // fold the agent's steps into one: keep history up to and including the doc the turn started from
  if (!t.foreign && t.firstEntry) {
    const past = s.history.past
    const at = past.lastIndexOf(t.firstEntry)
    if (at >= 0 && at < past.length - 1) s.set({ history: { past: past.slice(0, at + 1), future: [], lastKey: null, lastTime: 0 } })
  }
  const agentIds = [...t.agentIds].filter((id) => t.before.nodes[id] !== s.doc.nodes[id])
  const changed = agentIds.filter((id) => !t.personIds.has(id)).length
  if (!changed) return
  turns = [...turns, { id: t.id, provider: t.provider, before: t.before, after: s.doc, agentIds, personIds: [...t.personIds], changed, reverted: false }].slice(-KEEP)
  emit()
}

useEditor.subscribe(onStoreChange)

/** Forget all turns, and any turn still open (a different document was opened). */
useEditor.subscribe((s, prev) => {
  if (s.doc.id !== prev.doc.id && (turns.length || open)) {
    turns = []
    open = null
    emit()
  }
})

/* ------------------------------------------------------------------ revert */

export interface RevertResult {
  /** layers put back as they were before the turn */
  restored: number
  /** layers the agent changed that were changed again since, so left as they are */
  kept: number
}

/**
 * Three-way revert at layer level: for each layer the agent's edits touched (before → after),
 * put back `before` only if the layer is still exactly as the agent left it and the person
 * didn't touch it during the turn. A frame that holds a layer being kept stays too when
 * reverting it would remove the frame or take the layer out of it (the layer would jump, or
 * be left in a loop). Page layer lists, tokens, comments and the file name go back the same
 * way. Then links are repaired. Returns null when there is nothing left to revert.
 */
export function revertTurn(id: number): RevertResult | null {
  const t = getTurn(id)
  if (!t || t.reverted) return null
  const { before, after } = t
  const cur = getEditor().doc
  const person = new Set(t.personIds)
  const isKept = (nid: string) => person.has(nid) || cur.nodes[nid] !== after.nodes[nid]

  // frames that must stay because a layer inside them is kept (by the agent's change or the person's)
  const held = new Set<string>()
  const keptLayers = [...t.agentIds.filter(isKept), ...t.personIds].filter((nid) => cur.nodes[nid])
  for (const nid of keptLayers) {
    let child = nid
    for (let p = cur.nodes[nid]?.parentId ?? null; p && cur.nodes[p]; child = p, p = cur.nodes[p].parentId) {
      if (held.has(p)) break
      const b = before.nodes[p]
      if (!b || !b.children.includes(child)) held.add(p)
    }
  }

  const restore: string[] = []
  let kept = 0
  for (const nid of t.agentIds) {
    if (before.nodes[nid] === after.nodes[nid]) continue
    if (isKept(nid) || held.has(nid)) kept++
    else restore.push(nid)
  }

  // pages: per page; added ones go, removed ones come back
  let pages: KDoc['pages'] | null = null
  if (before.pages !== after.pages) {
    const next = [...cur.pages]
    for (const bp of before.pages) {
      const ap = after.pages.find((p) => p.id === bp.id)
      const i = next.findIndex((p) => p.id === bp.id)
      if (!ap) {
        if (i < 0) next.splice(Math.min(before.pages.indexOf(bp), next.length), 0, bp)
      } else if (ap !== bp && i >= 0 && next[i] === ap) next[i] = bp
    }
    for (const ap of after.pages) {
      if (before.pages.some((p) => p.id === ap.id)) continue
      const i = next.findIndex((p) => p.id === ap.id)
      if (i >= 0 && next[i] === ap) next.splice(i, 1)
    }
    if (next.length && (next.length !== cur.pages.length || next.some((p, i) => p !== cur.pages[i]))) pages = next
  }
  const tokens = before.tokens !== after.tokens && cur.tokens === after.tokens
  const comments = before.comments !== after.comments && cur.comments === after.comments
  const name = before.name !== after.name && cur.name === after.name
  // nothing left as the agent made it (all changed or undone since): no empty undo step
  if (!restore.length && !pages && !tokens && !comments && !name) return { restored: 0, kept }

  getEditor().update((d: Draft<KDoc>) => {
    for (const nid of restore) {
      // a copy: the stored layer is frozen by immer, and repairLinks may still write its links
      const b = before.nodes[nid]
      if (b) d.nodes[nid] = { ...b, children: [...b.children] } as Draft<KDoc['nodes'][string]>
      else delete d.nodes[nid]
    }
    // copies, for the same reason: these are frozen pages, not drafts
    if (pages) d.pages = pages.map((p) => ({ ...p, children: [...p.children] })) as Draft<KDoc['pages']>
    if (tokens) d.tokens = before.tokens as Draft<KDoc['tokens']>
    if (comments) d.comments = before.comments as Draft<KDoc['comments']>
    if (name) d.name = before.name
    repairLinks(d)
  })
  const s = getEditor()
  const pageId = s.doc.pages.some((p) => p.id === s.pageId) ? s.pageId : s.doc.pages[0]?.id
  s.set({ selection: s.selection.filter((x) => s.doc.nodes[x]), pageId })
  turns = turns.map((x) => (x.id === id ? { ...x, reverted: true, preRevert: cur } : x))
  emit()
  return { restored: restore.length, kept }
}

/**
 * Make parent/child links agree after a partial revert: drop child ids that no longer exist,
 * re-attach layers whose parent (or page) no longer lists them, and lift layers whose parent is
 * gone to the top of their page.
 */
export function repairLinks(d: Draft<KDoc>) {
  const nodes = d.nodes
  // only touch lists that are actually wrong, so untouched layers keep their identity (and don't re-render)
  const prune = (list: string[], ok: (c: string) => boolean) => (list.every(ok) ? list : list.filter(ok))
  for (const n of Object.values(nodes)) {
    const next = prune(n.children, (c) => !!nodes[c] && nodes[c].parentId === n.id)
    if (next !== n.children) n.children = next
  }
  for (const p of d.pages) {
    const next = prune(p.children, (c) => !!nodes[c] && nodes[c].parentId === null && nodes[c].pageId === p.id)
    if (next !== p.children) p.children = next
  }
  for (const n of Object.values(nodes)) {
    // write only what is wrong, so layers left as they are keep their identity
    if (n.parentId && !nodes[n.parentId]) n.parentId = null
    if (n.parentId) {
      const parent = nodes[n.parentId]
      if (!parent.children.includes(n.id)) parent.children.push(n.id)
    } else {
      const page = d.pages.find((p) => p.id === n.pageId) ?? d.pages[0]
      if (!page) continue
      if (n.pageId !== page.id) n.pageId = page.id
      if (!page.children.includes(n.id)) page.children.push(n.id)
    }
  }
}
