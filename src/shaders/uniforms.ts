import type { ShaderSpec } from '../editor/types'
import { SHADER_DEFS, normalizeHex } from './defs'

export type RGB = [number, number, number]

/** Uniform values for one spec: always 4 colours (u_c0..u_c3) and 5 numbers (u_p0..u_p4). */
export interface ResolvedUniforms {
  colors: RGB[]
  numbers: number[]
}

export function hexToRgb(value: unknown): RGB | null {
  const hex = normalizeHex(value)
  if (!hex) return null
  const n = parseInt(hex.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/** Maps a spec's params to uniforms in param order, falling back to defaults for missing/invalid values. */
export function resolveUniforms(spec: ShaderSpec): ResolvedUniforms {
  const def = SHADER_DEFS[spec.kind] ?? SHADER_DEFS.aurora
  const colors: RGB[] = []
  const numbers: number[] = []
  for (const p of def.params) {
    const raw = spec.params?.[p.key]
    if (p.type === 'color') {
      colors.push(hexToRgb(raw) ?? hexToRgb(p.default) ?? [0, 0, 0])
    } else {
      let n = typeof raw === 'number' ? raw : typeof raw === 'string' ? parseFloat(raw) : NaN
      if (!Number.isFinite(n)) n = Number(p.default)
      numbers.push(n)
    }
  }
  while (colors.length < 4) colors.push(colors[colors.length - 1] ?? [0, 0, 0])
  while (numbers.length < 5) numbers.push(0)
  return { colors: colors.slice(0, 4), numbers: numbers.slice(0, 5) }
}
