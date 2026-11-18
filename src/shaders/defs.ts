import type { ShaderKind, ShaderSpec } from '../editor/types'

export interface ShaderParamDef {
  key: string
  label: string
  type: 'number' | 'color'
  min?: number
  max?: number
  step?: number
  default: number | string
}

export interface ShaderDef {
  kind: ShaderKind
  label: string
  description: string
  params: ShaderParamDef[]
  defaultSpeed: number
  /** CSS gradient approximating the look, used for static thumbnails / code fallback */
  preview: string
}

/* Kiln house palette */
const EMBER = '#FF5B1F'
const BONE = '#EDE7DC'
const CLAY = '#C9A27E'
const CELADON = '#8FB8A8'
const INK = '#141413'
const PLUM = '#3B2A4A'

const color = (key: string, label: string, value: string): ShaderParamDef => ({ key, label, type: 'color', default: value })
const num = (key: string, label: string, min: number, max: number, step: number, value: number): ShaderParamDef => ({
  key,
  label,
  type: 'number',
  min,
  max,
  step,
  default: value,
})

/** Builds the CSS approximation from the kind's colour params (in param order). */
const PREVIEW_BUILDERS: Record<ShaderKind, (c: string[]) => string> = {
  aurora: (c) =>
    `radial-gradient(circle at 20% 24%, ${c[1]} 0%, transparent 52%), ` +
    `radial-gradient(circle at 82% 30%, ${c[2]} 0%, transparent 50%), ` +
    `radial-gradient(circle at 66% 90%, ${c[3]} 0%, transparent 55%), ` +
    `linear-gradient(${c[0]}, ${c[0]})`,
  grain: (c) =>
    `radial-gradient(circle at 76% 22%, ${c[3]} 0%, transparent 38%), ` +
    `radial-gradient(circle at 38% 62%, ${c[0]} 0%, ${c[1]} 36%, ${c[2]} 78%)`,
  halftone: (c) =>
    `radial-gradient(circle at 70% 75%, ${c[2]} 0%, transparent 45%), ` +
    `linear-gradient(135deg, ${c[0]} 0%, ${c[0]} 30%, ${c[1]} 100%)`,
  dither: (c) => `linear-gradient(170deg, ${c[3]} 0%, ${c[2]} 38%, ${c[1]} 70%, ${c[0]} 100%)`,
  ripple: (c) =>
    `radial-gradient(ellipse at 35% 25%, ${c[2]} 0%, transparent 45%), ` +
    `linear-gradient(0deg, ${c[0]} 0%, ${c[1]} 100%)`,
  voronoi: (c) =>
    `radial-gradient(circle at 25% 30%, ${c[0]} 0%, transparent 38%), ` +
    `radial-gradient(circle at 75% 35%, ${c[1]} 0%, transparent 40%), ` +
    `radial-gradient(circle at 50% 82%, ${c[2]} 0%, transparent 44%), ` +
    `linear-gradient(${c[3]}, ${c[3]})`,
  waves: (c) =>
    `linear-gradient(0deg, ${c[0]} 0% 25%, ${c[1]} 25% 50%, ${c[2]} 50% 75%, ${c[3]} 75% 100%)`,
}

interface DefSeed {
  kind: ShaderKind
  label: string
  description: string
  params: ShaderParamDef[]
  defaultSpeed: number
}

