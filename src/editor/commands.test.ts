import { beforeEach, describe, expect, it } from 'vitest'
import { getEditor } from './store'
import { createNode, emptyDoc, solidFill } from './factory'
import { runCommand } from './commands'
import type { KDoc } from './types'

/** A text layer bound to a colour token, a plain text layer and a filled rectangle. */
function setup() {
  const doc: KDoc = emptyDoc('Paste')
  const page = doc.pages[0]
  const bound = createNode('text', page.id, { name: 'Bound' })
  bound.text!.tokenId = 'tok'
  const plain = createNode('text', page.id, { name: 'Plain' })
  plain.text!.color = '#ff0000'
  const box = createNode('rect', page.id, { name: 'Box', fills: [solidFill('#00ff00')] })
  for (const n of [bound, plain, box]) doc.nodes[n.id] = n
  page.children = [bound.id, plain.id, box.id]
  getEditor().loadDoc(doc)
  return { bound: bound.id, plain: plain.id, box: box.id }
}

const copyFrom = (id: string) => {
  getEditor().select([id])
  runCommand('edit.copyStyle')
}
const pasteOnto = (id: string) => {
  getEditor().select([id])
  runCommand('edit.pasteStyle')
}
const node = (id: string) => getEditor().doc.nodes[id]

describe('paste properties', () => {
  let ids: ReturnType<typeof setup>
  beforeEach(() => {
    ids = setup()
  })

  it('a plain text colour replaces a token-bound one', () => {
    copyFrom(ids.plain)
    pasteOnto(ids.bound)
    expect(node(ids.bound).text?.tokenId).toBeUndefined()
    expect(node(ids.bound).text?.color).toBe('#ff0000')
  })

  it("a text layer's colour becomes a shape's fill, so the shape stays visible", () => {
    copyFrom(ids.plain)
    pasteOnto(ids.box)
    expect(node(ids.box).fills).toHaveLength(1)
    expect(node(ids.box).fills[0].color).toBe('#ff0000')
  })

  it("a shape's fill becomes a text layer's colour", () => {
    copyFrom(ids.box)
    pasteOnto(ids.plain)
    expect(node(ids.plain).text?.color).toBe('#00ff00')
  })
})
