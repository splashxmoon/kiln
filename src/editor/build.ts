/**
 * Tiny declarative builder for node trees, used by presets, the starter
 * template and agent quick actions.
 *
 *   h('frame', { name: 'Card', flex: 'column', gap: 12, pad: 24, fill: '#fff' }, [
 *     h('text', { text: 'Hello', size: 24, weight: 600 }),
 *   ])
 */
import type { KNode, NodeType, ShaderKind, SizeMode } from './types'
import { createNode, dropShadow, linearFill, solidFill } from './factory'
import { defaultShaderSpec } from '../shaders/defs'

export interface Spec {
  type: NodeType
  props: BuildProps
  children: Spec[]
}

export interface BuildProps {
  name?: string
  x?: number
  y?: number
  w?: number | 'hug' | 'fill'
  h?: number | 'hug' | 'fill'
  flex?: 'row' | 'column'
  gap?: number
  pad?: number | [number, number] | [number, number, number, number]
  align?: KNode['layout']['align']
  justify?: KNode['layout']['justify']
  wrap?: boolean
  fill?: string | null
  gradient?: [string, string, number?]
  radius?: number | [number, number, number, number]
  stroke?: string | [string, number]
  shadow?: 'sm' | 'md' | 'lg' | 'none'
  clip?: boolean
  opacity?: number
  absolute?: boolean
  // text
  text?: string
  size?: number
  weight?: number
  font?: string
  color?: string
  lh?: number
  ls?: number
  textAlign?: 'left' | 'center' | 'right'
  italic?: boolean
  upper?: boolean
  // image / shader
  src?: string
  alt?: string
  shader?: ShaderKind
  shaderParams?: Record<string, number | string>
  speed?: number
  blur?: number
  backdropBlur?: number
  binding?: string
  maxW?: number
}

export function h(type: NodeType, props: BuildProps = {}, children: Spec[] = []): Spec {
  return { type, props, children }
}
export const t = (text: string, props: BuildProps = {}) => h('text', { text, ...props })

function sizeOf(v: BuildProps['w'], fallback: number): [number, SizeMode] {
  if (v === 'hug') return [fallback, 'hug']
  if (v === 'fill') return [fallback, 'fill']
  if (typeof v === 'number') return [v, 'fixed']
  return [fallback, 'fixed']
}

/** Materialise a spec into nodes (root first). parentId is the root's parent. */
export function build(spec: Spec, pageId: string, parentId: string | null = null): KNode[] {
  const out: KNode[] = []
  const walk = (s: Spec, parent: string | null): KNode => {
    const p = s.props
    const n = createNode(s.type, pageId)
    n.parentId = parent
    if (p.name) n.name = p.name
    n.x = p.x ?? 0
    n.y = p.y ?? 0
    const defW = s.type === 'text' ? 40 : 100
    const defH = s.type === 'text' ? 20 : 100
    const isText = s.type === 'text'
    ;[n.width, n.widthMode] = sizeOf(p.w ?? (isText ? 'hug' : s.type === 'frame' && p.flex ? 'hug' : undefined), defW)
    ;[n.height, n.heightMode] = sizeOf(p.h ?? (isText ? 'hug' : s.type === 'frame' && p.flex ? 'hug' : undefined), defH)
    if (p.flex) {
      n.layout.mode = 'flex'
      n.layout.direction = p.flex
    }
    if (p.gap != null) n.layout.gap = p.gap
    if (p.pad != null) {
      const v = p.pad
      n.layout.padding = typeof v === 'number' ? [v, v, v, v] : v.length === 2 ? [v[0], v[1], v[0], v[1]] : v
    }
    if (p.align) n.layout.align = p.align
    if (p.justify) n.layout.justify = p.justify
    if (p.wrap) n.layout.wrap = true
    if (p.fill !== undefined) n.fills = p.fill ? [solidFill(p.fill)] : []
    else if (s.type === 'frame' && parent) n.fills = []
    if (p.gradient) n.fills = [linearFill([p.gradient[0], p.gradient[1]], p.gradient[2] ?? 180)]
    if (p.radius != null) n.radius = p.radius
    if (p.stroke) {
      const [c, w] = Array.isArray(p.stroke) ? p.stroke : [p.stroke, 1]
      n.stroke = { visible: true, color: c, width: w, style: 'solid', position: 'inside' }
    }
    if (p.shadow && p.shadow !== 'none') {
      n.shadows =
        p.shadow === 'sm'
          ? [dropShadow({ y: 1, blur: 2, color: 'rgba(20, 20, 19, 0.08)' })]
          : p.shadow === 'md'
            ? [dropShadow({ y: 4, blur: 14, color: 'rgba(20, 20, 19, 0.10)' }), dropShadow({ y: 1, blur: 2, color: 'rgba(20, 20, 19, 0.06)' })]
            : [dropShadow({ y: 24, blur: 48, spread: -12, color: 'rgba(20, 20, 19, 0.22)' }), dropShadow({ y: 2, blur: 6, color: 'rgba(20, 20, 19, 0.06)' })]
    }
    if (p.clip != null) n.clip = p.clip
    else if (s.type === 'frame' && parent) n.clip = false
    if (p.opacity != null) n.opacity = p.opacity
    if (p.absolute) n.positioning = 'absolute'
    if (p.blur) n.blur = p.blur
    if (p.backdropBlur) n.backdropBlur = p.backdropBlur
    if (p.binding) n.binding = p.binding
    if (p.maxW) n.maxWidth = p.maxW
    if (isText && n.text) {
      n.text.content = p.text ?? ''
      if (p.size) n.text.fontSize = p.size
      if (p.weight) n.text.fontWeight = p.weight
      if (p.font) n.text.fontFamily = p.font
      if (p.color) n.text.color = p.color
      if (p.lh) n.text.lineHeight = p.lh
      if (p.ls != null) n.text.letterSpacing = p.ls
      if (p.textAlign) n.text.textAlign = p.textAlign
      if (p.italic) n.text.italic = true
      if (p.upper) n.text.transform = 'uppercase'
      if (!p.name) n.name = (p.text ?? 'Text').split('\n')[0].slice(0, 32)
    }
    if (s.type === 'image') {
      n.image = { src: p.src ?? '', fit: 'cover', alt: p.alt ?? '' }
      if (p.src) n.fills = []
    }
    if (s.type === 'shader') {
      const spec = defaultShaderSpec(p.shader ?? 'aurora')
      if (p.shaderParams) spec.params = { ...spec.params, ...p.shaderParams }
      if (p.speed != null) spec.speed = p.speed
      n.shader = spec
      if (!p.name) n.name = `Shader / ${spec.kind}`
    }
    out.push(n)
    n.children = s.children.map((c) => walk(c, n.id).id)
    return n
  }
  walk(spec, parentId)
  return out
}
