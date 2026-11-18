import { useRef, useState } from 'react'
import type { Draft } from 'immer'
import {
  AlignHorizontalJustifyCenter,
  AlignHorizontalJustifyEnd,
  AlignHorizontalJustifyStart,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  ArrowDown,
  ArrowRight,
  Eye,
  EyeOff,
  Italic,
  Link2,
  Minus,
  Plus,
  RotateCw,
  Scan,
  SquareDashed,
  Underline,
  Strikethrough,
  WrapText,
  AlignLeft,
  AlignCenter,
  AlignRight,
  AlignJustify,
  Upload,
  Columns3,
  Rows3,
  SwatchBook,
  Pipette,
  ChevronDown,
  Check,
  Droplet,
} from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useEditor, getEditor } from '../store'
import type { Fill, KNode, Layout, NodeType, ShaderKind, SizeMode, Token } from '../types'
import { ColorField, NumberField, Section, Segmented, Select, Row } from '../ui/controls'
import { Checkbox, Slider } from '../../ui/Slider'
import { Popover } from '../../ui/Popover'
import { canPickColor, pickColor } from '../../ui/eyedropper'
import { parseColor, rgbToHex } from '../../ui/color'
import { dropShadow, solidFill, linearFill } from '../factory'
import { measure, measureSize } from '../geometry'
import { FONT_FAMILIES, FONT_WEIGHTS, ensureFont } from '../fonts'
import { SHADER_DEFS, SHADER_KINDS, defaultShaderSpec } from '../../shaders/defs'
import { readAsDataURL } from '../images'
import { TypeIcon } from './LayersPanel'

type Recipe = (n: Draft<KNode>) => void

export function Inspector() {
  const selection = useEditor((s) => s.selection)
  const nodes = useEditor(useShallow((s) => s.selection.map((id) => s.doc.nodes[id]).filter(Boolean)))
  const tick = useEditor((s) => s.measureTick)
  void tick
  if (!nodes.length) return <PageInspector />
  const n = nodes[0]
  const ids = selection
  const set = (recipe: Recipe, key?: string) => getEditor().setProps(ids, recipe, key)
  const types = new Set(nodes.map((x) => x.type))
  const only = (t: NodeType) => types.size === 1 && types.has(t)

  return (
    <div className="k-inspector">
      <div className="k-insp-head">
        <TypeIcon node={n} />
        {nodes.length > 1 ? (
          <span className="k-insp-name">{nodes.length} layers</span>
        ) : (
          <input
            key={n.id}
            className="k-insp-name"
            defaultValue={n.name}
            onBlur={(e) => e.target.value.trim() && e.target.value !== n.name && set((x) => void (x.name = e.target.value.trim()))}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        )}
        <span className="k-insp-type">{nodes.length > 1 ? 'Mixed' : n.parentId === null && n.type === 'frame' ? 'Artboard' : n.type}</span>
      </div>
      <AlignBar ids={ids} />
      <PositionSection nodes={nodes} set={set} />
      {(only('frame') || only('shader')) && <LayoutSection n={n} set={set} />}
      {only('text') && <TextSection n={n} set={set} />}
      {only('shader') && <ShaderSection n={n} set={set} />}
      {only('image') && <ImageSection n={n} set={set} />}
      {![...types].every((t) => t === 'ellipse' || t === 'text' || t === 'path') && <RadiusSection n={n} set={set} />}
      <BlendingSection n={n} set={set} />
      <FillSection n={n} set={set} />
      <StrokeSection n={n} set={set} />
      <EffectsSection n={n} set={set} />
      <DataSection n={n} set={set} />
    </div>
  )
}

/* -------------------------------------------------------------- page (nothing selected) */

const CANVAS_PRESETS = [
  { value: '#E9E6E1', label: 'Clay' },
  { value: '#F4F2EE', label: 'Paper' },
  { value: '#FFFFFF', label: 'White' },
  { value: '#1C1B1A', label: 'Graphite' },
  { value: '#0E0E0D', label: 'Night' },
  { value: '#2A2826', label: 'Slate' },
]

function setPageBackground(pageId: string, color: string, key?: string) {
  getEditor().update((d) => {
    const p = d.pages.find((p) => p.id === pageId)
    if (p) p.background = color
  }, key)
}

/** Canvas colour presets and the colours already in the file, in a popover. */
function CanvasSwatches({ pageId, current }: { pageId: string; current: string }) {
  const [open, setOpen] = useState(false)
  const [btn, setBtn] = useState<HTMLButtonElement | null>(null)
  const inFile = open ? documentColors().filter((c) => !CANVAS_PRESETS.some((p) => p.value === c)) : []
  const pick = (c: string) => {
    setPageBackground(pageId, c)
    setOpen(false)
  }
  const swatch = (c: string, label?: string) => (
    <button
      key={c}
      type="button"
      className={'k-cp-swatch' + (current.toUpperCase().startsWith(c.toUpperCase()) ? ' is-on' : '')}
      style={{ ['--sw' as string]: c }}
      title={label ? `${label} · ${c}` : c}
      aria-label={label ?? c}
      onClick={() => pick(c)}
    />
  )
  return (
    <>
      <button ref={setBtn} type="button" className={'k-icon-btn' + (open ? ' is-active' : '')} title="Canvas presets" aria-expanded={open} onClick={() => setOpen(!open)}>
        <SwatchBook size={14} />
      </button>
      <Popover anchor={btn} open={open} onClose={() => setOpen(false)} placement="bottom-end" offset={6} className="k-canvas-swatches" label="Canvas presets">
        <div className="k-cp-swatch-title">Presets</div>
        <div className="k-cp-swatch-grid">{CANVAS_PRESETS.map((p) => swatch(p.value, p.label))}</div>
        {inFile.length > 0 && (
          <>
            <div className="k-cp-swatch-title">In this file</div>
            <div className="k-cp-swatch-grid">{inFile.slice(0, 24).map((c) => swatch(c))}</div>
          </>
        )}
      </Popover>
    </>
  )
}