const SEEDS: DefSeed[] = [
  {
    kind: 'aurora',
    label: 'Aurora',
    description: 'A slow, flowing mesh gradient. Four colour anchors drift and melt into each other.',
    defaultSpeed: 0.4,
    params: [
      color('color1', 'Base', PLUM),
      color('color2', 'Glow', EMBER),
      color('color3', 'Warm', CLAY),
      color('color4', 'Light', BONE),
      num('scale', 'Scale', 0.2, 3, 0.05, 1),
      num('distortion', 'Distortion', 0, 1.5, 0.01, 0.6),
      num('softness', 'Softness', 0, 1, 0.01, 0.65),
      num('grain', 'Grain', 0, 0.3, 0.005, 0.05),
    ],
  },
  {
    kind: 'grain',
    label: 'Grain gradient',
    description: 'A soft radial glow dissolved with fine film grain.',
    defaultSpeed: 0.3,
    params: [
      color('color1', 'Core', EMBER),
      color('color2', 'Mid', CLAY),
      color('color3', 'Ground', BONE),
      color('color4', 'Accent', CELADON),
      num('radius', 'Radius', 0.2, 2, 0.01, 0.85),
      num('grain', 'Grain', 0, 1, 0.01, 0.35),
      num('softness', 'Softness', 0, 1, 0.01, 0.6),
      num('distortion', 'Distortion', 0, 1, 0.01, 0.35),
    ],
  },
  {
    kind: 'halftone',
    label: 'Halftone',
    description: 'A printed dot screen whose tone drifts like ink on paper.',
    defaultSpeed: 0.3,
    params: [
      color('color1', 'Paper', BONE),
      color('color2', 'Ink', PLUM),
      color('color3', 'Accent', EMBER),
      num('dotSize', 'Dot size', 3, 48, 1, 10),
      num('angle', 'Angle', 0, 90, 1, 30),
      num('contrast', 'Contrast', 0.2, 3, 0.05, 1.2),
      num('scale', 'Scale', 0.2, 4, 0.05, 1.2),
      num('softness', 'Softness', 0, 1, 0.01, 0.25),
    ],
  },
  {
    kind: 'dither',
    label: 'Dither',
    description: 'Flowing noise quantised to four tones with an ordered Bayer pattern.',
    defaultSpeed: 0.35,
    params: [
      color('color1', 'Shadow', INK),
      color('color2', 'Low', PLUM),
      color('color3', 'High', EMBER),
      color('color4', 'Light', BONE),
      num('pixelSize', 'Pixel size', 1, 12, 1, 3),
      num('scale', 'Scale', 0.2, 4, 0.05, 1.1),
      num('contrast', 'Contrast', 0.2, 3, 0.05, 1.1),
      num('distortion', 'Distortion', 0, 2, 0.01, 0.7),
    ],
  },
  {
    kind: 'ripple',
    label: 'Ripple',
    description: 'Liquid caustics: light refracting through a slow moving surface.',
    defaultSpeed: 0.4,
    params: [
      color('color1', 'Deep', PLUM),
      color('color2', 'Water', CELADON),
      color('color3', 'Light', BONE),
      num('scale', 'Scale', 0.2, 4, 0.05, 1),
      num('distortion', 'Distortion', 0, 1.5, 0.01, 0.8),
      num('sharpness', 'Sharpness', 1, 12, 0.1, 4),
      num('brightness', 'Brightness', 0, 1.5, 0.01, 0.7),
    ],
  },
  {
    kind: 'voronoi',
    label: 'Cells',
    description: 'Soft, pillowy cells that slowly shift, with glowing seams.',
    defaultSpeed: 0.35,
    params: [
      color('color1', 'Cell A', CLAY),
      color('color2', 'Cell B', CELADON),
      color('color3', 'Cell C', PLUM),
      color('color4', 'Seam', BONE),
      num('scale', 'Scale', 1, 14, 0.1, 4),
      num('border', 'Border', 0, 0.3, 0.005, 0.03),
      num('softness', 'Softness', 0, 1, 0.01, 0.5),
      num('motion', 'Motion', 0, 1, 0.01, 0.7),
    ],
  },
  {
    kind: 'waves',
    label: 'Waves',
    description: 'Stacked bands of colour that undulate like layered hills.',
    defaultSpeed: 0.35,
    params: [
      color('color1', 'Front', PLUM),
      color('color2', 'Near', EMBER),
      color('color3', 'Far', CLAY),
      color('color4', 'Sky', BONE),
      num('bands', 'Bands', 2, 24, 1, 9),
      num('amplitude', 'Amplitude', 0, 1, 0.01, 0.4),
      num('frequency', 'Frequency', 0.2, 4, 0.05, 1.2),
      num('softness', 'Softness', 0, 1, 0.01, 0.4),
    ],
  },
]

function colorDefaults(params: ShaderParamDef[]): string[] {
  return params.filter((p) => p.type === 'color').map((p) => String(p.default))
}

export const SHADER_DEFS: Record<ShaderKind, ShaderDef> = Object.fromEntries(
  SEEDS.map((s) => [s.kind, { ...s, preview: PREVIEW_BUILDERS[s.kind](colorDefaults(s.params)) }]),
) as Record<ShaderKind, ShaderDef>

export const SHADER_KINDS: ShaderKind[] = SEEDS.map((s) => s.kind)

export function defaultShaderSpec(kind: ShaderKind): ShaderSpec {
  const def = SHADER_DEFS[kind] ?? SHADER_DEFS.aurora
  const params: Record<string, number | string> = {}
  for (const p of def.params) params[p.key] = p.default
  return { kind: def.kind, params, speed: def.defaultSpeed }
}

/** Normalises '#rgb' / '#rrggbb' / '#rrggbbaa' to '#rrggbb', or returns null. */
export function normalizeHex(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(v)
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase()
  const long = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(v)
  return long ? `#${long[1]}`.toLowerCase() : null
}

/** Like `ShaderDef.preview`, but built from the spec's current colours. */
export function shaderPreviewCSS(spec: ShaderSpec): string {
  const def = SHADER_DEFS[spec.kind] ?? SHADER_DEFS.aurora
  const colors = def.params
    .filter((p) => p.type === 'color')
    .map((p) => normalizeHex(spec.params?.[p.key]) ?? String(p.default))
  return PREVIEW_BUILDERS[def.kind](colors)
}
