import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getEditor } from './store'
import { createNode, emptyDoc, solidFill } from './factory'
import { createInstance, detach, instanceRootOf, instancesOf, isInstance, isMain, mainOf, makeComponent, resetOverrides, syncInstances } from './components'
import { copySelection, handlePaste } from './commands'
import type { KDoc, KNode } from './types'

/** Rendered sizes, as the canvas would measure them (there is no canvas in these tests). */
const sizes: Record<string, { w: number; h: number }> = {}
vi.mock('./geometry', async (orig) => ({
  ...(await orig<typeof import('./geometry')>()),
  measureSize: (id: string) => sizes[id] ?? null,
}))

/** A page with a "Button" frame holding a "Label" text. */
function setup() {
  const doc: KDoc = emptyDoc('Components')
  const page = doc.pages[0]
  const button = createNode('frame', page.id, { name: 'Button', x: 0, y: 0, width: 120, height: 44, fills: [solidFill('#FF5B1F')] })
  const label = createNode('text', page.id, { name: 'Label', parentId: button.id })
  label.text = { ...label.text!, content: 'Buy', fontSize: 14 }
  button.children = [label.id]
  doc.nodes[button.id] = button
  doc.nodes[label.id] = label
  page.children = [button.id]
  getEditor().loadDoc(doc)
  // as in a real session: the doc comes out of immer frozen, and history starts clean
  getEditor().update((d) => void (d.name = 'Components test'))
  getEditor().set({ history: { past: [], future: [], lastKey: null, lastTime: 0 } })
  return { button: button.id, label: label.id, pageId: page.id }
}

const doc = () => getEditor().doc
const node = (id: string) => doc().nodes[id]
const set = (id: string, fn: (n: KNode) => void) => getEditor().update((d) => fn(d.nodes[id] as KNode))
/** The instance layer mirroring a main layer, inside instance `root`. */
const mirror = (root: string, mainLayer: string): KNode => {
  const walk = (id: string): KNode | undefined => {
    const n = node(id)
    if (n.source === mainLayer) return n
    for (const c of n.children) {
      const hit = walk(c)
      if (hit) return hit
    }
  }
  return walk(root)!
}

