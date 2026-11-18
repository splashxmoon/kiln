import { describe, expect, it } from 'vitest'
import { exportNode, exportTokensCSS } from './index'
import { createNode, emptyDoc } from '../editor/factory'
import type { KDoc, KNode } from '../editor/types'

/** A 400×240 card: a vertical flex frame with a title and a filled box, one fill on a token. */
function cardDoc(): { doc: KDoc; cardId: string } {
  const doc = emptyDoc('Test')
  const page = doc.pages[0]
  const ember = doc.tokens.find((t) => t.name === 'ember')!
  const card = createNode('frame', page.id, {
    name: 'Product card',
    width: 400,
    height: 240,
    layout: { ...createNode('frame', page.id).layout, mode: 'flex', direction: 'column', gap: 12, padding: [24, 24, 24, 24] },
  })
  const title = createNode('text', page.id, { name: 'Title', parentId: card.id })
  title.text = { ...title.text!, content: 'Morning cup', fontSize: 20 }
  const swatch = createNode('rect', page.id, {
    name: 'Swatch',
    parentId: card.id,
    width: 80,
    height: 40,
    fills: [{ type: 'solid', color: '#FF5B1F', opacity: 1, visible: true, tokenId: ember.id } as KNode['fills'][number]],
  })
  card.children = [title.id, swatch.id]
  page.children = [card.id]
  for (const n of [card, title, swatch]) doc.nodes[n.id] = n
  return { doc, cardId: card.id }
}

const file = (res: ReturnType<typeof exportNode>, ext: string) => res.files.find((f) => f.path.endsWith(ext))?.contents ?? ''

describe('codegen', () => {
  it('exports HTML with the text, a flex column and its gap', () => {
    const { doc, cardId } = cardDoc()
    const res = exportNode(doc, cardId, 'html')
    const html = file(res, '.html')
    const css = file(res, '.css')
    expect(html).toContain('Morning cup')
    expect(css).toMatch(/display:\s*flex/)
    expect(css).toMatch(/flex-direction:\s*column/)
    expect(css).toMatch(/gap:\s*12px/)
  })

  it('uses the token as a CSS variable when the doc has tokens', () => {
    const { doc, cardId } = cardDoc()
    const css = file(exportNode(doc, cardId, 'html'), '.css')
    expect(css).toContain('var(--ember')
    expect(exportTokensCSS(doc)).toMatch(/--ember:\s*#FF5B1F/i)
  })

  it('names the React component after the layer', () => {
    const { doc, cardId } = cardDoc()
    const res = exportNode(doc, cardId, 'react')
    expect(res.files.some((f) => f.path.includes('ProductCard'))).toBe(true)
    expect(file(res, '.tsx')).toMatch(/export default function ProductCard/)
  })

  it('exports Tailwind classes for the layout', () => {
    const { doc, cardId } = cardDoc()
    const tsx = file(exportNode(doc, cardId, 'tailwind'), '.tsx')
    expect(tsx).toContain('flex-col')
    expect(tsx).toMatch(/gap-(3|\[12px\])/)
  })

  it('gives the same output for the same document (snapshot)', () => {
    const { doc, cardId } = cardDoc()
    // ids are random per run; give them fixed names so the snapshot is stable
    const ids = Object.keys(doc.nodes)
    const fixed = JSON.parse(ids.reduce((s, id, i) => s.split(id).join(`n${i}`), JSON.stringify(doc))) as KDoc
    const res = exportNode(fixed, `n${ids.indexOf(cardId)}`, 'html')
    expect(res.files.map((f) => [f.path, f.contents])).toMatchSnapshot()
  })
})
