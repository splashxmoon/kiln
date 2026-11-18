/**
 * Small, dependency-free formatting helpers shared by the code exporters.
 */

/** Prefix every non-empty line with `level` indentation units. */
export function indent(text: string, level = 1, unit = '  '): string {
  const pad = unit.repeat(level)
  return text
    .split('\n')
    .map((line) => (line ? pad + line : line))
    .join('\n')
}

/** Escape text content for HTML. Newlines are kept (the canvas uses pre-wrap). */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Escape a double-quoted HTML attribute value. */
export function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;')
}

/** A JS string literal (double quoted, JSON-escaped). */
export function jsString(s: string): string {
  return JSON.stringify(s)
}

/** Normalise line endings in user text. */
export function normalizeText(s: string): string {
  return s.replace(/\r\n?/g, '\n')
}

/**
 * True when collapsing white space cannot change how the text renders: no line
 * breaks or tabs, no runs of spaces, nothing leading or trailing.
 */
export function isSimpleText(s: string): boolean {
  return !/[\n\t]/.test(s) && !/ {2}/.test(s) && s.trim() === s
}

/** "Primary Button", "primaryButton", "Card / Title" → "primary-button", "card-title". */
export function kebabCase(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** "pricing card" → "PricingCard". Always returns a valid JS identifier. */
export function pascalCase(input: string, fallback = 'Component'): string {
  const out = kebabCase(input)
    .split('-')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('')
  if (!out) return fallback
  return /^[0-9]/.test(out) ? fallback + out : out
}

/**
 * Returns a function that hands out unique names: "card", "card-2", "card-3"...
 * Deterministic for a given call order.
 */
export function createNameRegistry(): (base: string) => string {
  const used = new Set<string>()
  return (base: string) => {
    let name = base
    for (let i = 2; used.has(name); i++) name = `${base}-${i}`
    used.add(name)
    return name
  }
}

/** True when `s` can be used as a bare JS property name (`styles.card`). */
export function isIdentifier(s: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(s)
}

/** A CSS rule block. `body` is a list of `prop: value;` lines (unindented). */
export function cssRule(selector: string | string[], body: string): string {
  const sel = Array.isArray(selector) ? selector.join(',\n') : selector
  return `${sel} {\n${indent(body)}\n}`
}
