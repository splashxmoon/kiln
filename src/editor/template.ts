import { h, t, build, type Spec } from './build'
import { emptyDoc, createPage } from './factory'
import type { KDoc, KNode } from './types'

const INK = '#141413'
const BONE = '#EDE7DC'
const PAPER = '#FBF9F5'
const EMBER = '#FF5B1F'
const MUTED = '#6F6A63'
const LINE = '#E6E0D6'

const btn = (label: string, kind: 'primary' | 'ghost' | 'dark' = 'primary') =>
  h(
    'frame',
    {
      name: 'Button',
      flex: 'row',
      pad: [12, 20],
      radius: 999,
      align: 'center',
      gap: 8,
      fill: kind === 'primary' ? EMBER : kind === 'dark' ? INK : null,
      stroke: kind === 'ghost' ? ['#D6CFC3', 1] : undefined,
    },
    [t(label, { size: 14, weight: 600, color: kind === 'ghost' ? INK : '#FFFFFF', name: 'Label' })],
  )

const product = (name: string, price: string, glaze: string, shader: 'aurora' | 'grain' | 'voronoi' | 'ripple', params: Record<string, string>) =>
  h('frame', { name: 'Product card', flex: 'column', gap: 14, w: 'fill' }, [
    h('shader', { name: 'Glaze', w: 'fill', h: 300, radius: 18, shader, shaderParams: params }),
    h('frame', { name: 'Meta', flex: 'row', justify: 'space-between', align: 'start', w: 'fill' }, [
      h('frame', { name: 'Title', flex: 'column', gap: 4 }, [
        t(name, { size: 17, weight: 600, color: INK, ls: -0.01, binding: 'product.name' }),
        t(glaze, { size: 14, color: MUTED, binding: 'product.glaze' }),
      ]),
      t(price, { size: 15, weight: 500, color: INK, font: 'Geist Mono', binding: 'product.price' }),
    ]),
  ])

function desktop(): Spec {
  return h('frame', { name: 'Shop / Desktop', w: 1280, flex: 'column', fill: PAPER, x: 0, y: 0 }, [
    h('frame', { name: 'Nav', flex: 'row', w: 'fill', pad: [22, 56], justify: 'space-between', align: 'center' }, [
      t('Hearth & Clay', { size: 20, weight: 600, font: 'Instrument Serif', color: INK, ls: -0.01, name: 'Wordmark' }),
      h('frame', { name: 'Links', flex: 'row', gap: 32 }, [t('Shop', { size: 14, color: INK }), t('Studio', { size: 14, color: MUTED }), t('Firing log', { size: 14, color: MUTED }), t('Visit', { size: 14, color: MUTED })]),
      h('frame', { name: 'Actions', flex: 'row', gap: 10, align: 'center' }, [t('Cart (2)', { size: 14, color: INK }), btn('Book a class', 'dark')]),
    ]),
    h('frame', { name: 'Hero', flex: 'row', w: 'fill', pad: [24, 56, 72, 56], gap: 48, align: 'end' }, [
      h('frame', { name: 'Copy', flex: 'column', gap: 24, w: 'fill', pad: [0, 0, 8, 0] }, [
        h('frame', { name: 'Eyebrow', flex: 'row', gap: 8, align: 'center', pad: [6, 12], radius: 999, fill: '#FFE9DF' }, [
          h('ellipse', { name: 'Dot', w: 7, h: 7, fill: EMBER }),
          t('Kiln opens Friday · 14 pieces', { size: 13, weight: 500, color: '#B33A0C' }),
        ]),
        t('Stoneware, fired slow and shipped whole.', { size: 68, weight: 400, font: 'Instrument Serif', color: INK, lh: 1, ls: -0.02, w: 'fill', name: 'Headline' }),
        t('Two potters, one wood-fired kiln in the Catskills. Every cup and bowl is thrown by hand and glazed with ash from the last firing.', {
          size: 18,
          color: MUTED,
          lh: 1.55,
          w: 520,
          name: 'Subhead',
        }),
        h('frame', { name: 'CTAs', flex: 'row', gap: 12 }, [btn('Shop the new firing'), btn('How we fire', 'ghost')]),
      ]),
      h('shader', { name: 'Hero glaze', w: 520, h: 560, radius: 28, shader: 'aurora' }),
    ]),
    h('frame', { name: 'Collection', flex: 'column', gap: 28, w: 'fill', pad: [56, 56, 80, 56], fill: '#FFFFFF', stroke: [LINE, 1] }, [
      h('frame', { name: 'Header', flex: 'row', w: 'fill', justify: 'space-between', align: 'end' }, [
        t('The spring firing', { size: 36, font: 'Instrument Serif', color: INK, ls: -0.01 }),
        t('View all 14 →', { size: 14, weight: 500, color: INK }),
      ]),
      h('frame', { name: 'Grid', flex: 'row', gap: 24, w: 'fill' }, [
        product('Morning cup', '$48', 'Shino over iron slip', 'aurora', { c0: '#3B2A4A', c1: '#C9A27E', c2: '#EDE7DC', c3: '#FF5B1F' }),
        product('Serving bowl', '$124', 'Ash glaze, celadon pool', 'voronoi', {}),
        product('Bud vase', '$62', 'Tenmoku, iron spots', 'grain', {}),
      ]),
    ]),
    h('frame', { name: 'Footer', flex: 'row', w: 'fill', pad: [40, 56], justify: 'space-between', align: 'center', fill: INK }, [
      t('Hearth & Clay — Phoenicia, NY', { size: 14, color: '#B8B1A6' }),
      t('Next firing: May 18', { size: 14, color: BONE, font: 'Geist Mono' }),
    ]),
  ])
}

