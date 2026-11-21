import { describe, expect, it } from 'vitest'
import { produce } from 'immer'
import { createNode, createToken, emptyDoc, solidFill } from './factory'
import { contrastRatio, runReview, type ReviewRule } from './review'
import type { KDoc, KNode } from './types'

/** A page with one white 400×400 artboard; `add` puts layers inside it. Every layer gets a real name. */
function build(make: (board: KNode, add: (n: KNode, parent?: KNode) => KNode, doc: KDoc) => void) {
  const doc = emptyDoc('Review')
  doc.tokens = [] // each test adds the tokens it needs
  const page = doc.pages[0]
  const board = createNode('frame', page.id, { name: 'Home', width: 400, height: 400, fills: [solidFill('#FFFFFF')] })
  doc.nodes[board.id] = board
  page.children = [board.id]
  const add = (n: KNode, parent: KNode = board) => {
    n.parentId = parent.id
    doc.nodes[n.id] = n
    parent.children.push(n.id)
    return n
  }
  make(board, add, doc)
  return doc
}
const text = (content: string, patch: Partial<KNode['text']> = {}, node: Partial<KNode> = {}) => {
  const n = createNode('text', 'p', { name: content, ...node })
  n.text = { ...n.text!, content, ...patch }
  return n
}
const rulesOf = (doc: KDoc, rule: ReviewRule) => runReview(doc).filter((i) => i.rule === rule)