/** Solid colours used in the document (tokens first), for quick picks. */
function documentColors(): string[] {
  const doc = getEditor().doc
  const out: string[] = []
  const add = (c?: string) => {
    if (!c || !/^#[0-9a-f]{6}$/i.test(c)) return
    const k = c.toUpperCase()
    if (!out.includes(k)) out.push(k)
  }
  doc.tokens.forEach((t) => add(t.value))
  for (const n of Object.values(doc.nodes)) for (const f of n.fills) if (f.type === 'solid') add(f.color)
  return out
}

function PageInspector() {
  const page = useEditor((s) => s.doc.pages.find((p) => p.id === s.pageId))
  const tokens = useEditor((s) => s.doc.tokens)
  const doc = useEditor((s) => s.doc)
  const [picking, setPicking] = useState(false)
  if (!page) return null
  const count = Object.values(doc.nodes).filter((n) => n.pageId === page.id).length
  // the page colour is stored as one hex; the field edits colour and opacity apart
  const bg = parseColor(page.background) ?? { r: 233, g: 230, b: 225, a: 1 }
  const solid = rgbToHex({ ...bg, a: 1 })
  const withA = (hex: string, a: number) => {
    const c = parseColor(hex)
    return c ? rgbToHex({ ...c, a }, true) : hex
  }
  return (
    <div className="k-inspector">
      <div className="k-insp-head">
        <span className="k-insp-name">{page.name}</span>
        <span className="k-insp-type">page</span>
      </div>
      <Section title="Canvas">
        <div className="k-canvas-row">
          <ColorField
            value={solid}
            opacity={bg.a}
            onChange={(c, key) => setPageBackground(page.id, withA(c, bg.a), key)}
            onOpacity={(a, key) => setPageBackground(page.id, withA(solid, Math.round(a * 100) / 100), key)}
          />
          <CanvasSwatches pageId={page.id} current={solid} />
          {canPickColor() && (
            <button
              type="button"
              className={'k-icon-btn' + (picking ? ' is-active' : '')}
              title="Pick the canvas colour from the screen"
              onClick={async () => {
                setPicking(true)
                const hex = await pickColor()
                setPicking(false)
                if (hex) setPageBackground(page.id, withA(hex, bg.a))
              }}
            >
              <Pipette size={14} />
            </button>
          )}
        </div>
      </Section>
      <Section title="Document">
        <div className="k-kv">
          <span>Layers on page</span>
          <b>{count}</b>
        </div>
        <div className="k-kv">
          <span>Tokens</span>
          <b>{tokens.length}</b>
        </div>
        <div className="k-kv">
          <span>Comments</span>
          <b>{doc.comments.filter((c) => !c.resolved).length} open</b>
        </div>
      </Section>
    </div>
  )
}

/* -------------------------------------------------------------- align */

function AlignBar({ ids }: { ids: string[] }) {
  const align = (mode: 'l' | 'c' | 'r' | 't' | 'm' | 'b') => {
    const s = getEditor()
    const doc = s.doc
    const movable = ids.filter((id) => {
      const n = doc.nodes[id]
      const p = n.parentId ? doc.nodes[n.parentId] : null
      return !(p && p.layout.mode === 'flex' && n.positioning !== 'absolute')
    })
    if (!movable.length) return
    let ref: { x: number; y: number; w: number; h: number } | null = null
    if (movable.length === 1) {
      const n = doc.nodes[movable[0]]
      if (!n.parentId) return
      ref = measure(n.parentId)
    } else {
      const rs = movable.map((id) => measure(id)!).filter(Boolean)
      const x = Math.min(...rs.map((r) => r.x))
      const y = Math.min(...rs.map((r) => r.y))
      ref = { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y }
    }
    if (!ref) return
    const rects = Object.fromEntries(movable.map((id) => [id, measure(id)!]))
    s.update((d) => {
      for (const id of movable) {
        const r = rects[id]
        const n = d.nodes[id]
        let dx = 0
        let dy = 0
        if (mode === 'l') dx = ref!.x - r.x
        if (mode === 'c') dx = ref!.x + ref!.w / 2 - (r.x + r.w / 2)
        if (mode === 'r') dx = ref!.x + ref!.w - (r.x + r.w)
        if (mode === 't') dy = ref!.y - r.y
        if (mode === 'm') dy = ref!.y + ref!.h / 2 - (r.y + r.h / 2)
        if (mode === 'b') dy = ref!.y + ref!.h - (r.y + r.h)
        n.x = Math.round(n.x + dx)
        n.y = Math.round(n.y + dy)
      }
    })
  }
  const I = 15
  return (
    <div className="k-alignbar">
      <button title="Align left" onClick={() => align('l')}>
        <AlignHorizontalJustifyStart size={I} />
      </button>
      <button title="Align horizontal centers" onClick={() => align('c')}>
        <AlignHorizontalJustifyCenter size={I} />
      </button>
      <button title="Align right" onClick={() => align('r')}>
        <AlignHorizontalJustifyEnd size={I} />
      </button>
      <span className="k-sep" />
      <button title="Align top" onClick={() => align('t')}>
        <AlignVerticalJustifyStart size={I} />
      </button>
      <button title="Align vertical centers" onClick={() => align('m')}>
        <AlignVerticalJustifyCenter size={I} />
      </button>
      <button title="Align bottom" onClick={() => align('b')}>
        <AlignVerticalJustifyEnd size={I} />
      </button>
    </div>
  )
}

/* -------------------------------------------------------------- position & size */

function PositionSection({ nodes, set }: { nodes: KNode[]; set: (r: Recipe, key?: string) => void }) {
  const n = nodes[0]
  const doc = useEditor((s) => s.doc)
  const parent = n.parentId ? doc.nodes[n.parentId] : null
  const inFlow = !!parent && parent.layout.mode === 'flex' && n.positioning !== 'absolute'
  const size = measureSize(n.id)
  const W = n.widthMode === 'fixed' ? n.width : size?.w ?? n.width
  const H = n.heightMode === 'fixed' ? n.height : size?.h ?? n.height
  const canHug = n.type === 'text' || (n.type === 'frame' && n.layout.mode === 'flex')
  const modeOptions = (axis: 'w' | 'h') =>
    [
      { value: 'fixed' as SizeMode, label: 'Fixed' },
      ...(canHug ? [{ value: 'hug' as SizeMode, label: 'Hug' }] : []),
      ...(parent ? [{ value: 'fill' as SizeMode, label: 'Fill' }] : []),
    ].filter((o) => !(axis === 'h' && n.type === 'text' && n.widthMode === 'hug' && o.value === 'fixed' && false))

  const setMode = (axis: 'w' | 'h', m: SizeMode) => {
    const sz = measureSize(n.id)
    set((x) => {
      if (axis === 'w') {
        if (m === 'fixed' && sz) x.width = Math.round(sz.w)
        x.widthMode = m
      } else {
        if (m === 'fixed' && sz) x.height = Math.round(sz.h)
        x.heightMode = m
      }
    })
  }

  return (
    <Section title={inFlow ? `Position · in ${parent!.name}` : 'Position'}>
      {inFlow ? (
        <Row>
          <div className="k-flow-note">
            Auto layout position <span>({parent!.layout.direction === 'row' ? 'row' : 'column'} · #{parent!.children.indexOf(n.id) + 1})</span>
          </div>
          <button className="k-btn-ghost k-sm" title="Take out of flow (position: absolute)" onClick={() => {
            const r = measure(n.id)
            const pr = measure(parent!.id)
            set((x) => {
              x.positioning = 'absolute'
              if (r && pr) {
                x.x = Math.round(r.x - pr.x)
                x.y = Math.round(r.y - pr.y)
              }
              if (x.widthMode === 'fill' && r) {
                x.widthMode = 'fixed'
                x.width = Math.round(r.w)
              }
            })
          }}>
            Absolute
          </button>
        </Row>
      ) : (
        <Row>
          <NumberField label="X" value={n.x} onChange={(v, k) => set((x) => void (x.x = v), k)} mixed={nodes.some((m) => m.x !== n.x)} />
          <NumberField label="Y" value={n.y} onChange={(v, k) => set((x) => void (x.y = v), k)} mixed={nodes.some((m) => m.y !== n.y)} />
          {n.positioning === 'absolute' && parent?.layout.mode === 'flex' && (
            <button className="k-btn-ghost k-sm" title="Return to flow" onClick={() => set((x) => void (x.positioning = 'auto'))}>
              Flow
            </button>
          )}
        </Row>
      )}
      <Row>
        <NumberField
          label="W"
          value={Math.round(W)}
          min={1}
          onChange={(v, k) =>
            set((x) => {
              x.width = v
              x.widthMode = 'fixed'
            }, k)
          }
        />
        <NumberField
          label="H"
          value={Math.round(H)}
          min={1}
          onChange={(v, k) =>
            set((x) => {
              x.height = v
              x.heightMode = 'fixed'
            }, k)
          }
        />
      </Row>
      <Row>
        <Select value={n.widthMode} options={modeOptions('w')} onChange={(m) => setMode('w', m)} title="Width sizing" />
        <Select value={n.heightMode} options={modeOptions('h')} onChange={(m) => setMode('h', m)} title="Height sizing" />
      </Row>
      <Row>
        <NumberField label={<RotateCw size={12} />} value={n.rotation} suffix="°" onChange={(v, k) => set((x) => void (x.rotation = v), k)} title="Rotation" />
        <NumberField
          label="Min"
          value={n.minWidth ?? 0}
          placeholder="—"
          title="Min width"
          onChange={(v, k) => set((x) => void (x.minWidth = v || undefined), k)}
        />
        <NumberField
          label="Max"
          value={n.maxWidth ?? 0}
          placeholder="—"
          title="Max width"
          onChange={(v, k) => set((x) => void (x.maxWidth = v || undefined), k)}
        />
      </Row>
    </Section>
  )
}

/* -------------------------------------------------------------- layout */

function AlignMatrix({ layout, onChange }: { layout: Layout; onChange: (justify: Layout['justify'], align: Layout['align']) => void }) {
  const pos = ['start', 'center', 'end'] as const
  const row = layout.direction === 'row'
  const spaced = layout.justify.startsWith('space')
  return (
    <div className="k-matrix" title="Alignment">
      {pos.map((yv) =>
        pos.map((xv) => {
          const j = row ? xv : yv
          const a = row ? yv : xv
          const on = (spaced || layout.justify === j) && (layout.align === a || (layout.align === 'stretch' && a === 'start'))
          const highlight = spaced ? layout.align === a || (layout.align === 'stretch' && a === 'start') : on
          return (
            <button key={xv + yv} className={highlight ? 'is-on' : ''} onClick={() => onChange(spaced ? layout.justify : j, a)}>
              <i style={row ? { width: 3, height: 7 } : { width: 7, height: 3 }} />
            </button>
          )
        }),
      )}
    </div>
  )
}

function LayoutSection({ n, set }: { n: KNode; set: (r: Recipe, key?: string) => void }) {
  const L = n.layout
  const flex = L.mode === 'flex'
  const [sides, setSides] = useState(!(L.padding.every((p) => p === L.padding[0])))
  const mode = flex ? L.direction : 'none'
  return (
    <Section title="Layout">
      <Row>
        <Segmented
          value={mode}
          onChange={(v) => {
            const s = getEditor()
            if (v === 'none') {
              if (flex) s.toggleFlex()
            } else if (!flex) {
              s.toggleFlex()
              set((x) => void (x.layout.direction = v as 'row' | 'column'))
            } else set((x) => void (x.layout.direction = v as 'row' | 'column'))
          }}
          options={[
            { value: 'none', label: <SquareDashed size={14} />, title: 'Freeform (absolute children)' },
            { value: 'row', label: <ArrowRight size={14} />, title: 'Flex row' },
            { value: 'column', label: <ArrowDown size={14} />, title: 'Flex column' },
          ]}
        />
        {flex && (
          <button className={'k-icon-btn' + (L.wrap ? ' is-on' : '')} title="Wrap" onClick={() => set((x) => void (x.layout.wrap = !x.layout.wrap))}>
            <WrapText size={14} />
          </button>
        )}
        <Checkbox checked={n.clip} onChange={(v) => set((x) => void (x.clip = v))} title="Clip content (overflow: hidden)">
          Clip
        </Checkbox>
      </Row>
      {flex && (
        <>
          <div className="k-layout-grid">
            <AlignMatrix
              layout={L}
              onChange={(j, a) =>
                set((x) => {
                  x.layout.justify = j
                  x.layout.align = a
                })
              }
            />
            <div className="k-layout-fields">
              <NumberField label="Gap" value={L.gap} min={0} onChange={(v, k) => set((x) => void (x.layout.gap = v), k)} />
              <Select
                value={L.justify}
                title="Distribution (justify-content)"
                onChange={(v) => set((x) => void (x.layout.justify = v))}
                options={[
                  { value: 'start', label: 'Packed start' },
                  { value: 'center', label: 'Packed center' },
                  { value: 'end', label: 'Packed end' },
                  { value: 'space-between', label: 'Space between' },
                  { value: 'space-around', label: 'Space around' },
                  { value: 'space-evenly', label: 'Space evenly' },
                ]}
              />
              <Select
                value={L.align}
                title="Cross-axis (align-items)"
                onChange={(v) => set((x) => void (x.layout.align = v))}
                options={[
                  { value: 'start', label: 'Align start' },
                  { value: 'center', label: 'Align center' },
                  { value: 'end', label: 'Align end' },
                  { value: 'stretch', label: 'Stretch' },
                  { value: 'baseline', label: 'Baseline' },
                ]}
              />
            </div>
          </div>
        </>
      )}
      {n.type === 'frame' && (
        <div className="k-padding">
          {sides ? (
            <div className="k-padding-sides">
              <Row>
                <NumberField label="T" title="Padding top" value={L.padding[0]} min={0} onChange={(v, k) => set((x) => void (x.layout.padding[0] = v), k)} />
                <NumberField label="R" title="Padding right" value={L.padding[1]} min={0} onChange={(v, k) => set((x) => void (x.layout.padding[1] = v), k)} />
              </Row>
              <Row>
                <NumberField label="B" title="Padding bottom" value={L.padding[2]} min={0} onChange={(v, k) => set((x) => void (x.layout.padding[2] = v), k)} />
                <NumberField label="L" title="Padding left" value={L.padding[3]} min={0} onChange={(v, k) => set((x) => void (x.layout.padding[3] = v), k)} />
              </Row>
            </div>
          ) : (
            <Row>
              <NumberField
                label="↔"
                title="Horizontal padding"
                value={L.padding[1]}
                min={0}
                onChange={(v, k) =>
                  set((x) => {
                    x.layout.padding[1] = v
                    x.layout.padding[3] = v
                  }, k)
                }
              />
              <NumberField
                label="↕"
                title="Vertical padding"
                value={L.padding[0]}
                min={0}
                onChange={(v, k) =>
                  set((x) => {
                    x.layout.padding[0] = v
                    x.layout.padding[2] = v
                  }, k)
                }
              />
            </Row>
          )}
          <button className={'k-icon-btn' + (sides ? ' is-on' : '')} title="Individual sides" onClick={() => setSides(!sides)}>
            <Scan size={14} />
          </button>
        </div>
      )}
    </Section>
  )
}

/* -------------------------------------------------------------- appearance */

const BLEND_MODES: KNode['blend'][] = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity']
const BLEND_OPTIONS = BLEND_MODES.map((b) => ({ value: b, label: b[0].toUpperCase() + b.slice(1).replace('-', ' ') }))

/** CSS turns any radius at or past half the short side into a pill */
const FULL_RADIUS = 9999
const RADIUS_PRESETS: { value: number; label: string }[] = [0, 2, 4, 6, 8, 12, 16, 24, 32].map((v) => ({ value: v, label: String(v) })).concat({ value: FULL_RADIUS, label: 'Full' })

/** Opacity's mark: a small transparency checkerboard. */
function OpacityIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className="k-opacity-icon">
      <rect x="0.5" y="0.5" width="11" height="11" rx="2.5" fill="none" stroke="currentColor" strokeOpacity="0.55" />
      <path d="M3 3h2v2H3zM7 3h2v2H7zM5 5h2v2H5zM3 7h2v2H3zM7 7h2v2H7z" fill="currentColor" />
    </svg>
  )
}