function mobile(): Spec {
  return h('frame', { name: 'Shop / Mobile', w: 390, flex: 'column', fill: PAPER, x: 1380, y: 0, gap: 0 }, [
    h('frame', { name: 'Nav', flex: 'row', w: 'fill', pad: [56, 20, 16, 20], justify: 'space-between', align: 'center' }, [
      t('Hearth & Clay', { size: 19, font: 'Instrument Serif', color: INK }),
      t('Cart (2)', { size: 14, color: INK }),
    ]),
    h('frame', { name: 'Hero', flex: 'column', w: 'fill', pad: [8, 20, 32, 20], gap: 18 }, [
      h('shader', { name: 'Hero glaze', w: 'fill', h: 320, radius: 22, shader: 'aurora' }),
      t('Stoneware, fired slow and shipped whole.', { size: 40, font: 'Instrument Serif', color: INK, lh: 1.02, ls: -0.02, w: 'fill', name: 'Headline' }),
      t('Every cup and bowl is thrown by hand and glazed with ash from the last firing.', { size: 16, color: MUTED, lh: 1.5, w: 'fill' }),
      btn('Shop the new firing'),
    ]),
  ])
}

function components(): Spec {
  return h('frame', { name: 'Components', w: 760, flex: 'column', gap: 28, pad: 40, fill: '#FFFFFF', x: 0, y: 1500, radius: 0 }, [
    t('Components', { size: 13, weight: 600, upper: true, ls: 0.08, color: MUTED }),
    h('frame', { name: 'Buttons', flex: 'row', gap: 12, align: 'center' }, [btn('Primary'), btn('Secondary', 'ghost'), btn('Dark', 'dark')]),
    h('frame', { name: 'Badges', flex: 'row', gap: 8 }, [
      h('frame', { name: 'Badge', flex: 'row', pad: [4, 10], radius: 999, fill: '#FFE9DF' }, [t('In the kiln', { size: 12, weight: 500, color: '#B33A0C' })]),
      h('frame', { name: 'Badge', flex: 'row', pad: [4, 10], radius: 999, fill: '#E3EFEA' }, [t('Ready to ship', { size: 12, weight: 500, color: '#2F5D4D' })]),
      h('frame', { name: 'Badge', flex: 'row', pad: [4, 10], radius: 999, fill: '#EFEBE4' }, [t('Sold out', { size: 12, weight: 500, color: MUTED })]),
    ]),
    h('frame', { name: 'Field', flex: 'column', gap: 6, w: 320 }, [
      t('Email for firing notes', { size: 13, weight: 500, color: INK }),
      h('frame', { name: 'Input', flex: 'row', pad: [11, 14], radius: 12, fill: PAPER, stroke: ['#D8D2C8', 1], w: 'fill' }, [t('you@example.com', { size: 14, color: '#A39C91' })]),
    ]),
  ])
}

export function starterDoc(name = 'Hearth & Clay — shop'): KDoc {
  const doc = emptyDoc(name)
  const page = doc.pages[0]
  page.name = 'Shop'
  page.background = '#E9E6E1'
  const all: KNode[] = []
  for (const spec of [desktop(), mobile(), components()]) {
    const nodes = build(spec, page.id, null)
    all.push(...nodes)
    page.children.push(nodes[0].id)
  }
  for (const n of all) doc.nodes[n.id] = n
  doc.tokens.push({ id: 'tk-celadon', name: 'celadon', value: '#8FB8A8', group: 'color' }, { id: 'tk-paper', name: 'paper', value: PAPER, group: 'color' })
  const explore = createPage('Explorations', '#1C1B1A')
  doc.pages.push(explore)
  return doc
}

export function blankDoc(name = 'Untitled'): KDoc {
  const doc = emptyDoc(name)
  const page = doc.pages[0]
  const nodes = build(h('frame', { name: 'Desktop', w: 1440, h: 960, fill: '#FFFFFF' }), page.id, null)
  for (const n of nodes) doc.nodes[n.id] = n
  page.children.push(nodes[0].id)
  return doc
}