describe('components', () => {
  let ids: ReturnType<typeof setup>
  let inst: string
  beforeEach(() => {
    ids = setup()
    expect(makeComponent(ids.button)).toBe(true)
    inst = createInstance(ids.button, { pageId: ids.pageId, x: 200, y: 0 })!
  })
  // after every test: no layer lost, orphaned or listed twice
  afterEach(() => sound())

  it('makes a main and inserts an instance: a real copy linked to it', () => {
    expect(isMain(doc(), ids.button)).toBe(true)
    expect(isInstance(doc(), inst)).toBe(true)
    expect(mainOf(doc(), inst)?.id).toBe(ids.button)
    expect(node(inst).x).toBe(200)
    expect(node(inst).main).toBeUndefined()
    expect(mirror(inst, ids.label).text?.content).toBe('Buy')
    expect(instancesOf(doc(), ids.button).map((n) => n.id)).toEqual([inst])
    expect(doc().pages[0].children).toEqual([ids.button, inst])
  })

  it('spreads a main fill change into instances', () => {
    set(ids.button, (n) => void (n.fills[0].color = '#141413'))
    expect(node(inst).fills[0].color).toBe('#141413')
  })

  it('keeps an instance override when the main changes', () => {
    const label = mirror(inst, ids.label).id
    set(label, (n) => void (n.text!.content = 'Add to bag'))
    set(inst, (n) => void (n.fills[0].color = '#2255FF'))
    // the main changes the same things, and something else
    set(ids.label, (n) => {
      n.text!.content = 'Purchase'
      n.text!.fontSize = 16
    })
    set(ids.button, (n) => {
      n.fills[0].color = '#141413'
      n.height = 48
    })
    expect(node(label).text?.content).toBe('Add to bag') // override kept
    expect(node(label).text?.fontSize).toBe(16) // the rest of the text style follows
    expect(node(inst).fills[0].color).toBe('#2255FF') // override kept
    expect(node(inst).height).toBe(48)
    // where the instance sits is its own
    set(ids.button, (n) => void (n.x = 50))
    expect(node(inst).x).toBe(200)
  })

  it('spreads a child added to or removed from the main', () => {
    const icon = createNode('rect', ids.pageId, { name: 'Icon', parentId: ids.button, width: 16, height: 16 })
    getEditor().update((d) => {
      d.nodes[icon.id] = icon
      d.nodes[ids.button].children.unshift(icon.id)
    })
    const kids = node(inst).children.map((c) => node(c).source)
    expect(kids).toEqual([icon.id, ids.label])
    expect(node(node(inst).children[0]).parentId).toBe(inst)

    getEditor().update((d) => {
      d.nodes[ids.button].children = d.nodes[ids.button].children.filter((c) => c !== icon.id)
      delete d.nodes[icon.id]
    })
    expect(node(inst).children.map((c) => node(c).source)).toEqual([ids.label])
    expect(Object.values(doc().nodes).filter((n) => n.source === icon.id)).toEqual([])
  })

  it('resets overrides', () => {
    const label = mirror(inst, ids.label).id
    set(label, (n) => void (n.text!.content = 'Mine'))
    set(inst, (n) => void (n.fills[0].color = '#2255FF'))
    // and an instance-only layer that reset takes out
    const extra = createNode('rect', ids.pageId, { name: 'Extra', parentId: inst })
    getEditor().update((d) => {
      d.nodes[extra.id] = extra
      d.nodes[inst].children.push(extra.id)
    })
    resetOverrides(inst)
    expect(node(inst).fills[0].color).toBe('#FF5B1F')
    expect(node(inst).x).toBe(200)
    expect(mirror(inst, ids.label).text?.content).toBe('Buy')
    expect(node(label)).toBeUndefined() // replaced by a fresh copy
    expect(node(extra.id)).toBeUndefined()
    expect(node(inst).children).toHaveLength(1)
  })

  it('detaches an instance: it keeps its look and stops following', () => {
    detach(mirror(inst, ids.label).id) // from a layer inside it
    expect(isInstance(doc(), inst)).toBe(false)
    expect(instanceRootOf(doc(), inst)).toBeUndefined()
    set(ids.button, (n) => void (n.fills[0].color = '#141413'))
    expect(node(inst).fills[0].color).toBe('#FF5B1F')
  })

  it('deleting the main detaches its instances', () => {
    getEditor().update((d) => {
      d.pages[0].children = d.pages[0].children.filter((c) => c !== ids.button)
      delete d.nodes[ids.label]
      delete d.nodes[ids.button]
    })
    expect(node(inst)).toBeDefined()
    expect(node(inst).source).toBeUndefined()
    expect(node(inst).children.every((c) => node(c).source === undefined)).toBe(true)
    expect(node(inst).fills[0].color).toBe('#FF5B1F')
  })

  it('a main edit and its spread are one undo step', () => {
    const steps = getEditor().history.past.length
    set(ids.button, (n) => void (n.fills[0].color = '#141413'))
    expect(getEditor().history.past.length).toBe(steps + 1)
    getEditor().undo()
    expect(node(ids.button).fills[0].color).toBe('#FF5B1F')
    expect(node(inst).fills[0].color).toBe('#FF5B1F')
  })

  it('duplicating a main makes an instance; duplicating an instance keeps it one', () => {
    getEditor().select([ids.button])
    const [copy] = getEditor().duplicateSelection()
    expect(isInstance(doc(), copy)).toBe(true)
    expect(node(copy).main).toBeUndefined()
    getEditor().select([inst])
    const [copy2] = getEditor().duplicateSelection()
    expect(mainOf(doc(), copy2)?.id).toBe(ids.button)
    set(ids.button, (n) => void (n.fills[0].color = '#141413'))
    expect(node(copy).fills[0].color).toBe('#141413')
    expect(node(copy2).fills[0].color).toBe('#141413')
  })

  it('an instance put inside its own main is detached instead of copying itself', async () => {
    const inst2 = createInstance(ids.button, { pageId: ids.pageId, x: 400, y: 0 })!
    const count = () => Object.keys(doc().nodes).length
    // inserting one straight into its main is refused
    expect(createInstance(ids.button, { pageId: ids.pageId, x: 0, y: 0, parentId: ids.button })).toBeNull()
    expect(count()).toBe(6)
    // moving one in (layers panel, agent move_node) detaches it: one layer tree, mirrored once into the other instance
    getEditor().update((d) => {
      d.pages[0].children = d.pages[0].children.filter((c) => c !== inst)
      d.nodes[inst].parentId = ids.button
      d.nodes[ids.button].children.push(inst)
    })
    expect(count()).toBe(8)
    expect(node(inst).source).toBeUndefined()
    expect(node(node(inst).children[0]).source).toBeUndefined()
    expect(node(inst2).children.map((c) => node(c).source)).toEqual([ids.label, inst])
    await Promise.resolve()
    expect(getEditor().toast?.text).toMatch(/inside its own component/)
  })

  it('an instance loop through two mains is detached too', () => {
    const card = createNode('frame', ids.pageId, { name: 'Card', x: 0, y: 200, width: 200, height: 100 })
    getEditor().update((d) => {
      d.nodes[card.id] = card
      d.pages[0].children.push(card.id)
    })
    makeComponent(card.id)
    const inCard = createInstance(ids.button, { pageId: ids.pageId, x: 0, y: 0, parentId: card.id })!
    expect(isInstance(doc(), inCard)).toBe(true) // a Button inside a Card is fine
    const count = Object.keys(doc().nodes).length
    const loop = createInstance(card.id, { pageId: ids.pageId, x: 0, y: 0, parentId: ids.button })!
    expect(isInstance(doc(), loop)).toBe(false) // a Card inside the Button is not: that link is cut…
    expect(isInstance(doc(), inCard)).toBe(true) // …and the Button inside the Card stays an instance
    // the detached Card tree (3 layers) in the main, mirrored once into each Button instance
    expect(Object.keys(doc().nodes).length).toBe(count + 9)
  })

  it('cut and paste of a main keeps it a component; pasting again makes instances of it', async () => {
    getEditor().select([ids.button])
    await copySelection(true)
    expect(node(ids.button)).toBeUndefined()
    expect(node(inst).source).toBeUndefined() // the old instance is detached…
    await Promise.resolve()
    expect(getEditor().toast?.text).toMatch(/1 instance detached because their main was deleted/)

    // the second paste runs with the first (the main) still selected, as ⌘V ⌘V does: it goes beside it
    const paste = () => {
      void handlePaste({ clipboardData: { files: [], getData: () => '' }, preventDefault() {} } as unknown as ClipboardEvent)
      return getEditor().selection[0]
    }
    const moved = paste()
    expect(isMain(doc(), moved)).toBe(true) // …but the main itself comes back
    expect(node(moved).source).toBeUndefined()
    expect(node(node(moved).children[0]).source).toBeUndefined()
    const again = paste()
    expect(mainOf(doc(), again)?.id).toBe(moved)
    expect(node(again).parentId).toBeNull()
    expect(mirror(again, node(moved).children[0]).text?.content).toBe('Buy')
    set(moved, (n) => void (n.fills[0].color = '#141413'))
    expect(node(again).fills[0].color).toBe('#141413')
  })

  it('a copied instance pasted after its main is gone becomes a plain layer', async () => {
    getEditor().select([inst])
    await copySelection()
    getEditor().update((d) => {
      d.pages[0].children = d.pages[0].children.filter((c) => c !== ids.button)
      delete d.nodes[ids.label]
      delete d.nodes[ids.button]
    })
    getEditor().select([])
    void handlePaste({ clipboardData: { files: [], getData: () => '' }, preventDefault() {} } as unknown as ClipboardEvent)
    const pasted = getEditor().selection[0]
    expect(node(pasted).source).toBeUndefined()
    expect(node(pasted).main).toBeUndefined()
    expect(node(node(pasted).children[0]).source).toBeUndefined()
  })

  it('after a reload, pasting a cut main again makes an instance of the first paste', async () => {
    let clip = ''
    vi.stubGlobal('navigator', { clipboard: { writeText: async (t: string) => void (clip = t) } })
    getEditor().select([ids.button])
    await copySelection(true)
    vi.unstubAllGlobals()
    expect(clip).not.toBe('')
    const ev = () => ({ clipboardData: { files: [], getData: (t: string) => (t === 'text/plain' ? clip : '') }, preventDefault() {} }) as unknown as ClipboardEvent
    getEditor().select([])
    await handlePaste(ev())
    const first = getEditor().selection[0]
    expect(isMain(doc(), first)).toBe(true)
    // reload: fresh modules (nothing in memory), the saved file opened again, the system clipboard still holding the cut
    const saved = doc()
    vi.resetModules()
    const store2 = await import('./store')
    const cmds2 = await import('./commands')
    const comps2 = await import('./components')
    store2.getEditor().loadDoc(saved)
    await cmds2.handlePaste(ev())
    const d2 = store2.getEditor().doc
    const second = store2.getEditor().selection[0]
    expect(comps2.isMain(d2, second)).toBe(false)
    expect(comps2.mainOf(d2, second)?.id).toBe(first)
    expect(comps2.mainsOf(d2)).toHaveLength(1)
  })

  it('keeps an override inside a fill while the main changes another key of that fill', () => {
    set(inst, (n) => void (n.fills[0].color = '#2255FF'))
    set(ids.button, (n) => void (n.fills[0].opacity = 0.5))
    expect(node(inst).fills[0].color).toBe('#2255FF') // override kept
    expect(node(inst).fills[0].opacity).toBe(0.5) // the main's change arrives
  })

  it('an empty text added to a main and then discarded leaves nothing in its instances', () => {
    const t = createNode('text', ids.pageId, { name: 'Empty', parentId: ids.button })
    t.text = { ...t.text!, content: '' }
    getEditor().update((d) => {
      d.nodes[t.id] = t
      d.nodes[ids.button].children.push(t.id)
    })
    expect(node(inst).children).toHaveLength(2)
    getEditor().discardNode(t.id) // what leaving text edit on an empty text does
    expect(node(inst).children).toHaveLength(1)
    expect(Object.values(doc().nodes).filter((n) => n.source === t.id)).toEqual([])
  })

  it('a copy of a layer inside an instance is a plain layer, not a second mirror', async () => {
    const label = mirror(inst, ids.label).id
    getEditor().select([label])
    const [dup] = getEditor().duplicateSelection()
    expect(node(dup).parentId).toBe(inst)
    expect(node(dup).source).toBeUndefined()
    getEditor().select([label])
    await copySelection()
    getEditor().select([])
    void handlePaste({ clipboardData: { files: [], getData: () => '' }, preventDefault() {} } as unknown as ClipboardEvent)
    const pasted = getEditor().selection[0]
    expect(node(pasted).parentId).toBeNull()
    expect(node(pasted).source).toBeUndefined()
    set(ids.label, (n) => void (n.text!.content = 'Purchase'))
    expect(node(label).text?.content).toBe('Purchase') // the real mirror follows
    expect(node(dup).text?.content).toBe('Buy') // the copies don't
    expect(node(pasted).text?.content).toBe('Buy')
  })

  it('undo and redo keep instances in step with their main', () => {
    set(ids.button, (n) => void (n.fills[0].color = '#141413'))
    set(ids.label, (n) => void (n.text!.fontSize = 20))
    getEditor().undo()
    getEditor().undo()
    expect(node(inst).fills[0].color).toBe('#FF5B1F')
    expect(mirror(inst, ids.label).text?.fontSize).toBe(14)
    getEditor().redo()
    getEditor().redo()
    expect(node(inst).fills[0].color).toBe('#141413')
    expect(mirror(inst, ids.label).text?.fontSize).toBe(20)
    // and an edit after an undo still spreads
    getEditor().undo()
    set(ids.label, (n) => void (n.text!.fontSize = 22))
    expect(mirror(inst, ids.label).text?.fontSize).toBe(22)
  })

  it('an instance on another page follows its main, and children added land on its page', () => {
    getEditor().addPage()
    const other = doc().pages.find((p) => p.id !== ids.pageId)!
    const far = createInstance(ids.button, { pageId: other.id, x: 0, y: 0 })!
    expect(node(far).pageId).toBe(other.id)
    const icon = createNode('rect', ids.pageId, { name: 'Icon', parentId: ids.button, width: 16, height: 16 })
    getEditor().update((d) => {
      d.nodes[icon.id] = icon
      d.nodes[ids.button].children.push(icon.id)
    })
    const added = node(far).children.map(node).find((n) => n.source === icon.id)!
    expect(added.pageId).toBe(other.id)
    set(ids.button, (n) => void (n.fills[0].color = '#141413'))
    expect(node(far).fills[0].color).toBe('#141413')
  })

  /** Add a layer to the main (at the end of its children) and return its id. */
  const addToMain = (name: string, type: 'rect' | 'frame' = 'rect') => {
    const n = createNode(type, ids.pageId, { name, parentId: ids.button, width: 16, height: 16 })
    getEditor().update((d) => {
      d.nodes[n.id] = n
      d.nodes[ids.button].children.push(n.id)
    })
    return n.id
  }

  it('wrapping main layers in a frame keeps the instance’s overrides and deletions', () => {
    const icon = addToMain('Icon')
    const label = mirror(inst, ids.label).id
    set(label, (n) => void (n.text!.content = 'Order'))
    getEditor().update((d) => {
      const i = d.nodes[inst].children.find((c) => d.nodes[c].source === icon)!
      d.nodes[inst].children = d.nodes[inst].children.filter((c) => c !== i)
      delete d.nodes[i]
    })
    // the main's Label and Icon go into a new Stack frame
    const stack = createNode('frame', ids.pageId, { name: 'Stack', parentId: ids.button })
    stack.children = [ids.label, icon]
    getEditor().update((d) => {
      d.nodes[stack.id] = stack
      d.nodes[ids.label].parentId = stack.id
      d.nodes[icon].parentId = stack.id
      d.nodes[ids.button].children = [stack.id]
    })
    const st = node(inst).children.map(node)
    expect(st.map((n) => n.source)).toEqual([stack.id])
    expect(node(label).parentId).toBe(st[0].id) // the same layer, moved
    expect(node(label).text?.content).toBe('Order') // its override kept
    expect(st[0].children).toEqual([label]) // the Icon it deleted stays deleted
    expect(Object.values(doc().nodes).filter((n) => n.source === ids.label)).toHaveLength(1)
    // and back out again
    getEditor().update((d) => {
      d.nodes[ids.label].parentId = ids.button
      d.nodes[stack.id].children = [icon]
      d.nodes[ids.button].children = [ids.label, stack.id]
    })
    expect(node(inst).children[0]).toBe(label)
    expect(node(label).text?.content).toBe('Order')
  })

  it('making a component, or detaching, keeps the whole instances inside linked', () => {
    const card = createNode('frame', ids.pageId, { name: 'Card', x: 0, y: 200, width: 200, height: 100 })
    getEditor().update((d) => {
      d.nodes[card.id] = card
      d.pages[0].children.push(card.id)
    })
    const inCard = createInstance(ids.button, { pageId: ids.pageId, x: 0, y: 0, parentId: card.id })!
    makeComponent(card.id)
    expect(mainOf(doc(), inCard)?.id).toBe(ids.button)
    const cardInst = createInstance(card.id, { pageId: ids.pageId, x: 300, y: 200 })!
    const innerButton = node(cardInst).children[0]
    detach(cardInst)
    expect(isInstance(doc(), cardInst)).toBe(false)
    expect(mainOf(doc(), innerButton)?.id).toBe(ids.button) // still a Button
    set(ids.label, (n) => void (n.text!.content = 'Purchase'))
    expect(node(node(innerButton).children[0]).text?.content).toBe('Purchase')
  })

  it('a main set to Fill doesn’t make a free-standing instance fill, nor does Reset', () => {
    const row = createNode('frame', ids.pageId, { name: 'Row', width: 600, height: 60 })
    row.layout = { ...row.layout, mode: 'flex' }
    getEditor().update((d) => {
      d.nodes[row.id] = row
      d.pages[0].children = [row.id, inst]
      row.children = [ids.button]
      d.nodes[ids.button].parentId = row.id
    })
    set(ids.button, (n) => void (n.widthMode = 'fill'))
    expect(node(inst).widthMode).not.toBe('fill')
    resetOverrides(inst)
    expect(node(inst).widthMode).not.toBe('fill')
    // inserted from a Fill main: as wide as the main is drawn
    sizes[ids.button] = { w: 600, h: 44 }
    const fresh = createInstance(ids.button, { pageId: ids.pageId, x: 0, y: 400 })!
    expect(node(fresh).widthMode).toBe('fixed')
    expect(node(fresh).width).toBe(600)
    delete sizes[ids.button]
  })

  it('a layer dragged out of an instance stops following the main', () => {
    const label = mirror(inst, ids.label).id
    getEditor().reparent([label], null, null)
    expect(node(label).parentId).toBeNull()
    expect(node(label).source).toBeUndefined()
    set(ids.label, (n) => void (n.text!.content = 'Purchase'))
    expect(node(label).text?.content).toBe('Buy')
  })

  it('an instance’s own layers keep their place when the main’s children change', () => {
    const icon = addToMain('Icon')
    const [l, i] = node(inst).children
    const badge = createNode('rect', ids.pageId, { name: 'Badge', parentId: inst })
    getEditor().update((d) => {
      d.nodes[badge.id] = badge
      d.nodes[inst].children = [l, badge.id, i]
    })
    getEditor().update((d) => void (d.nodes[ids.button].children = [icon, ids.label])) // the main reorders
    expect(node(inst).children).toEqual([i, l, badge.id])
    const extra = addToMain('Extra')
    expect(node(inst).children.slice(0, 3)).toEqual([i, l, badge.id])
    expect(node(node(inst).children[3]).source).toBe(extra)
  })

  /** Every layer sits in exactly one children list, the one its parentId names, and every listed layer exists. */
  const sound = () => {
    const d = doc()
    const seen = new Map<string, number>()
    const lists = [...d.pages.map((p) => p.children), ...Object.values(d.nodes).map((n) => n.children)]
    for (const l of lists) for (const c of l) seen.set(c, (seen.get(c) ?? 0) + 1)
    for (const [c, k] of seen) expect(k, `${c} listed ${k} times`).toBe(1)
    for (const n of Object.values(d.nodes)) {
      const list = n.parentId ? d.nodes[n.parentId]?.children : d.pages.find((p) => p.id === n.pageId)?.children
      expect(list?.includes(n.id), `${n.name} is in its parent's list`).toBe(true)
    }
  }

  /** Main: Button > Frame F1 > X (a rect). Returns ids. */
  const withFrame = () => {
    const f1 = addToMain('F1', 'frame')
    const x = createNode('rect', ids.pageId, { name: 'X', parentId: f1 })
    getEditor().update((d) => {
      d.nodes[x.id] = x
      d.nodes[f1].children.push(x.id)
    })
    const f1m = node(inst).children.map(node).find((n) => n.source === f1)!.id
    const xm = node(f1m).children[0]
    return { f1, x: x.id, f1m, xm }
  }

  it('removing a frame inside the main keeps the instance’s copy of what was in it', () => {
    const { f1, x, xm } = withFrame()
    set(xm, (n) => void (n.opacity = 0.5)) // an override on it
    getEditor().update((d) => {
      d.nodes[x].parentId = ids.button
      d.nodes[ids.button].children = [ids.label, x]
      delete d.nodes[f1]
    })
    expect(node(xm)).toBeDefined()
    expect(node(xm).parentId).toBe(inst)
    expect(node(xm).opacity).toBe(0.5)
    sound()
  })

  it('a main move of a layer the instance had moved itself leaves it in one place', () => {
    const { x, xm } = withFrame()
    const f2 = addToMain('F2', 'frame')
    // in the instance, X is dragged out of F1 to the instance's top
    getEditor().update((d) => {
      const from = d.nodes[d.nodes[xm].parentId!]
      from.children = from.children.filter((c) => c !== xm)
      d.nodes[xm].parentId = inst
      d.nodes[inst].children.push(xm)
    })
    // the main moves X from F1 into F2
    getEditor().update((d) => {
      const from = d.nodes[d.nodes[x].parentId!]
      from.children = from.children.filter((c) => c !== x)
      d.nodes[x].parentId = f2
      d.nodes[f2].children.push(x)
    })
    sound()
  })

  it('a mirror dragged into another main stops following its own main', () => {
    const card = createNode('frame', ids.pageId, { name: 'Card', x: 0, y: 200, width: 200, height: 100 })
    getEditor().update((d) => {
      d.nodes[card.id] = card
      d.pages[0].children.push(card.id)
    })
    makeComponent(card.id)
    const label = mirror(inst, ids.label).id
    getEditor().reparent([label], card.id, null)
    expect(node(label).parentId).toBe(card.id)
    expect(node(label).source).toBeUndefined()
    set(ids.label, (n) => void (n.text!.content = 'Purchase'))
    expect(node(label).text?.content).toBe('Buy')
    sound()
  })

  it('duplicating a copy of a whole instance inside an instance keeps it an instance', () => {
    const card = createNode('frame', ids.pageId, { name: 'Card', x: 0, y: 200, width: 200, height: 100 })
    getEditor().update((d) => {
      d.nodes[card.id] = card
      d.pages[0].children.push(card.id)
    })
    createInstance(ids.button, { pageId: ids.pageId, x: 0, y: 0, parentId: card.id })
    makeComponent(card.id)
    const cardInst = createInstance(card.id, { pageId: ids.pageId, x: 300, y: 200 })!
    getEditor().select([node(cardInst).children[0]])
    const [dup] = getEditor().duplicateSelection()
    expect(mainOf(doc(), dup)?.id).toBe(ids.button)
    set(ids.label, (n) => void (n.text!.content = 'Purchase'))
    expect(node(node(dup).children[0]).text?.content).toBe('Purchase')
    sound()
  })

  it('cut and paste of a main keeps the instances inside it linked', async () => {
    const card = createNode('frame', ids.pageId, { name: 'Card', x: 0, y: 200, width: 200, height: 100 })
    getEditor().update((d) => {
      d.nodes[card.id] = card
      d.pages[0].children.push(card.id)
    })
    const inCard = createInstance(ids.button, { pageId: ids.pageId, x: 0, y: 0, parentId: card.id })!
    makeComponent(card.id)
    getEditor().select([card.id])
    await copySelection(true)
    getEditor().select([])
    void handlePaste({ clipboardData: { files: [], getData: () => '' }, preventDefault() {} } as unknown as ClipboardEvent)
    const pasted = getEditor().selection[0]
    expect(isMain(doc(), pasted)).toBe(true)
    expect(node(pasted).children[0]).toBe(inCard)
    expect(mainOf(doc(), inCard)?.id).toBe(ids.button)
    set(ids.label, (n) => void (n.text!.content = 'Purchase'))
    expect(node(node(inCard).children[0]).text?.content).toBe('Purchase')
  })

  it('refuses a component inside a component, and leaves documents without mains alone', () => {
    expect(makeComponent(ids.label)).toBe(false)
    const d = doc()
    const plain = { ...d, nodes: { ...d.nodes } }
    expect(syncInstances(d, d)).toBe(d)
    expect(syncInstances(d, plain)).toBe(plain)
  })
})