/** The radius value, with a menu of common radii (Full makes a pill). */
function RadiusField({ value, onChange }: { value: number; onChange: (v: number, key: string) => void }) {
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  return (
    <div className="k-num-combo">
      <NumberField title="Corner radius" value={value} min={0} onChange={onChange} placeholder="0" />
      <button ref={setAnchor} type="button" className="k-num-combo-btn" title="Common radii" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronDown size={12} />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="bottom-end" className="k-menu k-radius-menu" role="menu" label="Common radii">
        {RADIUS_PRESETS.map((p) => (
          <button
            key={p.value}
            role="menuitemradio"
            aria-checked={p.value === value}
            onClick={() => {
              onChange(p.value, 'radius-preset-' + Date.now())
              setOpen(false)
            }}
          >
            <span className="k-menu-check">{p.value === value && <Check size={12} strokeWidth={2.25} />}</span>
            <span className="k-menu-label">{p.label}</span>
          </button>
        ))}
      </Popover>
    </div>
  )
}

function RadiusSection({ n, set }: { n: KNode; set: (r: Recipe, key?: string) => void }) {
  const multi = Array.isArray(n.radius)
  const r = n.radius
  const one = multi ? (r as number[])[0] : (r as number)
  // the slider runs to a pill: half the shorter side
  const max = Math.max(1, Math.round(Math.min(n.width, n.height) / 2))
  return (
    <Section
      title="Radius"
      actions={
        <button
          className={'k-icon-btn k-sm' + (multi ? ' is-on' : '')}
          title={multi ? 'Same radius on every corner' : 'Individual corners'}
          aria-pressed={multi}
          onClick={() => set((x) => void (x.radius = Array.isArray(x.radius) ? x.radius[0] : [x.radius, x.radius, x.radius, x.radius]))}
        >
          <Scan size={12} />
        </button>
      }
    >
      {multi ? (
        <Row>
          {(['↖', '↗', '↘', '↙'] as const).map((lbl, i) => (
            <NumberField
              key={i}
              label={lbl}
              title={['Top left', 'Top right', 'Bottom right', 'Bottom left'][i] + ' radius'}
              value={(r as number[])[i]}
              min={0}
              onChange={(v, k) =>
                set((x) => {
                  if (Array.isArray(x.radius)) x.radius[i] = v
                }, k)
              }
            />
          ))}
        </Row>
      ) : (
        <div className="k-radius-row">
          <Slider value={Math.min(one, max)} min={0} max={max} step={1} label="Corner radius" onChange={(v, k) => set((x) => void (x.radius = v), k)} />
          <RadiusField value={one} onChange={(v, k) => set((x) => void (x.radius = v), k)} />
        </div>
      )}
    </Section>
  )
}

