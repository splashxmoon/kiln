/**
 * CSS declarations → Tailwind v4 utilities. Standard scale classes are used
 * only when they are exact; everything else becomes an arbitrary value or an
 * arbitrary property, so the result renders identically to the CSS export.
 */
import { kebab, UNITLESS } from '../editor/style.ts'
import type { CSSObject } from '../editor/style.ts'
import { kebabCase } from './format.ts'

/** v3-style spacing scale in 0.25rem units (what people recognise as "the scale"). */
const SPACING = new Set([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 72, 80, 96])
const RADIUS: Record<number, string> = { 2: 'xs', 4: 'sm', 6: 'md', 8: 'lg', 12: 'xl', 16: '2xl', 24: '3xl', 32: '4xl' }
const FONT_SIZE: Record<number, string> = { 12: 'xs', 14: 'sm', 16: 'base', 18: 'lg', 20: 'xl', 24: '2xl', 30: '3xl', 36: '4xl', 48: '5xl', 60: '6xl', 72: '7xl', 96: '8xl', 128: '9xl' }
const FONT_WEIGHT: Record<number, string> = { 100: 'thin', 200: 'extralight', 300: 'light', 400: 'normal', 500: 'medium', 600: 'semibold', 700: 'bold', 800: 'extrabold', 900: 'black' }
const LEADING: Record<number, string> = { 1: 'none', 1.25: 'tight', 1.375: 'snug', 1.5: 'normal', 1.625: 'relaxed', 2: 'loose' }
const TRACKING: Record<number, string> = { [-0.05]: 'tighter', [-0.025]: 'tight', 0: 'normal', 0.025: 'wide', 0.05: 'wider', 0.1: 'widest' }
const BLUR: Record<number, string> = { 4: 'xs', 8: 'sm', 12: 'md', 16: 'lg', 24: 'xl', 40: '2xl', 64: '3xl' }
const ALIGN: Record<string, string> = { 'flex-start': 'start', 'flex-end': 'end', center: 'center', stretch: 'stretch', baseline: 'baseline' }
const JUSTIFY: Record<string, string> = { 'flex-start': 'start', 'flex-end': 'end', center: 'center', 'space-between': 'between', 'space-around': 'around', 'space-evenly': 'evenly' }

function px(v: string): number | null {
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(v)
  return m ? Number(m[1]) : null
}

/** Arbitrary-value encoding: spaces → _, literal _ → \_ (url() is left alone), " → '. */
export function arb(value: string): string {
  return value
    .replace(/"/g, "'")
    .replace(/,\s+/g, ',')
    .split(/(url\([^)]*\))/)
    .map((part) => (part.startsWith('url(') ? part : part.replace(/_/g, '\\_').replace(/\s+/g, '_')))
    .join('')
}

/** spacing-like utility: p-4, -left-2, w-px, gap-[13px] */
function spacing(prefix: string, v: string, allowNegative = false): string {
  const n = px(v)
  if (n !== null) {
    const neg = n < 0 && allowNegative
    const abs = Math.abs(n)
    if (n >= 0 || neg) {
      const key = abs === 1 ? 'px' : SPACING.has(abs / 4) ? String(abs / 4) : null
      if (key) return `${neg ? '-' : ''}${prefix}-${key}`
    }
  }
  return `${prefix}-[${arb(v)}]`
}

function size(prefix: 'w' | 'h' | 'size', v: string): string {
  if (v === 'fit-content') return `${prefix}-fit`
  if (v === 'max-content') return `${prefix}-max`
  if (v === 'min-content') return `${prefix}-min`
  if (v === '100%') return `${prefix}-full`
  if (v === 'auto') return `${prefix}-auto`
  return spacing(prefix, v)
}

export function colorClass(prefix: string, v: string): string {
  const c = v.trim()
  const varRef = /^var\((--[\w-]+)\)$/.exec(c)
  if (varRef) return `${prefix}-(${varRef[1]})`
  const lower = c.toLowerCase()
  if (lower === '#fff' || lower === '#ffffff') return `${prefix}-white`
  if (lower === '#000' || lower === '#000000') return `${prefix}-black`
  if (lower === 'transparent') return `${prefix}-transparent`
  if (/^#[0-9a-f]{3,8}$/i.test(c) || /^(rgba?|hsla?)\(/i.test(c)) return `${prefix}-[${arb(c)}]`
  return `${prefix}-[color:${arb(c)}]`
}

/** Split a top-level comma list (ignores commas inside parentheses). */
function topLevelCount(v: string): number {
  let depth = 0
  let n = 1
  for (const ch of v) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ',' && depth === 0) n++
  }
  return n
}

