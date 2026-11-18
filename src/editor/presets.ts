import { h, t, build, type Spec } from './build'
import { getEditor } from './store'
import { viewportCenterWorld } from './Canvas'
import { measure } from './geometry'
import { SHADER_DEFS, SHADER_KINDS } from '../shaders/defs'

const INK = '#141413'
const BONE = '#EDE7DC'
const EMBER = '#FF5B1F'
const MUTED = '#6F6A63'

export interface Preset {
  id: string
  group: string
  label: string
  description: string
  thumb: string
  glyph: string
  spec: () => Spec
  topLevelOnly?: boolean
}

const button = (label = 'Get started', primary = true) =>
  h('frame', { name: 'Button', flex: 'row', gap: 8, pad: [10, 16], align: 'center', justify: 'center', radius: 10, fill: primary ? INK : '#FFFFFF', stroke: primary ? undefined : ['#D8D2C8', 1] }, [
    t(label, { size: 14, weight: 500, color: primary ? BONE : INK, name: 'Label' }),
  ])

export const PRESETS: Preset[] = [
  {
    id: 'desktop',
    group: 'Artboards',
    label: 'Desktop',
    description: '1440 × 960 artboard',
    thumb: '#F4F2EE',
    glyph: '▭',
    topLevelOnly: true,
    spec: () => h('frame', { name: 'Desktop', w: 1440, h: 960, fill: '#FFFFFF' }),
  },
  {
    id: 'tablet',
    group: 'Artboards',
    label: 'Tablet',
    description: '834 × 1194 artboard',
    thumb: '#F4F2EE',
    glyph: '▯',
    topLevelOnly: true,
    spec: () => h('frame', { name: 'Tablet', w: 834, h: 1194, fill: '#FFFFFF' }),
  },
  {
    id: 'mobile',
    group: 'Artboards',
    label: 'Mobile',
    description: '390 × 844 flex column artboard',
    thumb: '#F4F2EE',
    glyph: '▯',
    topLevelOnly: true,
    spec: () => h('frame', { name: 'Mobile', w: 390, h: 844, fill: '#FFFFFF', flex: 'column', pad: [56, 20, 32, 20], gap: 16 }),
  },
  {
    id: 'stack-row',
    group: 'Layout',
    label: 'Row',
    description: 'Flex row with gap',
    thumb: '#EDE7DC',
    glyph: '⇢',
    spec: () =>
      h('frame', { name: 'Row', flex: 'row', gap: 12, align: 'center' }, [
        h('rect', { w: 64, h: 64, radius: 8, fill: '#D9D4CB' }),
        h('rect', { w: 64, h: 64, radius: 8, fill: '#D9D4CB' }),
        h('rect', { w: 64, h: 64, radius: 8, fill: '#D9D4CB' }),
      ]),
  },
  {
    id: 'stack-col',
    group: 'Layout',
    label: 'Column',
    description: 'Flex column with gap',
    thumb: '#EDE7DC',
    glyph: '⇣',
    spec: () =>
      h('frame', { name: 'Column', flex: 'column', gap: 12 }, [
        h('rect', { w: 200, h: 40, radius: 8, fill: '#D9D4CB' }),
        h('rect', { w: 200, h: 40, radius: 8, fill: '#D9D4CB' }),
        h('rect', { w: 200, h: 40, radius: 8, fill: '#D9D4CB' }),
      ]),
  },
  {
    id: 'button',
    group: 'Components',
    label: 'Button',
    description: 'Hug-sized primary button',
    thumb: INK,
    glyph: '⏵',
    spec: () => button(),
  },
  {
    id: 'input',
    group: 'Components',
    label: 'Input',
    description: 'Labelled text field',
    thumb: '#FFFFFF',
    glyph: '⌶',
    spec: () =>
      h('frame', { name: 'Field', flex: 'column', gap: 6, w: 320 }, [
        t('Email', { size: 13, weight: 500, color: INK, name: 'Label' }),
        h('frame', { name: 'Input', flex: 'row', align: 'center', pad: [10, 12], radius: 10, fill: '#FFFFFF', stroke: ['#D8D2C8', 1], w: 'fill' }, [
          t('you@studio.com', { size: 14, color: '#9A948B', name: 'Placeholder' }),
        ]),
      ]),
  },
  {
    id: 'badge',
    group: 'Components',
    label: 'Badge',
    description: 'Status pill',
    thumb: '#FFE6DA',
    glyph: '●',
    spec: () =>
      h('frame', { name: 'Badge', flex: 'row', gap: 6, align: 'center', pad: [4, 10], radius: 999, fill: '#FFE9DF' }, [
        h('ellipse', { w: 6, h: 6, fill: EMBER, name: 'Dot' }),
        t('Live', { size: 12, weight: 500, color: '#B33A0C', name: 'Label' }),
      ]),
  },
  {
    id: 'avatar',
    group: 'Components',
    label: 'Avatar row',
    description: 'Avatar with name and role',
    thumb: '#C9A27E',
    glyph: '◐',
    spec: () =>
      h('frame', { name: 'Person', flex: 'row', gap: 12, align: 'center' }, [
        h('ellipse', { w: 40, h: 40, gradient: ['#C9A27E', '#8FB8A8', 135], name: 'Avatar' }),
        h('frame', { name: 'Meta', flex: 'column', gap: 2 }, [
          t('Mara Okafor', { size: 14, weight: 600, color: INK, name: 'Name' }),
          t('Product designer', { size: 13, color: MUTED, name: 'Role' }),
        ]),
      ]),
  },
  {
    id: 'card',
    group: 'Components',
    label: 'Card',
    description: 'Content card with image, copy and action',
    thumb: '#FFFFFF',
    glyph: '▤',
    spec: () =>
      h('frame', { name: 'Card', flex: 'column', w: 340, radius: 16, fill: '#FFFFFF', shadow: 'md', clip: true }, [
        h('shader', { name: 'Cover', w: 'fill', h: 180, shader: 'aurora' }),
        h('frame', { name: 'Body', flex: 'column', gap: 8, pad: 20, w: 'fill' }, [
          t('Field notes', { size: 12, weight: 500, color: EMBER, upper: true, ls: 0.06, name: 'Eyebrow' }),
          t('Glazes that survive the second firing', { size: 20, weight: 600, color: INK, lh: 1.25, ls: -0.01, w: 'fill', name: 'Title' }),
          t('A short guide to choosing pigments that hold their colour above 1200°C.', { size: 14, color: MUTED, lh: 1.5, w: 'fill', name: 'Description' }),
        ]),
        h('frame', { name: 'Footer', flex: 'row', pad: [0, 20, 20, 20], w: 'fill', justify: 'space-between', align: 'center' }, [
          t('6 min read', { size: 13, color: MUTED }),
          button('Read', false),
        ]),
      ]),
  },
  {
    id: 'navbar',
    group: 'Sections',
    label: 'Navbar',
    description: 'Full-width navigation bar',
    thumb: '#FFFFFF',
    glyph: '☰',
    spec: () =>
      h('frame', { name: 'Nav', flex: 'row', w: 1200, pad: [16, 24], align: 'center', justify: 'space-between', fill: '#FFFFFF', stroke: ['#ECE7DF', 1] }, [
        t('atelier', { size: 18, weight: 700, color: INK, ls: -0.03, name: 'Logo' }),
        h('frame', { name: 'Links', flex: 'row', gap: 28 }, [
          t('Work', { size: 14, color: MUTED }),
          t('Studio', { size: 14, color: MUTED }),
          t('Journal', { size: 14, color: MUTED }),
          t('Contact', { size: 14, color: MUTED }),
        ]),
        button('Book a call'),
      ]),
  },
  {
    id: 'hero',
    group: 'Sections',
    label: 'Hero',
    description: 'Headline, copy, actions over a shader',
    thumb: 'linear-gradient(135deg,#3B2A4A,#FF5B1F)',
    glyph: 'H',
    spec: () =>
      h('frame', { name: 'Hero', flex: 'column', w: 1200, pad: [120, 80], gap: 28, align: 'start', fill: INK, clip: true, radius: 24 }, [
        h('shader', { name: 'Background', absolute: true, x: 0, y: 0, w: 1200, h: 560, shader: 'grain', opacity: 0.9 }),
        t('Ceramics, fired to order', { size: 64, weight: 600, color: BONE, ls: -0.035, lh: 1.02, w: 680, name: 'Headline' }),
        t('Small-batch stoneware from a two-person studio. Every piece is thrown, glazed and fired by hand.', {
          size: 18,
          color: '#CFC7BA',
          lh: 1.5,
          w: 520,
          name: 'Subhead',
        }),
        h('frame', { name: 'Actions', flex: 'row', gap: 12 }, [
          h('frame', { name: 'Button', flex: 'row', pad: [14, 22], radius: 12, fill: EMBER }, [t('Shop the kiln', { size: 15, weight: 600, color: '#FFFFFF' })]),
          h('frame', { name: 'Button', flex: 'row', pad: [14, 22], radius: 12, fill: 'rgba(237, 231, 220, 0.12)', backdropBlur: 12 }, [
            t('Visit the studio', { size: 15, weight: 500, color: BONE }),
          ]),
        ]),
      ]),
  },
  {
    id: 'features',
    group: 'Sections',
    label: 'Feature row',
    description: 'Three-up feature columns',
    thumb: '#F4F2EE',
    glyph: '⫼',
    spec: () =>
      h(
        'frame',
        { name: 'Features', flex: 'row', gap: 24, w: 1200, pad: 48, fill: '#F4F2EE' },
        [
          ['Thrown by hand', 'Each form starts on the wheel and is trimmed the next morning.'],
          ['Food safe glazes', 'Lead-free, tested, and fired to cone 10 for durability.'],
          ['Shipped carefully', 'Double-boxed in recycled pulp. Breakage is on us.'],
        ].map(([title, body]) =>
          h('frame', { name: 'Feature', flex: 'column', gap: 10, w: 'fill' }, [
            h('frame', { name: 'Icon', w: 40, h: 40, radius: 10, fill: '#FFE9DF' }),
            t(title, { size: 18, weight: 600, color: INK }),
            t(body, { size: 15, color: MUTED, lh: 1.55, w: 'fill' }),
          ]),
        ),
      ),
  },
  ...SHADER_KINDS.map(
    (k): Preset => ({
      id: 'shader-' + k,
      group: 'Shaders',
      label: SHADER_DEFS[k].label,
      description: SHADER_DEFS[k].description,
      thumb: SHADER_DEFS[k].preview,
      glyph: '',
      spec: () => h('shader', { w: 480, h: 320, shader: k, name: `Shader / ${k}` }),
    }),
  ),
]