function BlendingSection({ n, set }: { n: KNode; set: (r: Recipe, key?: string) => void }) {
  return (
    <Section
      title="Blending"
      actions={
        <button className={'k-icon-btn k-sm' + (n.visible ? '' : ' is-on')} title={n.visible ? 'Hide layer' : 'Show layer'} aria-pressed={!n.visible} onClick={() => set((x) => void (x.visible = !x.visible))}>
          {n.visible ? <Eye size={12} /> : <EyeOff size={12} />}
        </button>
      }
    >
      <div className="k-blend-row">
        <NumberField label={<OpacityIcon />} title="Opacity" value={Math.round(n.opacity * 100)} min={0} max={100} suffix="%" onChange={(v, k) => set((x) => void (x.opacity = v / 100), k)} />
        <Select value={n.blend} title="Blend mode" leading={<Droplet size={12} />} onChange={(v) => set((x) => void (x.blend = v))} options={BLEND_OPTIONS} />
      </div>
    </Section>
  )
}

/* -------------------------------------------------------------- fills */

function TokenPicker({ tokens, onPick }: { tokens: Token[]; onPick: (t: Token) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button ref={ref} className={'k-icon-btn k-sm' + (open ? ' is-on' : '')} title="Apply a colour token" onClick={() => setOpen(!open)}>
        <Link2 size={12} />
      </button>
      <Popover anchor={ref.current} open={open} onClose={() => setOpen(false)} placement="bottom-end" className="k-popover">
        <div className="k-popover-title">Colour tokens</div>
        {tokens.map((t) => (
          <button
            key={t.id}
            className="k-popover-item"
            onClick={() => {
              onPick(t)
              setOpen(false)
            }}
          >
            <span className="k-mini-swatch" style={{ background: t.value }} />
            <span className="k-popover-item-label">{t.name}</span>
            <span className="k-dim k-mono">{t.value}</span>
          </button>
        ))}
        {!tokens.length && <div className="k-popover-empty">No tokens yet. Add them in the Tokens tab.</div>}
      </Popover>
    </>
  )
}