function padding(v: string): string[] {
  const parts = v.split(/\s+/)
  const [t, r, b, l] = parts.length === 1 ? [parts[0], parts[0], parts[0], parts[0]] : parts
  if (t === r && r === b && b === l) return [spacing('p', t)]
  const out: string[] = []
  if (l === r) out.push(spacing('px', l))
  if (t === b) out.push(spacing('py', t))
  if (t !== b) out.push(spacing('pt', t), spacing('pb', b))
  if (l !== r) out.push(spacing('pr', r), spacing('pl', l))
  return out
}

/** "1px solid #e5e5e5" → width/style/colour utilities. */
function line(prefix: 'border' | 'outline', v: string): string[] {
  const m = /^(\d+(?:\.\d+)?)px (solid|dashed|dotted) (.+)$/.exec(v)
  if (!m) return [`[${prefix}:${arb(v)}]`]
  const w = Number(m[1])
  const out: string[] = []
  if (prefix === 'border') out.push(w === 1 ? 'border' : [0, 2, 4, 8].includes(w) ? `border-${w}` : `border-[${w}px]`)
  else out.push(w === 1 ? 'outline' : Number.isInteger(w) ? `outline-${w}` : `outline-[${w}px]`)
  if (m[2] !== 'solid') out.push(`${prefix}-${m[2]}`)
  out.push(colorClass(prefix, m[3]))
  return out
}

function blur(prefix: 'blur' | 'backdrop-blur', v: string, prop: string): string {
  const m = /^blur\((\d+(?:\.\d+)?)px\)$/.exec(v)
  if (!m) return `[${prop}:${arb(v)}]`
  const n = Number(m[1])
  return BLUR[n] ? `${prefix}-${BLUR[n]}` : `${prefix}-[${n}px]`
}

export interface TailwindContext {
  /** font family name of a text layer, for the `font-<family>` theme utility */
  fontFamily?: string
}

export function fontUtility(family: string): string {
  return `font-${kebabCase(family) || 'sans'}`
}