/** Insert a preset into the selected flex frame, the selected artboard, or the viewport centre. */
export function insertPreset(id: string) {
  const preset = PRESETS.find((p) => p.id === id)
  if (!preset) return
  const s = getEditor()
  const doc = s.doc
  const sel = s.selection.length === 1 ? doc.nodes[s.selection[0]] : null
  let parentId: string | null = null
  if (!preset.topLevelOnly && sel) {
    if (sel.type === 'frame') parentId = sel.id
    else if (sel.parentId) parentId = sel.parentId
  }
  const nodes = build(preset.spec(), s.pageId, parentId)
  const root = nodes[0]
  if (parentId) {
    const p = doc.nodes[parentId]
    if (p.layout.mode !== 'flex') {
      root.x = 24
      root.y = 24
    }
  } else {
    const c = viewportCenterWorld()
    // place top-level presets to the right of existing content if viewport centre is occupied
    root.x = Math.round(c.x - (typeof root.width === 'number' ? root.width : 200) / 2)
    root.y = Math.round(c.y - 120)
    const page = doc.pages.find((p) => p.id === s.pageId)
    for (const other of page?.children ?? []) {
      const r = measure(other)
      if (r && r.x < root.x + root.width && r.x + r.w > root.x && r.y < root.y + root.height && r.y + r.h > root.y) {
        root.x = Math.round(r.x + r.w + 80)
      }
    }
  }
  s.insertNodes(nodes, [root.id], parentId)
  s.set({ selection: [root.id] })
  s.notify(`Inserted ${preset.label}`)
}