function FillRow({ f, i, n, set, tokens }: { f: Fill; i: number; n: KNode; set: (r: Recipe, key?: string) => void; tokens: Token[] }) {
  const token = f.tokenId ? tokens.find((t) => t.id === f.tokenId) : undefined
  const edit = (r: (f: Draft<Fill>) => void, key?: string) => set((x) => void (x.fills[i] && r(x.fills[i])), key)
  return (
    <div className="k-fill">
      <Row>
        <Select
          value={f.type}
          width={84}
          onChange={(t) =>
            edit((ff) => {
              ff.type = t
              if ((t === 'linear' || t === 'radial') && ff.stops.length < 2)
                ff.stops = [
                  { pos: 0, color: ff.color },
                  { pos: 1, color: '#FF5B1F' },
                ]
            })
          }
          options={[
            { value: 'solid', label: 'Solid' },
            { value: 'linear', label: 'Linear' },
            { value: 'radial', label: 'Radial' },
            { value: 'image', label: 'Image' },
          ]}
        />
        {f.type === 'solid' && (
          <ColorField
            value={token ? token.value : f.color}
            tokenName={token?.name}
            onDetachToken={() => edit((ff) => {
              ff.color = token!.value
              delete ff.tokenId
            })}
            onChange={(c, k) => edit((ff) => {
              ff.color = c
              delete ff.tokenId
            }, k)}
            opacity={f.opacity}
            onOpacity={(v, k) => edit((ff) => void (ff.opacity = v), k)}
          />
        )}
        {f.type === 'solid' && <TokenPicker tokens={tokens} onPick={(t) => edit((ff) => void (ff.tokenId = t.id))} />}
        <button className="k-icon-btn k-sm" title={f.visible ? 'Hide fill' : 'Show fill'} onClick={() => edit((ff) => void (ff.visible = !ff.visible))}>
          {f.visible ? <Eye size={12} /> : <EyeOff size={12} />}
        </button>
        <button className="k-icon-btn k-sm" title="Remove fill" onClick={() => set((x) => void x.fills.splice(i, 1))}>
          <Minus size={12} />
        </button>
      </Row>
      {(f.type === 'linear' || f.type === 'radial') && (
        <div className="k-gradient">
          <div className="k-gradient-bar" style={{ background: `linear-gradient(90deg, ${f.stops.map((s) => `${s.color} ${s.pos * 100}%`).join(', ')})` }} />
          {f.stops.map((s, si) => (
            <Row key={si}>
              <NumberField value={Math.round(s.pos * 100)} min={0} max={100} suffix="%" width={64} onChange={(v, k) => edit((ff) => void (ff.stops[si].pos = v / 100), k)} />
              <ColorField value={s.color} onChange={(c, k) => edit((ff) => void (ff.stops[si].color = c), k)} />
              {f.stops.length > 2 && (
                <button className="k-icon-btn k-sm" onClick={() => edit((ff) => void ff.stops.splice(si, 1))}>
                  <Minus size={12} />
                </button>
              )}
            </Row>
          ))}
          <Row>
            {f.type === 'linear' && <NumberField label="∠" title="Angle" value={f.angle} suffix="°" onChange={(v, k) => edit((ff) => void (ff.angle = v), k)} />}
            <NumberField label="Op" value={Math.round(f.opacity * 100)} min={0} max={100} suffix="%" onChange={(v, k) => edit((ff) => void (ff.opacity = v / 100), k)} />
            <button className="k-btn-ghost k-sm" onClick={() => edit((ff) => void ff.stops.push({ pos: 0.5, color: '#C9A27E' }))}>
              <Plus size={12} /> Stop
            </button>
          </Row>
        </div>
      )}
      {f.type === 'image' && (
        <Row>
          <div className="k-img-thumb" style={{ backgroundImage: f.src ? `url("${f.src}")` : undefined }} />
          <ImageUpload onPick={(src) => edit((ff) => void (ff.src = src))} />
          <Select
            value={f.fit ?? 'cover'}
            width={84}
            onChange={(v) => edit((ff) => void (ff.fit = v))}
            options={[
              { value: 'cover', label: 'Cover' },
              { value: 'contain', label: 'Contain' },
              { value: 'fill', label: 'Stretch' },
              { value: 'tile', label: 'Tile' },
            ]}
          />
        </Row>
      )}
      {void n}
    </div>
  )
}

