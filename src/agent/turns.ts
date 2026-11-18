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
  /** layers the agent added, changed or removed */
  changed: number
  reverted: boolean
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
  let n = 0
  for (const id of new Set([...Object.keys(a.nodes), ...Object.keys(b.nodes)])) if (a.nodes[id] !== b.nodes[id]) n++
  return n
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
}
let open: Open | null = null

function onStoreChange(s: ReturnType<typeof getEditor>, prev: ReturnType<typeof getEditor>) {
  // a turn starts
  if (s.agentTurn && !prev.agentTurn) {
    open = { id: s.agentTurn.startedAt, provider: s.agentTurn.provider, before: s.doc, firstEntry: null, agentEdits: false, foreign: false }
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
  // the turn ends
  if (!s.agentTurn && prev.agentTurn && open) {
    const t = open
    open = null
    finish(t)
  }
}

function finish(t: Open) {
  const s = getEditor()
  if (!t.agentEdits || s.doc === t.before) return
  // fold the agent's steps into one: keep history up to and including the doc the turn started from
  if (!t.foreign && t.firstEntry) {
    const past = s.history.past
    const at = past.lastIndexOf(t.firstEntry)
    if (at >= 0 && at < past.length - 1) s.set({ history: { past: past.slice(0, at + 1), future: [], lastKey: null, lastTime: 0 } })
  }
  turns = [...turns, { id: t.id, provider: t.provider, before: t.before, after: s.doc, changed: changedLayers(t.before, s.doc), reverted: false }].slice(-KEEP)
  emit()
}

useEditor.subscribe(onStoreChange)

/** Forget all turns (a different document was opened). */
useEditor.subscribe((s, prev) => {
  if (s.doc.id !== prev.doc.id && turns.length) {
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
 * Three-way revert at layer level: for each layer the agent changed (before → after), put back
 * `before` only if the layer is still exactly as the agent left it. The same goes for page layer
 * lists, tokens, comments and the file name. Then repair links, so a kept layer is never left
 * hanging off a parent that no longer lists it.
 */
export function revertTurn(id: number): RevertResult | null {
  const t = getTurn(id)
  if (!t || t.reverted) return null
  const { before, after } = t
  const cur = getEditor().doc
  let restored = 0
  let kept = 0
  getEditor().update((d: Draft<KDoc>) => {
    for (const nid of new Set([...Object.keys(before.nodes), ...Object.keys(after.nodes)])) {
      if (before.nodes[nid] === after.nodes[nid]) continue
      if (cur.nodes[nid] !== after.nodes[nid]) {
        kept++
        continue
      }
      restored++
      // a copy: the stored layer is frozen by immer, and repairLinks may still write its links
      const b = before.nodes[nid]
      if (b) d.nodes[nid] = { ...b, children: [...b.children] } as Draft<KDoc['nodes'][string]>
      else delete d.nodes[nid]
    }
    // pages: per page; added ones go, removed ones come back
    if (before.pages !== after.pages) {
      const pages = [...cur.pages]
      for (const bp of before.pages) {
        const ap = after.pages.find((p) => p.id === bp.id)
        const i = pages.findIndex((p) => p.id === bp.id)
        if (!ap) {
          if (i < 0) pages.splice(Math.min(before.pages.indexOf(bp), pages.length), 0, bp)
        } else if (ap !== bp && i >= 0 && pages[i] === ap) pages[i] = bp
      }
      for (const ap of after.pages) {
        if (before.pages.some((p) => p.id === ap.id)) continue
        const i = pages.findIndex((p) => p.id === ap.id)
        if (i >= 0 && pages[i] === ap) pages.splice(i, 1)
      }
      // copies, for the same reason: these are frozen pages, not drafts
      if (pages.length) d.pages = pages.map((p) => ({ ...p, children: [...p.children] })) as Draft<KDoc['pages']>
    }
    if (before.tokens !== after.tokens && cur.tokens === after.tokens) d.tokens = before.tokens as Draft<KDoc['tokens']>
    if (before.comments !== after.comments && cur.comments === after.comments) d.comments = before.comments as Draft<KDoc['comments']>
    if (before.name !== after.name && cur.name === after.name) d.name = before.name
    repairLinks(d)
  })
  const s = getEditor()
  const pageId = s.doc.pages.some((p) => p.id === s.pageId) ? s.pageId : s.doc.pages[0]?.id
  s.set({ selection: s.selection.filter((x) => s.doc.nodes[x]), pageId })
  turns = turns.map((x) => (x.id === id ? { ...x, reverted: true } : x))
  emit()
  return { restored, kept }
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
