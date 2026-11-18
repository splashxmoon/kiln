import { beforeEach, describe, expect, it } from 'vitest'
import { getEditor } from '../editor/store'
import { createNode, emptyDoc } from '../editor/factory'
import { asAgent, getTurn, lastTurnId, revertTurn } from './turns'
import type { KDoc } from '../editor/types'

/** A page with two boxes, a and b. */
function setup() {
  const doc: KDoc = emptyDoc('Turns')
  const page = doc.pages[0]
  const a = createNode('rect', page.id, { name: 'A', x: 0 })
  const b = createNode('rect', page.id, { name: 'B', x: 200 })
  doc.nodes[a.id] = a
  doc.nodes[b.id] = b
  page.children = [a.id, b.id]
  getEditor().loadDoc(doc)
  // one ordinary edit, as in a real session, so every layer and page comes out of immer frozen
  // (revert must not write to them); then a clean history
  getEditor().update((d) => void (d.name = 'Turns test'))
  getEditor().set({ history: { past: [], future: [], lastKey: null, lastTime: 0 } })
  expect(Object.isFrozen(getEditor().doc.nodes[a.id])).toBe(true)
  return { a: a.id, b: b.id, pageId: page.id }
}

let clock = 1_000
const startTurn = () => getEditor().set({ agentTurn: { provider: 'Test', startedAt: ++clock, steps: 0 } })
const endTurn = () => getEditor().set({ agentTurn: null })
const agentEdit = (fn: (d: KDoc) => void) => asAgent(async () => getEditor().update((d) => fn(d as KDoc)))
const userEdit = (fn: (d: KDoc) => void) => getEditor().update((d) => fn(d as KDoc))
const node = (id: string) => getEditor().doc.nodes[id]

describe('agent turns in the undo history', () => {
  let ids: ReturnType<typeof setup>
  beforeEach(() => {
    ids = setup()
  })

  it('folds a turn of agent edits into one undo step', async () => {
    startTurn()
    await agentEdit((d) => void (d.nodes[ids.a].x = 10))
    await agentEdit((d) => void (d.nodes[ids.a].name = 'Hero'))
    await agentEdit((d) => void (d.nodes[ids.b].x = 300))
    endTurn()
    expect(getEditor().history.past).toHaveLength(1)
    getEditor().undo()
    expect(node(ids.a).x).toBe(0)
    expect(node(ids.a).name).toBe('A')
    expect(node(ids.b).x).toBe(200)
  })

  it('keeps steps separate when the person edited during the turn', async () => {
    startTurn()
    await agentEdit((d) => void (d.nodes[ids.a].x = 10))
    userEdit((d) => void (d.nodes[ids.b].name = 'Mine'))
    await agentEdit((d) => void (d.nodes[ids.a].x = 20))
    endTurn()
    expect(getEditor().history.past).toHaveLength(3)
  })

  it('records only turns that changed the design', () => {
    const before = lastTurnId()
    startTurn()
    endTurn()
    expect(lastTurnId()).toBe(before)
  })

  it('reverts only what the agent changed, keeping later edits by the person', async () => {
    startTurn()
    await agentEdit((d) => {
      d.nodes[ids.a].x = 10
      d.nodes[ids.b].x = 300
      const c = createNode('rect', ids.pageId, { name: 'C' })
      d.nodes[c.id] = c
      d.pages[0].children.push(c.id)
    })
    endTurn()
    const id = lastTurnId()!
    expect(getTurn(id)?.changed).toBe(3)
    // the person then moves B again
    userEdit((d) => void (d.nodes[ids.b].x = 500))

    const r = revertTurn(id)
    expect(r).toEqual({ restored: 2, kept: 1 })
    expect(node(ids.a).x).toBe(0) // put back
    expect(node(ids.b).x).toBe(500) // the person's edit stays
    const page = getEditor().doc.pages[0]
    expect(page.children).toEqual([ids.a, ids.b]) // the agent's new layer is gone
    expect(Object.keys(getEditor().doc.nodes)).toHaveLength(2)
    expect(getTurn(id)?.reverted).toBe(true)
    expect(revertTurn(id)).toBeNull() // only once

    // reverting is one undo step
    getEditor().undo()
    expect(node(ids.a).x).toBe(10)
    expect(getEditor().doc.pages[0].children).toHaveLength(3)
  })

  it('keeps a layer the person changed even when its parent is reverted', async () => {
    startTurn()
    let childId = ''
    await agentEdit((d) => {
      const c = createNode('rect', ids.pageId, { name: 'Child', parentId: ids.a })
      childId = c.id
      d.nodes[c.id] = c
      d.nodes[ids.a].children.push(c.id)
    })
    endTurn()
    const id = lastTurnId()!
    userEdit((d) => void (d.nodes[childId].name = 'Kept child'))
    revertTurn(id)
    // A is back to how it was, but the child the person renamed stays, still linked to A
    expect(node(childId).name).toBe('Kept child')
    expect(node(ids.a).children).toContain(childId)
  })

  it('keeps a top-level layer the person added during revert, and leaves history alone', async () => {
    startTurn()
    await agentEdit((d) => {
      const c = createNode('rect', ids.pageId, { name: 'Agent C' })
      d.nodes[c.id] = c
      d.pages[0].children.push(c.id)
    })
    endTurn()
    const id = lastTurnId()!
    let mine = ''
    userEdit((d) => {
      const e = createNode('rect', ids.pageId, { name: 'Mine' })
      mine = e.id
      d.nodes[e.id] = e
      d.pages[0].children.push(e.id)
    })
    const past = getEditor().history.past.map((x) => x.pages[0].children.length)
    expect(revertTurn(id)).toEqual({ restored: 1, kept: 0 })
    expect(getEditor().doc.pages[0].children).toEqual([ids.a, ids.b, mine])
    // the stored documents were not changed in place
    expect(getEditor().history.past.slice(0, past.length).map((x) => x.pages[0].children.length)).toEqual(past)
    expect(getTurn(id)?.before.pages[0].children).toEqual([ids.a, ids.b])
  })
})