describe('design review', () => {
  it('a clean document has no issues', () => {
    const doc = build((_b, add) => void add(text('Hello', { color: '#141413' })))
    expect(runReview(doc)).toEqual([])
  })

  it('contrast: flags light grey body text on white, using the nearest solid fill and tokens', () => {
    const doc = build((board, add, d) => {
      add(text('Faint', { color: '#BBBBBB', fontSize: 14 }))
      // large bold text only needs 3:1: #888 on white is ~3.5:1
      add(text('Big', { color: '#888888', fontSize: 20, fontWeight: 700 }))
      // a token resolving to near-white, on a dark card: fine
      const light = createToken('text/on-dark', '#F5F5F5')
      d.tokens.push(light)
      const card = add(createNode('frame', board.pageId, { name: 'Card', fills: [solidFill('#111111')] }))
      add(text('On dark', { color: '#000000', tokenId: light.id }), card)
      // the same grey, but inside a frame whose top fill is a gradient: contrast unknown, skipped
      const hero = add(createNode('frame', board.pageId, { name: 'Hero', fills: [{ ...solidFill('#000'), type: 'linear', stops: [] }] }))
      add(text('Over gradient', { color: '#BBBBBB' }), hero)
    })
    const issues = rulesOf(doc, 'contrast')
    expect(issues.map((i) => doc.nodes[i.nodeId].name)).toEqual(['Faint'])
    expect(issues[0].message).toMatch(/needs 4.5:1/)
    expect(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(21)
  })

  it('tap targets: a small button-named frame and a filled frame with one text child', () => {
    const doc = build((board, add) => {
      add(createNode('frame', board.pageId, { name: 'Primary button', width: 120, height: 32, fills: [solidFill('#FF5B1F')] }))
      const chip = add(createNode('frame', board.pageId, { name: 'Tag', width: 40, height: 40, fills: [solidFill('#EEEEEE')] }))
      add(text('New', { color: '#141413' }), chip)
      add(createNode('frame', board.pageId, { name: 'Big button', width: 160, height: 48, fills: [solidFill('#FF5B1F')] }))
      // a row of links is not itself a target
      add(createNode('frame', board.pageId, { name: 'Nav links', width: 200, height: 20, fills: [] }))
    })
    expect(rulesOf(doc, 'tap-target').map((i) => doc.nodes[i.nodeId].name)).toEqual(['Primary button', 'Tag'])
  })

  it('tap targets: uses the measured size when given', () => {
    const doc = build((board, add) => void add(createNode('frame', board.pageId, { name: 'Link', width: 10, height: 10, widthMode: 'hug', heightMode: 'hug', fills: [solidFill('#EEE')] })))
    const link = Object.values(doc.nodes).find((n) => n.name === 'Link')!
    expect(runReview(doc, undefined, { size: (id) => (id === link.id ? { w: 80, h: 48 } : null) }).filter((i) => i.rule === 'tap-target')).toEqual([])
  })

  it('off-token: a solid fill equal to a token value, and the fix applies the token', () => {
    const doc = build((board, add, d) => {
      d.tokens.push(createToken('brand/ember', '#ff5b1f'))
      add(createNode('rect', board.pageId, { name: 'Swatch', fills: [solidFill('#FF5B1F')] }))
    })
    const [issue] = rulesOf(doc, 'off-token')
    expect(issue.message).toContain('brand/ember')
    const fixed = produce(doc, (d) => issue.fix!(d))
    expect(fixed.nodes[issue.nodeId].fills[0].tokenId).toBe(doc.tokens[0].id)
    expect(rulesOf(fixed, 'off-token')).toEqual([])
  })

  it('unnamed: default names, with a name suggested from the text inside', () => {
    const doc = build((board, add) => {
      const f = add(createNode('frame', board.pageId, { name: 'Frame 12', fills: [solidFill('#EEEEEE')] }))
      add(text('Get started', { color: '#141413' }), f)
      add(createNode('rect', board.pageId, { name: 'Rectangle 3' }))
      add(createNode('rect', board.pageId, { name: 'Divider' }))
    })
    const issues = rulesOf(doc, 'unnamed')
    expect(issues.map((i) => doc.nodes[i.nodeId].name)).toEqual(['Frame 12', 'Rectangle 3'])
    const fixed = produce(doc, (d) => issues[0].fix!(d))
    expect(fixed.nodes[issues[0].nodeId].name).toBe('Get started')
    expect(issues[1].fix).toBeUndefined()
  })

  it('alt text: images with empty alt', () => {
    const doc = build((board, add) => {
      add(createNode('image', board.pageId, { name: 'Team photo', image: { src: 'x.png', fit: 'cover', alt: ' ' } }))
      add(createNode('image', board.pageId, { name: 'Logo', image: { src: 'y.png', fit: 'cover', alt: 'Kiln logo' } }))
    })
    const issues = rulesOf(doc, 'alt-text')
    expect(issues).toHaveLength(1)
    const fixed = produce(doc, (d) => issues[0].fix!(d))
    expect(fixed.nodes[issues[0].nodeId].image?.alt).toBe('Team photo')
  })

  it('overflow: long text in a fixed-size box, not in a hug-height one', () => {
    const long = 'A sentence that goes on for a while and will need several lines at this width. '.repeat(3)
    const doc = build((_b, add) => {
      add(text(long, { color: '#141413', fontSize: 16, lineHeight: 1.5 }, { name: 'Body fixed', widthMode: 'fixed', heightMode: 'fixed', width: 200, height: 24 }))
      add(text(long, { color: '#141413', fontSize: 16, lineHeight: 1.5 }, { name: 'Body hug', widthMode: 'fixed', heightMode: 'hug', width: 200, height: 24 }))
      add(text('Short', { color: '#141413', fontSize: 16, lineHeight: 1.5 }, { name: 'Short', widthMode: 'fixed', heightMode: 'fixed', width: 200, height: 24 }))
    })
    const issues = rulesOf(doc, 'overflow')
    expect(issues.map((i) => doc.nodes[i.nodeId].name)).toEqual(['Body fixed'])
    const fixed = produce(doc, (d) => issues[0].fix!(d))
    expect(fixed.nodes[issues[0].nodeId].heightMode).toBe('hug')
  })

  it('hidden or empty: hidden layers (not what is inside them) and frames that draw nothing', () => {
    const doc = build((board, add) => {
      const old = add(createNode('frame', board.pageId, { name: 'Old hero', visible: false }))
      add(text('Inside hidden', { color: '#EEEEEE' }), old)
      add(createNode('frame', board.pageId, { name: 'Stray', fills: [] }))
      add(createNode('frame', board.pageId, { name: 'Panel', fills: [solidFill('#F0F0F0')] }))
    })
    const issues = rulesOf(doc, 'hidden-empty')
    expect(issues.map((i) => doc.nodes[i.nodeId].name)).toEqual(['Old hero', 'Stray'])
    // nothing inside the hidden frame is reviewed (its faint text would fail contrast)
    expect(rulesOf(doc, 'contrast')).toEqual([])
    // deleting the stray empty frame unlinks it from its parent
    const stray = issues[1]
    const fixed = produce(doc, (d) => stray.fix!(d))
    expect(fixed.nodes[stray.nodeId]).toBeUndefined()
    expect(fixed.nodes[doc.pages[0].children[0]].children).not.toContain(stray.nodeId)
  })

  it('hidden or empty: layout spacers are not reported', () => {
    const doc = build((board, add) => {
      const row = add(createNode('frame', board.pageId, { name: 'Row', fills: [] }))
      row.layout = { ...row.layout, mode: 'flex' }
      add(createNode('text', board.pageId, { name: 'Left' }), row)
      add(createNode('frame', board.pageId, { name: 'Spacer', fills: [], widthMode: 'fixed', width: 24 }), row)
      add(createNode('frame', board.pageId, { name: 'Grow', fills: [], widthMode: 'fill' }))
    })
    expect(rulesOf(doc, 'hidden-empty')).toEqual([])
  })

  it('scopes to one page when given a pageId', () => {
    const doc = build((board, add) => void add(createNode('rect', board.pageId, { name: 'Rectangle' })))
    expect(runReview(doc, 'no-such-page')).toEqual([])
    expect(runReview(doc, doc.pages[0].id)).toHaveLength(1)
  })
})