/** Convert a cleaned CSS object to an ordered list of utilities. */
export function cssToTailwind(css: CSSObject, ctx: TailwindContext = {}): string[] {
  const val = (k: string): string | undefined => {
    const v = css[k]
    if (v === undefined) return undefined
    return typeof v === 'number' && !UNITLESS.has(k) ? `${v}px` : String(v)
  }
  const out: string[] = []
  const w = val('width')
  const h = val('height')
  const sameSize = w !== undefined && w === h && px(w) !== null && !size('size', w).includes('[')

  for (const k of Object.keys(css)) {
    const v = val(k) as string
    switch (k) {
      case 'display':
        out.push(v === 'flex' ? 'flex' : v === 'none' ? 'hidden' : v === 'block' ? 'block' : `[display:${arb(v)}]`)
        break
      case 'position':
        out.push(v)
        break
      case 'left':
      case 'top':
      case 'right':
      case 'bottom':
        out.push(spacing(k, v, true))
        break
      case 'width':
        out.push(sameSize ? size('size', v) : size('w', v))
        break
      case 'height':
        if (!sameSize) out.push(size('h', v))
        break
      case 'minWidth':
        out.push(spacing('min-w', v))
        break
      case 'minHeight':
        out.push(spacing('min-h', v))
        break
      case 'maxWidth':
        out.push(spacing('max-w', v))
        break
      case 'flexDirection':
        out.push(v === 'column' ? 'flex-col' : v === 'row' ? 'flex-row' : `flex-${v.replace('column', 'col')}`)
        break
      case 'flexWrap':
        out.push(`flex-${v}`)
        break
      case 'gap':
        out.push(spacing('gap', v))
        break
      case 'alignItems':
        out.push(ALIGN[v] ? `items-${ALIGN[v]}` : `[align-items:${arb(v)}]`)
        break
      case 'alignSelf':
        out.push(ALIGN[v] ? `self-${ALIGN[v]}` : `[align-self:${arb(v)}]`)
        break
      case 'justifyContent':
        out.push(JUSTIFY[v] ? `justify-${JUSTIFY[v]}` : `[justify-content:${arb(v)}]`)
        break
      case 'flex':
        out.push(v === '1' ? 'flex-1' : `flex-[${arb(v)}]`)
        break
      case 'flexShrink':
        out.push(v === '0' ? 'shrink-0' : `shrink-[${v}]`)
        break
      case 'padding':
        out.push(...padding(v))
        break
      case 'margin':
        out.push(spacing('m', v === '0' ? '0px' : v))
        break
      case 'backgroundColor':
        out.push(colorClass('bg', v))
        break
      case 'backgroundImage': {
        const alone = css.backgroundSize === undefined && css.backgroundRepeat === undefined && css.backgroundPosition === undefined
        out.push(alone ? `[background:${arb(v)}]` : `[background-image:${arb(v)}]`)
        break
      }
      case 'backgroundSize':
        out.push(v === 'cover' || v === 'contain' || v === 'auto' ? `bg-${v}` : `[background-size:${arb(v)}]`)
        break
      case 'backgroundRepeat':
        out.push(v === 'no-repeat' || v === 'repeat' ? `bg-${v}` : `[background-repeat:${arb(v)}]`)
        break
      case 'backgroundPosition':
        out.push(v === 'center' ? 'bg-center' : `[background-position:${arb(v)}]`)
        break
      case 'borderRadius': {
        const n = px(v)
        out.push(n !== null && RADIUS[n] ? `rounded-${RADIUS[n]}` : n === 0 ? 'rounded-none' : `rounded-[${arb(v)}]`)
        break
      }
      case 'overflow':
        out.push(`overflow-${v}`)
        break
      case 'opacity': {
        const pct = Number(v) * 100
        out.push(Number.isInteger(Math.round(pct * 1000) / 1000) ? `opacity-${Math.round(pct)}` : `opacity-[${v}]`)
        break
      }
      case 'transform': {
        const m = /^rotate\((-?\d+(?:\.\d+)?)deg\)$/.exec(v)
        if (m && Number.isInteger(Number(m[1]))) {
          const deg = Number(m[1])
          out.push(`${deg < 0 ? '-' : ''}rotate-${Math.abs(deg)}`)
        } else if (m) out.push(`rotate-[${m[1]}deg]`)
        else out.push(`[transform:${arb(v)}]`)
        break
      }
      case 'mixBlendMode':
        out.push(`mix-blend-${v}`)
        break
      case 'border':
        out.push(...line('border', v))
        break
      case 'outline':
        out.push(...line('outline', v))
        break
      case 'outlineOffset': {
        const n = px(v)
        if (n !== null && Number.isInteger(n)) out.push(`${n < 0 ? '-' : ''}outline-offset-${Math.abs(n)}`)
        else out.push(`outline-offset-[${arb(v)}]`)
        break
      }
      case 'boxShadow':
        out.push(topLevelCount(v) > 1 ? `[box-shadow:${arb(v)}]` : `shadow-[${arb(v)}]`)
        break
      case 'textShadow':
        out.push(`[text-shadow:${arb(v)}]`)
        break
      case 'filter':
        out.push(blur('blur', v, 'filter'))
        break
      case 'backdropFilter':
        out.push(blur('backdrop-blur', v, 'backdrop-filter'))
        break
      case 'fontFamily':
        out.push(ctx.fontFamily ? fontUtility(ctx.fontFamily) : `font-[family-name:${arb(v)}]`)
        break
      case 'fontSize': {
        const n = px(v)
        out.push(n !== null && FONT_SIZE[n] ? `text-${FONT_SIZE[n]}` : n !== null ? `text-[${v}]` : `text-[length:${arb(v)}]`)
        break
      }
      case 'fontWeight':
        out.push(FONT_WEIGHT[Number(v)] ? `font-${FONT_WEIGHT[Number(v)]}` : `font-[${v}]`)
        break
      case 'lineHeight':
        out.push(LEADING[Number(v)] ? `leading-${LEADING[Number(v)]}` : `leading-[${v}]`)
        break
      case 'letterSpacing': {
        const n = Number(v.replace(/em$/, ''))
        out.push(v.endsWith('em') && TRACKING[n] ? `tracking-${TRACKING[n]}` : `tracking-[${arb(v)}]`)
        break
      }
      case 'textAlign':
        out.push(`text-${v}`)
        break
      case 'color':
        out.push(colorClass('text', v))
        break
      case 'fontStyle':
        out.push(v === 'italic' ? 'italic' : 'not-italic')
        break
      case 'textDecoration':
        out.push(v === 'underline' ? 'underline' : v === 'line-through' ? 'line-through' : 'no-underline')
        break
      case 'textTransform':
        out.push(v === 'none' ? 'normal-case' : v)
        break
      case 'whiteSpace':
        out.push(`whitespace-${v}`)
        break
      case 'overflowWrap':
        out.push(v === 'break-word' ? 'break-words' : `[overflow-wrap:${arb(v)}]`)
        break
      case 'objectFit':
        out.push(`object-${v}`)
        break
      case 'cursor':
        out.push(`cursor-${v}`)
        break
      default:
        out.push(`[${kebab(k)}:${arb(v)}]`)
    }
  }
  return out
}
