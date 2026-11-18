/** Colour maths for Kiln's picker (no dependencies). */

export interface HSVA {
  h: number // 0..360
  s: number // 0..1
  v: number // 0..1
  a: number // 0..1
}

export interface RGBA {
  r: number
  g: number
  b: number
  a: number
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

export function parseColor(input: string): RGBA | null {
  const s = input.trim()
  let m = /^#?([0-9a-f]{3,4})$/i.exec(s)
  if (m) {
    const c = m[1].split('').map((x) => parseInt(x + x, 16))
    return { r: c[0], g: c[1], b: c[2], a: c[3] != null ? c[3] / 255 : 1 }
  }
  m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s)
  if (m) {
    const n = parseInt(m[1], 16)
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: m[2] ? parseInt(m[2], 16) / 255 : 1 }
  }
  m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/i.exec(s)
  if (m) {
    const a = m[4] == null ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])
    return { r: +m[1], g: +m[2], b: +m[3], a: clamp01(a) }
  }
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  return null
}

export function rgbToHsv({ r, g, b, a }: RGBA): HSVA {
  const R = r / 255
  const G = g / 255
  const B = b / 255
  const max = Math.max(R, G, B)
  const min = Math.min(R, G, B)
  const d = max - min
  let h = 0
  if (d) {
    if (max === R) h = ((G - B) / d) % 6
    else if (max === G) h = (B - R) / d + 2
    else h = (R - G) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s: max ? d / max : 0, v: max, a }
}

export function hsvToRgb({ h, s, v, a }: HSVA): RGBA {
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255), a }
}

const hex2 = (n: number) => Math.round(n).toString(16).padStart(2, '0').toUpperCase()

/** #RRGGBB, or #RRGGBBAA when alpha < 1 and `withAlpha` */
export function rgbToHex({ r, g, b, a }: RGBA, withAlpha = false): string {
  return '#' + hex2(r) + hex2(g) + hex2(b) + (withAlpha && a < 1 ? hex2(a * 255) : '')
}

export function hsvToHex(c: HSVA, withAlpha = false) {
  return rgbToHex(hsvToRgb(c), withAlpha)
}

export function hexToHsv(hex: string): HSVA | null {
  const c = parseColor(hex)
  return c ? rgbToHsv(c) : null
}

/* ------------------------------------------------------------- HSL */

export interface HSL {
  h: number // 0..360
  s: number // 0..100
  l: number // 0..100
}

export function rgbToHsl({ r, g, b }: RGBA): HSL {
  const R = r / 255
  const G = g / 255
  const B = b / 255
  const max = Math.max(R, G, B)
  const min = Math.min(R, G, B)
  const l = (max + min) / 2
  const d = max - min
  let h = 0
  let s = 0
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1))
    if (max === R) h = ((G - B) / d) % 6
    else if (max === G) h = (B - R) / d + 2
    else h = (R - G) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s: s * 100, l: l * 100 }
}

export function hslToRgb({ h, s, l }: HSL, a = 1): RGBA {
  const S = clamp01(s / 100)
  const L = clamp01(l / 100)
  const c = (1 - Math.abs(2 * L - 1)) * S
  const H = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((H % 2) - 1))
  const m = L - c / 2
  const [r, g, b] = H < 1 ? [c, x, 0] : H < 2 ? [x, c, 0] : H < 3 ? [0, c, x] : H < 4 ? [0, x, c] : H < 5 ? [x, 0, c] : [c, 0, x]
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255), a }
}

/* ------------------------------------------------------------- OKLCH (perceptual: L 0..100, C 0..~0.37, H 0..360) */

export interface LCH {
  l: number
  c: number
  h: number
}

const toLinear = (v: number) => {
  const x = v / 255
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
}
const fromLinear = (x: number) => 255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.max(0, x) ** (1 / 2.4) - 0.055)

export function rgbToOklch({ r, g, b }: RGBA): LCH {
  const R = toLinear(r)
  const G = toLinear(g)
  const B = toLinear(b)
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B)
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B)
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const Bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  const c = Math.hypot(A, Bb)
  let h = c < 1e-4 ? 0 : (Math.atan2(Bb, A) * 180) / Math.PI
  if (h < 0) h += 360
  return { l: L * 100, c: c < 1e-4 ? 0 : c, h }
}

/** OKLCH → sRGB, clipped into gamut. */
export function oklchToRgb({ l, c, h }: LCH, a = 1): RGBA {
  const L = l / 100
  const A = c * Math.cos((h * Math.PI) / 180)
  const B = c * Math.sin((h * Math.PI) / 180)
  const l_ = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m_ = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const s_ = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
  const R = 4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_
  const G = -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_
  const Bl = -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_
  const ch = (x: number) => Math.round(Math.min(255, Math.max(0, fromLinear(x))))
  return { r: ch(R), g: ch(G), b: ch(Bl), a }
}
