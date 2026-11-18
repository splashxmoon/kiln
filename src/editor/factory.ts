import { nanoid } from 'nanoid'
import { DOC_VERSION } from './migrate'
import type { Fill, KDoc, KNode, Layout, NodeType, Page, Shadow, ShaderSpec, TextStyle, Token } from './types'

export const uid = (n = 10) => nanoid(n)

export const DEFAULT_LAYOUT: Layout = {
  mode: 'none',
  direction: 'column',
  gap: 0,
  padding: [0, 0, 0, 0],
  align: 'start',
  justify: 'start',
  wrap: false,
}

export function solidFill(color: string, opacity = 1): Fill {
  return { id: uid(6), type: 'solid', visible: true, opacity, color, stops: [], angle: 180 }
}

export function linearFill(stops: [string, string], angle = 180): Fill {
  return {
    id: uid(6),
    type: 'linear',
    visible: true,
    opacity: 1,
    color: stops[0],
    angle,
    stops: [
      { pos: 0, color: stops[0] },
      { pos: 1, color: stops[1] },
    ],
  }
}

export function dropShadow(partial: Partial<Shadow> = {}): Shadow {
  return { id: uid(6), visible: true, type: 'drop', x: 0, y: 4, blur: 16, spread: 0, color: 'rgba(0, 0, 0, 0.12)', ...partial }
}

export const DEFAULT_TEXT: TextStyle = {
  content: 'Text',
  fontFamily: 'Geist',
  fontSize: 16,
  fontWeight: 400,
  lineHeight: 1.4,
  letterSpacing: 0,
  textAlign: 'left',
  color: '#141413',
  italic: false,
  decoration: 'none',
  transform: 'none',
}

const NAMES: Record<NodeType, string> = {
  frame: 'Frame',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  path: 'Path',
  text: 'Text',
  image: 'Image',
  shader: 'Shader',
}

export function createNode(type: NodeType, pageId: string, partial: Partial<KNode> = {}): KNode {
  const base: KNode = {
    id: uid(),
    type,
    name: NAMES[type],
    pageId,
    parentId: null,
    children: [],
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    widthMode: 'fixed',
    heightMode: 'fixed',
    positioning: 'auto',
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    radius: 0,
    clip: false,
    blend: 'normal',
    fills: [],
    stroke: null,
    shadows: [],
    blur: 0,
    backdropBlur: 0,
    layout: { ...DEFAULT_LAYOUT, padding: [0, 0, 0, 0] },
  }
  switch (type) {
    case 'frame':
      base.fills = [solidFill('#FFFFFF')]
      base.clip = true
      break
    case 'rect':
      base.fills = [solidFill('#D9D4CB')]
      break
    case 'ellipse':
      base.fills = [solidFill('#C9A27E')]
      break
    case 'path':
      base.stroke = { visible: true, color: '#141413', width: 2, style: 'solid', position: 'center' }
      base.path = { d: '', w: 100, h: 100, closed: false }
      break
    case 'text':
      base.text = { ...DEFAULT_TEXT }
      base.widthMode = 'hug'
      base.heightMode = 'hug'
      base.width = 40
      base.height = 22
      break
    case 'image':
      base.image = { src: '', fit: 'cover', alt: '' }
      base.fills = [solidFill('#E7E2D9')]
      break
    case 'shader':
      base.radius = 0
      break
  }
  return { ...base, ...partial }
}

export function createShaderNode(pageId: string, spec: ShaderSpec, partial: Partial<KNode> = {}): KNode {
  return createNode('shader', pageId, { shader: spec, name: `Shader / ${spec.kind}`, ...partial })
}

export function createPage(name: string, background = '#E9E6E1'): Page {
  return { id: uid(8), name, children: [], background }
}

export function createToken(name: string, value: string, group = 'color'): Token {
  return { id: uid(8), name, value, group }
}

export function emptyDoc(name = 'Untitled'): KDoc {
  const page = createPage('Page 1')
  const now = Date.now()
  return {
    version: DOC_VERSION,
    id: uid(12),
    name,
    createdAt: now,
    updatedAt: now,
    pages: [page],
    nodes: {},
    tokens: [
      createToken('ink', '#141413'),
      createToken('bone', '#EDE7DC'),
      createToken('ember', '#FF5B1F'),
      createToken('clay', '#C9A27E'),
    ],
    comments: [],
  }
}

/** Deep-clone a subtree with fresh ids. Returns [rootClone, allClones]. */
export function cloneSubtree(nodes: Record<string, KNode>, id: string, newParent: string | null, pageId: string): [KNode, KNode[]] {
  const out: KNode[] = []
  const walk = (srcId: string, parentId: string | null): KNode => {
    const src = nodes[srcId]
    const copy: KNode = JSON.parse(JSON.stringify(src))
    copy.id = uid()
    copy.parentId = parentId
    copy.pageId = pageId
    copy.fills = copy.fills.map((f) => ({ ...f, id: uid(6) }))
    copy.shadows = copy.shadows.map((s) => ({ ...s, id: uid(6) }))
    out.push(copy)
    copy.children = src.children.filter((c) => nodes[c]).map((c) => walk(c, copy.id).id)
    return copy
  }
  const root = walk(id, newParent)
  return [root, out]
}
