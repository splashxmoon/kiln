/**
 * Kiln document model.
 *
 * Every node maps 1:1 to a real DOM element styled with real CSS, so what you
 * draw is what ships. Nodes live in a flat map keyed by id; hierarchy is
 * expressed with parentId + children (ordered back-to-front, i.e. the last
 * child paints on top, exactly like DOM order).
 */

export type NodeType = 'frame' | 'rect' | 'ellipse' | 'path' | 'text' | 'image' | 'shader'

export type ShaderKind =
  | 'aurora' // flowing mesh-like colour field
  | 'grain' // grainy radial gradient
  | 'halftone' // animated dot screen
  | 'dither' // ordered bayer dither of noise
  | 'ripple' // liquid caustics / ripples
  | 'voronoi' // soft cells
  | 'waves' // stacked sine bands

export interface GradientStop {
  pos: number // 0..1
  color: string // any CSS colour, usually #rrggbb or rgba()
}

export interface Fill {
  id: string
  type: 'solid' | 'linear' | 'radial' | 'image'
  visible: boolean
  opacity: number // 0..1
  /** solid colour (when type === 'solid'); may be ignored when tokenId is set */
  color: string
  /** design-token reference; when set it wins over `color` */
  tokenId?: string
  stops: GradientStop[]
  angle: number // degrees, linear gradients
  src?: string // image fills (data url or http url)
  fit?: 'cover' | 'contain' | 'fill' | 'tile'
}

export interface Stroke {
  visible: boolean
  color: string
  width: number
  style: 'solid' | 'dashed' | 'dotted'
  /** inside → inset box-shadow, center → border, outside → outline */
  position: 'inside' | 'center' | 'outside'
}

export interface Shadow {
  id: string
  visible: boolean
  type: 'drop' | 'inner'
  x: number
  y: number
  blur: number
  spread: number
  color: string
}

export type Align = 'start' | 'center' | 'end' | 'stretch' | 'baseline'
export type Justify = 'start' | 'center' | 'end' | 'space-between' | 'space-around' | 'space-evenly'

export interface Layout {
  mode: 'none' | 'flex'
  direction: 'row' | 'column'
  gap: number
  /** [top, right, bottom, left] */
  padding: [number, number, number, number]
  align: Align
  justify: Justify
  wrap: boolean
}

export type SizeMode = 'fixed' | 'hug' | 'fill'

export interface TextStyle {
  content: string
  fontFamily: string
  fontSize: number
  fontWeight: number
  lineHeight: number // multiplier, e.g. 1.4
  letterSpacing: number // em, e.g. -0.02
  textAlign: 'left' | 'center' | 'right' | 'justify'
  color: string
  tokenId?: string
  italic: boolean
  decoration: 'none' | 'underline' | 'line-through'
  transform: 'none' | 'uppercase' | 'lowercase' | 'capitalize'
}

/** A pen-tool anchor. Handles are absolute (same space as the point), absent = sharp corner. */
export interface PathPoint {
  x: number
  y: number
  in?: { x: number; y: number }
  out?: { x: number; y: number }
}

/**
 * Vector geometry. `d` is SVG path data in a `w × h` box (the viewBox); the
 * layer stretches that box to its own width / height. `points` is kept when the
 * path was drawn with the pen tool.
 */
export interface VectorPath {
  d: string
  w: number
  h: number
  closed: boolean
  points?: PathPoint[]
}

export interface ShaderSpec {
  kind: ShaderKind
  /** numeric params and colour params (#rrggbb). Keys defined per kind in SHADER_DEFS */
  params: Record<string, number | string>
  speed: number // 0 = static
}

export interface BaseNode {
  id: string
  type: NodeType
  name: string
  pageId: string
  parentId: string | null // null → top-level on the page (an "artboard" when a frame)
  children: string[]

  /** position relative to parent's padding box origin (or canvas origin when top-level). Ignored for flow children of flex parents. */
  x: number
  y: number
  width: number
  height: number
  widthMode: SizeMode
  heightMode: SizeMode
  minWidth?: number
  maxWidth?: number

  /** 'absolute' children inside a flex frame ignore the flow */
  positioning: 'auto' | 'absolute'

  rotation: number
  opacity: number // 0..1
  visible: boolean
  locked: boolean
  /** uniform radius or [tl, tr, br, bl] */
  radius: number | [number, number, number, number]
  clip: boolean
  blend: 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten' | 'color-dodge' | 'color-burn' | 'difference' | 'exclusion' | 'hue' | 'saturation' | 'color' | 'luminosity'

  fills: Fill[]
  stroke: Stroke | null
  shadows: Shadow[]
  blur: number // layer blur px
  backdropBlur: number // backdrop blur px

  layout: Layout // only meaningful on frames; always present for simplicity
  text?: TextStyle
  image?: { src: string; fit: 'cover' | 'contain' | 'fill'; alt: string }
  shader?: ShaderSpec
  path?: VectorPath

  /** optional link to a data source field, e.g. "products[0].title" */
  binding?: string
  /** free-form notes left by humans or agents */
  note?: string

  /**
   * Components (components.ts). `main` marks a main component's root. `source` is set on every
   * layer of an instance: the id of the main's layer it mirrors (an instance root's source is a
   * main root). Changes to a main flow into its instances, keeping what an instance overrode.
   */
  main?: true
  source?: string
}

export type KNode = BaseNode

export interface Page {
  id: string
  name: string
  /** top-level node ids, back-to-front */
  children: string[]
  background: string
}

export interface Token {
  id: string
  name: string // e.g. "brand/ember"
  value: string // colour
  group: string
}

export interface Comment {
  id: string
  pageId: string
  x: number
  y: number
  nodeId?: string
  author: string
  body: string
  createdAt: number
  resolved: boolean
  replies: { id: string; author: string; body: string; createdAt: number }[]
}

export interface KDoc {
  /**
   * File format version (see migrate.ts). Files saved before versioning have none and
   * count as 0; every open runs `migrate()` to bring them up to DOC_VERSION.
   */
  version?: number
  id: string
  name: string
  createdAt: number
  updatedAt: number
  pages: Page[]
  nodes: Record<string, KNode>
  tokens: Token[]
  comments: Comment[]
  /** small data-url preview for the files dashboard */
  thumbnail?: string
}

export type Tool = 'move' | 'hand' | 'frame' | 'rect' | 'ellipse' | 'pen' | 'text' | 'image' | 'shader' | 'comment'

export interface Camera {
  x: number // screen px offset of world origin
  y: number
  zoom: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}