function ImageUpload({ onPick, label = 'Upload' }: { onPick: (src: string) => void; label?: string }) {
  return (
    <label className="k-btn-ghost k-sm k-upload">
      <Upload size={12} /> {label}
      <input
        type="file"
        accept="image/*"
        onChange={async (e) => {
          const f = e.target.files?.[0]
          if (f) onPick(await readAsDataURL(f))
        }}
      />
    </label>
  )
}

function FillSection({ n, set }: { n: KNode; set: (r: Recipe, key?: string) => void }) {
  const tokens = useEditor((s) => s.doc.tokens)
  return (
    <Section
      title={n.type === 'text' ? 'Background' : 'Fill'}
      actions={
        <>
          <button className="k-icon-btn k-sm" title="Add gradient" onClick={() => set((x) => void x.fills.unshift(linearFill(['#EDE7DC', '#C9A27E'])))}>
            <Columns3 size={12} />
          </button>
          <button className="k-icon-btn k-sm" title="Add fill" onClick={() => set((x) => void x.fills.unshift(solidFill(x.fills.length ? '#141413' : '#FFFFFF')))}>
            <Plus size={12} />
          </button>
        </>
      }
    >
      {n.fills.length ? n.fills.map((f, i) => <FillRow key={f.id} f={f} i={i} n={n} set={set} tokens={tokens} />) : null}
    </Section>
  )
}

/* -------------------------------------------------------------- stroke */

function StrokeSection({ n, set }: { n: KNode; set: (r: Recipe, key?: string) => void }) {
  const st = n.stroke
  return (
    <Section
      title="Stroke"
      actions={
        st ? (
          <button className="k-icon-btn k-sm" title="Remove stroke" onClick={() => set((x) => void (x.stroke = null))}>
            <Minus size={12} />
          </button>
        ) : (
          <button
            className="k-icon-btn k-sm"
            title="Add stroke"
            onClick={() => set((x) => void (x.stroke = { visible: true, color: '#141413', width: x.type === 'path' ? 2 : 1, style: 'solid', position: x.type === 'path' ? 'center' : 'inside' }))}
          >
            <Plus size={12} />
          </button>
        )
      }
    >
      {st && (
        <>
          <ColorField value={st.color} onChange={(c, k) => set((x) => void (x.stroke && (x.stroke.color = c)), k)} />
          <Row>
            <NumberField label="W" title="Stroke width" value={st.width} min={0} step={0.5} precision={1} onChange={(v, k) => set((x) => void (x.stroke && (x.stroke.width = v)), k)} />
            <Select
              value={st.style}
              onChange={(v) => set((x) => void (x.stroke && (x.stroke.style = v)))}
              options={[
                { value: 'solid', label: 'Solid' },
                { value: 'dashed', label: 'Dashed' },
                { value: 'dotted', label: 'Dotted' },
              ]}
            />
            {n.type !== 'path' && <Select
              value={st.position}
              onChange={(v) => set((x) => void (x.stroke && (x.stroke.position = v)))}
              options={[
                { value: 'inside', label: 'Inside' },
                { value: 'center', label: 'Center' },
                { value: 'outside', label: 'Outside' },
              ]}
            />}
          </Row>
        </>
      )}
    </Section>
  )
}

