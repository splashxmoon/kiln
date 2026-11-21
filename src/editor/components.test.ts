import { beforeEach, describe, expect, it } from 'vitest'
import { getEditor } from './store'
import { createNode, emptyDoc, solidFill } from './factory'
import { createInstance, detach, instanceRootOf, instancesOf, isInstance, isMain, mainOf, makeComponent, resetOverrides, syncInstances } from './components'
import { copySelection, handlePaste } from './commands'
import type { KDoc, KNode } from './types'

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

  it('refuses a component inside a component, and leaves documents without mains alone', () => {
    expect(makeComponent(ids.label)).toBe(false)
    const d = doc()
    const plain = { ...d, nodes: { ...d.nodes } }
    expect(syncInstances(d, d)).toBe(d)
    expect(syncInstances(d, plain)).toBe(plain)
  })
})