/* -------------------------------------------------------------- effects */

function EffectsSection({ n, set }: { n: KNode; set: (r: Recipe, key?: string) => void }) {
  return (
    <Section
      title="Effects"
      actions={
        <button className="k-icon-btn k-sm" title="Add shadow" onClick={() => set((x) => void x.shadows.push(dropShadow()))}>
          <Plus size={12} />
        </button>
      }
    >
      {n.shadows.map((sh, i) => (
        <div key={sh.id} className="k-fill">
          <Row>
            <Select
              value={sh.type}
              width={92}
              onChange={(v) => set((x) => void (x.shadows[i].type = v))}
              options={[
                { value: 'drop', label: 'Drop shadow' },
                { value: 'inner', label: 'Inner shadow' },
              ]}
            />
            <ColorField value={sh.color} onChange={(c, k) => set((x) => void (x.shadows[i].color = c), k)} />
            <button className="k-icon-btn k-sm" onClick={() => set((x) => void (x.shadows[i].visible = !x.shadows[i].visible))}>
              {sh.visible ? <Eye size={12} /> : <EyeOff size={12} />}
            </button>
            <button className="k-icon-btn k-sm" onClick={() => set((x) => void x.shadows.splice(i, 1))}>
              <Minus size={12} />
            </button>
          </Row>
          <Row>
            <NumberField label="X" value={sh.x} onChange={(v, k) => set((x) => void (x.shadows[i].x = v), k)} />
            <NumberField label="Y" value={sh.y} onChange={(v, k) => set((x) => void (x.shadows[i].y = v), k)} />
            <NumberField label="B" title="Blur" value={sh.blur} min={0} onChange={(v, k) => set((x) => void (x.shadows[i].blur = v), k)} />
            <NumberField label="S" title="Spread" value={sh.spread} onChange={(v, k) => set((x) => void (x.shadows[i].spread = v), k)} />
          </Row>
        </div>
      ))}
      <Row>
        <NumberField label="Blur" title="Layer blur" value={n.blur} min={0} onChange={(v, k) => set((x) => void (x.blur = v), k)} />
        <NumberField label="BG" title="Backdrop blur" value={n.backdropBlur} min={0} onChange={(v, k) => set((x) => void (x.backdropBlur = v), k)} />
      </Row>
    </Section>
  )
}

/* -------------------------------------------------------------- text */

function TextSection({ n, set }: { n: KNode; set: (r: Recipe, key?: string) => void }) {
  const t = n.text!
  const tokens = useEditor((s) => s.doc.tokens)
  const token = t.tokenId ? tokens.find((x) => x.id === t.tokenId) : undefined
  const edit = (r: (t: Draft<NonNullable<KNode['text']>>) => void, key?: string) => set((x) => void (x.text && r(x.text)), key)
  return (
    <Section title="Typography">
      <Select
        value={t.fontFamily}
        onChange={(v) => {
          ensureFont(v)
          edit((tt) => void (tt.fontFamily = v))
          setTimeout(() => getEditor().bumpMeasure(), 400)
        }}
        options={[
          ...(FONT_FAMILIES.some((f) => f.family === t.fontFamily) ? [] : [{ value: t.fontFamily, label: t.fontFamily, style: { fontFamily: `"${t.fontFamily}"` } }]),
          ...FONT_FAMILIES.map((f) => ({ value: f.family, label: f.family, hint: f.category, style: { fontFamily: `"${f.family}", ${f.category === 'mono' ? 'monospace' : f.category === 'serif' ? 'serif' : 'sans-serif'}` } })),
        ]}
        onOpen={() => FONT_FAMILIES.forEach((f) => ensureFont(f.family))}
      />
      <Row>
        <Select value={t.fontWeight} onChange={(v) => edit((tt) => void (tt.fontWeight = v))} options={FONT_WEIGHTS} />
        <NumberField label="Sz" title="Font size" value={t.fontSize} min={1} onChange={(v, k) => edit((tt) => void (tt.fontSize = v), k)} />
      </Row>
      <Row>
        <NumberField label="LH" title="Line height (multiplier)" value={t.lineHeight} step={0.05} precision={2} min={0.5} onChange={(v, k) => edit((tt) => void (tt.lineHeight = v), k)} />
        <NumberField label="LS" title="Letter spacing (em)" value={t.letterSpacing} step={0.005} precision={3} onChange={(v, k) => edit((tt) => void (tt.letterSpacing = v), k)} />
      </Row>
      <Row>
        <ColorField
          value={token ? token.value : t.color}
          tokenName={token?.name}
          onDetachToken={() => edit((tt) => {
            tt.color = token!.value
            delete tt.tokenId
          })}
          onChange={(c, k) => edit((tt) => {
            tt.color = c
            delete tt.tokenId
          }, k)}
        />
        <TokenPicker tokens={tokens} onPick={(tk) => edit((tt) => void (tt.tokenId = tk.id))} />
      </Row>
      <Row>
        <Segmented
          size="sm"
          value={t.textAlign}
          onChange={(v) => edit((tt) => void (tt.textAlign = v))}
          options={[
            { value: 'left', label: <AlignLeft size={13} /> },
            { value: 'center', label: <AlignCenter size={13} /> },
            { value: 'right', label: <AlignRight size={13} /> },
            { value: 'justify', label: <AlignJustify size={13} /> },
          ]}
        />
        <button className={'k-icon-btn' + (t.italic ? ' is-on' : '')} title="Italic" onClick={() => edit((tt) => void (tt.italic = !tt.italic))}>
          <Italic size={14} />
        </button>
        <button
          className={'k-icon-btn' + (t.decoration === 'underline' ? ' is-on' : '')}
          title="Underline"
          onClick={() => edit((tt) => void (tt.decoration = tt.decoration === 'underline' ? 'none' : 'underline'))}
        >
          <Underline size={14} />
        </button>
        <button
          className={'k-icon-btn' + (t.decoration === 'line-through' ? ' is-on' : '')}
          title="Strikethrough"
          onClick={() => edit((tt) => void (tt.decoration = tt.decoration === 'line-through' ? 'none' : 'line-through'))}
        >
          <Strikethrough size={14} />
        </button>
      </Row>
      <Row>
        <Segmented
          size="sm"
          value={t.transform}
          onChange={(v) => edit((tt) => void (tt.transform = v))}
          options={[
            { value: 'none', label: '—', title: 'No transform' },
            { value: 'uppercase', label: 'AA', title: 'Uppercase' },
            { value: 'lowercase', label: 'aa', title: 'Lowercase' },
            { value: 'capitalize', label: 'Aa', title: 'Capitalize' },
          ]}
        />
        <Segmented
          size="sm"
          value={n.widthMode === 'hug' ? 'auto' : n.heightMode === 'hug' ? 'height' : 'fixed'}
          onChange={(v) => {
            const sz = measureSize(n.id)
            set((x) => {
              if (v === 'auto') {
                x.widthMode = 'hug'
                x.heightMode = 'hug'
              } else if (v === 'height') {
                if (x.widthMode === 'hug' && sz) x.width = Math.round(sz.w)
                if (x.widthMode !== 'fill') x.widthMode = 'fixed'
                x.heightMode = 'hug'
              } else {
                if (sz) {
                  x.width = Math.round(sz.w)
                  x.height = Math.round(sz.h)
                }
                x.widthMode = 'fixed'
                x.heightMode = 'fixed'
              }
            })
          }}
          options={[
            { value: 'auto', label: <Rows3 size={12} />, title: 'Auto width' },
            { value: 'height', label: 'Auto H', title: 'Fixed width, auto height' },
            { value: 'fixed', label: 'Fixed', title: 'Fixed size' },
          ]}
        />
      </Row>
    </Section>
  )
}

/* -------------------------------------------------------------- image */

function ImageSection({ n, set }: { n: KNode; set: (r: Recipe, key?: string) => void }) {
  const img = n.image!
  return (
    <Section title="Image">
      <Row>
        <div className="k-img-thumb" style={{ backgroundImage: img.src ? `url("${img.src}")` : undefined }} />
        <ImageUpload label="Replace" onPick={(src) => set((x) => void (x.image && (x.image.src = src)))} />
        <Select
          value={img.fit}
          width={84}
          onChange={(v) => set((x) => void (x.image && (x.image.fit = v)))}
          options={[
            { value: 'cover', label: 'Cover' },
            { value: 'contain', label: 'Contain' },
            { value: 'fill', label: 'Stretch' },
          ]}
        />
      </Row>
      <input
        className="k-text-input"
        placeholder="Alt text (for accessibility & export)"
        defaultValue={img.alt}
        key={n.id + 'alt'}
        onBlur={(e) => set((x) => void (x.image && (x.image.alt = e.target.value)))}
      />
    </Section>
  )
}

/* -------------------------------------------------------------- shader */

function ShaderSection({ n, set }: { n: KNode; set: (r: Recipe, key?: string) => void }) {
  const spec = n.shader
  if (!spec) return null
  const def = SHADER_DEFS[spec.kind]
  return (
    <Section title="Shader">
      <div className="k-shader-grid">
        {SHADER_KINDS.map((k: ShaderKind) => (
          <button
            key={k}
            className={'k-shader-chip' + (k === spec.kind ? ' is-on' : '')}
            onClick={() => set((x) => {
              x.shader = defaultShaderSpec(k)
              if (x.name.startsWith('Shader')) x.name = `Shader / ${k}`
            })}
            title={SHADER_DEFS[k].description}
          >
            <span style={{ background: SHADER_DEFS[k].preview }} />
            {SHADER_DEFS[k].label}
          </button>
        ))}
      </div>
      <NumberField label="Speed" value={spec.speed} min={0} max={4} step={0.05} precision={2} onChange={(v, k) => set((x) => void (x.shader && (x.shader.speed = v)), k)} />
      {def.params.map((p) =>
        p.type === 'color' ? (
          <div key={p.key} className="k-param">
            <span>{p.label}</span>
            <ColorField value={String(spec.params[p.key] ?? p.default)} onChange={(c, k) => set((x) => void (x.shader && (x.shader.params[p.key] = c)), k)} />
          </div>
        ) : (
          <div key={p.key} className="k-param">
            <span>{p.label}</span>
            <Slider
              label={p.label}
              min={p.min ?? 0}
              max={p.max ?? 1}
              step={p.step ?? 0.01}
              value={Number(spec.params[p.key] ?? p.default)}
              onChange={(v, k) => set((x) => void (x.shader && (x.shader.params[p.key] = v)), 'shader-' + p.key + k)}
            />
            <span className="k-dim k-param-val">{Number(spec.params[p.key] ?? p.default).toFixed(2)}</span>
          </div>
        ),
      )}
    </Section>
  )
}

/* -------------------------------------------------------------- data */

function DataSection({ n, set }: { n: KNode; set: (r: Recipe, key?: string) => void }) {
  return (
    <Section title="Data & notes" collapsible defaultOpen={!!(n.binding || n.note)}>
      <input
        key={n.id + 'b'}
        className="k-text-input k-mono"
        placeholder="Bind to field, e.g. product.title"
        defaultValue={n.binding ?? ''}
        onBlur={(e) => set((x) => void (x.binding = e.target.value.trim() || undefined))}
      />
      <textarea
        key={n.id + 'n'}
        className="k-text-input"
        rows={2}
        placeholder="Notes for teammates and agents…"
        defaultValue={n.note ?? ''}
        onBlur={(e) => set((x) => void (x.note = e.target.value.trim() || undefined))}
      />
    </Section>
  )
}

