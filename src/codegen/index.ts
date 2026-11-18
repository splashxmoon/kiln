/**
 * Kiln design → code exporter.
 *
 * Every export goes through `nodeToCSS` (src/editor/style.ts), the mapping the
 * canvas renders with, so exported code matches the canvas. This module picks
 * semantic tags and class names, drops provably redundant declarations and
 * prints HTML, React (CSS modules), React + Tailwind v4 and Vue SFCs.
 */
import { cssObjectToString, fontStack, tokenVarName } from '../editor/style.ts'
import type { CSSObject } from '../editor/style.ts'
import type { KDoc, ShaderSpec, Token } from '../editor/types.ts'
import { escapeAttr, escapeHtml, cssRule, indent, isIdentifier, isSimpleText, jsString, pascalCase } from './format.ts'
import { cssToTailwind, fontUtility } from './tailwind.ts'
import { ancestorTags, buildTree, elementCSS, isAbsoluteChild, tagFor, visibleChildren } from './tree.ts'
import type { ExportElement, ExportTree, FontUse } from './tree.ts'

export type ExportTarget = 'html' | 'react' | 'tailwind' | 'vue'

export interface ExportFile {
  path: string
  contents: string
  language: 'html' | 'css' | 'tsx' | 'vue' | 'js' | 'json'
}

export interface ExportResult {
  files: ExportFile[]
  /** primary snippet shown in the inspector code tab */
  snippet: string
  snippetLanguage: ExportFile['language']
}

export type ShaderSnippetFn = (spec: ShaderSpec, id: string) => { html: string; js: string }

export interface ExportOptions {
  componentName?: string
  /** emit token colours as var(--token) (default: true when the doc has tokens) */
  useTokens?: boolean
  /** override the standalone shader generator (defaults to src/shaders/standalone.ts) */
  shaderSnippet?: ShaderSnippetFn
}

// ---------------------------------------------------------------- shader runtime

let loadedShaderSnippet: ShaderSnippetFn | null = null

/**
 * The standalone shader module is loaded lazily so this exporter keeps working
 * (and stays testable under plain Node) when it is missing. Resolves to whether
 * it loaded; await it before exporting shader layers if you need the runtime.
 */
export const shaderRuntimeReady: Promise<boolean> = import('../shaders/standalone.ts').then(
  (m: { shaderToStandaloneSnippet: ShaderSnippetFn }) => {
    loadedShaderSnippet = m.shaderToStandaloneSnippet
    return true
  },
  () => false,
)

function shaderJs(el: ExportElement, fn: ShaderSnippetFn | null): string {
  const spec = el.node.shader
  if (!spec || !el.shaderId) return '// This shader layer has no shader spec.'
  if (!fn) return '// The Kiln shader runtime (src/shaders/standalone.ts) was not available at export time.'
  return fn(spec, el.shaderId).js.trim()
}

// ---------------------------------------------------------------- fonts

const SYSTEM_FONTS = new Set(
  [
    'arial', 'helvetica', 'helvetica neue', 'times', 'times new roman', 'georgia', 'courier', 'courier new',
    'verdana', 'tahoma', 'trebuchet ms', 'system-ui', '-apple-system', 'blinkmacsystemfont', 'segoe ui',
    'menlo', 'monaco', 'consolas', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'sans-serif', 'serif', 'monospace',
  ],
)
/** Google families that only ship a regular weight (requesting others is a 400 error). */
const REGULAR_ONLY = new Set(['Instrument Serif'])

export function googleFontsHref(fonts: FontUse[]): string | null {
  const families = fonts.filter((f) => f.family.trim() && !SYSTEM_FONTS.has(f.family.toLowerCase()) && !/^sf (pro|mono)/i.test(f.family))
  if (!families.length) return null
  const parts = families.map((f) => {
    const name = f.family.trim().split(/\s+/).map(encodeURIComponent).join('+')
    const italic = f.styles.some((s) => s.startsWith('1,'))
    if (REGULAR_ONLY.has(f.family)) return italic ? `family=${name}:ital@0;1` : `family=${name}`
    if (!italic) return `family=${name}:wght@${[...new Set(f.styles.map((s) => s.split(',')[1]))].join(';')}`
    return `family=${name}:ital,wght@${f.styles.join(';')}`
  })
  return `https://fonts.googleapis.com/css2?${parts.join('&')}&display=swap`
}

function docFonts(doc: KDoc): FontUse[] {
  const map = new Map<string, Set<string>>()
  for (const id of Object.keys(doc.nodes).sort()) {
    const t = doc.nodes[id].text
    if (doc.nodes[id].type !== 'text' || !t) continue
    const set = map.get(t.fontFamily) ?? new Set<string>()
    set.add(`${t.italic ? 1 : 0},${t.fontWeight}`)
    map.set(t.fontFamily, set)
  }
  return [...map.keys()].sort().map((family) => ({ family, styles: [...(map.get(family) as Set<string>)].sort() }))
}

// ---------------------------------------------------------------- tokens

function uniqueTokens(tokens: Token[]): Token[] {
  const seen = new Set<string>()
  return tokens.filter((t) => {
    const v = tokenVarName(t)
    if (seen.has(v)) return false
    seen.add(v)
    return true
  })
}

function rootVarsBlock(tokens: Token[]): string {
  const groups: string[] = []
  for (const t of tokens) if (!groups.includes(t.group)) groups.push(t.group)
  const lines: string[] = []
  for (const g of groups) {
    if (groups.length > 1 && g) lines.push(`${lines.length ? '\n' : ''}/* ${g.replace(/\*\//g, '')} */`)
    for (const t of tokens) if (t.group === g) lines.push(`${tokenVarName(t)}: ${t.value};`)
  }
  return cssRule(':root', lines.join('\n'))
}

/** `:root { --brand-ember: #ff5b1f; ... }` for every colour token in the doc. */
export function exportTokensCSS(doc: KDoc): string {
  const tokens = uniqueTokens(doc.tokens)
  return tokens.length ? rootVarsBlock(tokens) + '\n' : ':root {}\n'
}

function tailwindTheme(tokens: Token[], fonts: FontUse[]): string {
  const blocks: string[] = []
  if (tokens.length) {
    blocks.push(rootVarsBlock(tokens))
    blocks.push(cssRule('@theme inline', tokens.map((t) => `--color-${tokenVarName(t).slice(2)}: var(${tokenVarName(t)});`).join('\n')))
  }
  if (fonts.length) {
    blocks.push(cssRule('@theme', fonts.map((f) => `--${fontUtility(f.family)}: ${fontStack(f.family)};`).join('\n')))
  }
  return blocks.join('\n\n')
}

/**
 * Tailwind v4 theme for the doc: tokens as `:root` variables (so `bg-(--brand-ember)`
 * works) mapped into `@theme inline` (so `bg-brand-ember` works too), plus a
 * `--font-*` entry for every font family used.
 */
export function exportTokensTailwind(doc: KDoc): string {
  const out = tailwindTheme(uniqueTokens(doc.tokens), docFonts(doc))
  return out ? out + '\n' : '@theme {}\n'
}

// ---------------------------------------------------------------- CSS tab

/** Declarations for one selected layer, in its real context on the canvas. */
export function nodeCSSDeclarations(doc: KDoc, nodeId: string): string {
  const node = doc.nodes[nodeId]
  if (!node) return ''
  const parent = node.parentId ? doc.nodes[node.parentId] ?? null : null
  const ancestors = ancestorTags(doc, node)
  const isRoot = !parent
  let precededByAbs = false
  if (parent) {
    for (const id of parent.children) {
      if (id === nodeId) break
      const sib = doc.nodes[id]
      if (sib && sib.visible && isAbsoluteChild(parent, sib)) precededByAbs = true
    }
  }
  const css = elementCSS(doc, node, parent, {
    tag: tagFor(node, isRoot, ancestors),
    isRoot,
    hasAbsChild: visibleChildren(doc, node).some((k) => isAbsoluteChild(node, k)),
    precededByAbs,
    insideButton: ancestors.includes('button'),
    tokenMode: doc.tokens.length ? 'var' : 'value',
  })
  return cssObjectToString(css, '')
}

// ---------------------------------------------------------------- shared

const TEXT_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p'])
const ORDERED_TAGS = ['h1', 'h2', 'h3', 'p']

/** Target-specific additions the canvas never needs (UA style resets). */
function withResets(el: ExportElement, isRoot: boolean, inlineResets: boolean): CSSObject {
  const head: CSSObject = {}
  const tail: CSSObject = {}
  const s = el.css
  if (inlineResets && TEXT_TAGS.has(el.tag)) head.margin = '0'
  if (inlineResets && isRoot && (el.tag === 'img' || el.tag === 'canvas' || el.tag === 'svg')) head.display = 'block'
  if (el.tag === 'button') {
    if (!('border' in s)) head.border = '0'
    if (!('padding' in s)) head.padding = '0'
    if (!('backgroundColor' in s) && !('backgroundImage' in s)) head.background = 'none'
    tail.cursor = 'pointer'
  }
  return { ...head, ...s, ...tail }
}

function cssRules(tree: ExportTree, inlineResets: boolean): string {
  return tree.elements
    .filter((el) => !el.bare)
    .map((el) => cssRule(`.${el.className}`, cssObjectToString(withResets(el, el === tree.root, inlineResets), '')))
    .join('\n\n')
}

function scopedBoxSizing(tree: ExportTree): string {
  const r = `.${tree.root.className}`
  return cssRule([r, `${r} *`], 'box-sizing: border-box;')
}

function fontsImport(tree: ExportTree): string | null {
  const href = googleFontsHref(tree.fonts)
  return href ? `@import url('${href}');` : null
}

/** Global CSS (fonts + tokens) for component targets, or null when empty. */
function globalCSS(tree: ExportTree): string | null {
  const parts = [fontsImport(tree), tree.tokens.length ? rootVarsBlock(tree.tokens) : null].filter((p): p is string => !!p)
  return parts.length ? parts.join('\n\n') + '\n' : null
}

function isVoidLike(el: ExportElement): boolean {
  return el.tag === 'img' || el.tag === 'canvas'
}

// ---------------------------------------------------------------- HTML

function renderHtml(el: ExportElement, depth: number): string {
  const pad = '  '.repeat(depth)
  const attrs = [...(el.bare ? [] : [['class', el.className] as [string, string]]), ...el.attrs].map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('')
  if (el.tag === 'img') return `${pad}<img${attrs} />`
  if (el.bare && !el.children.length) return `${pad}<${el.tag}${attrs} />`
  // text content is written verbatim: the canvas preserves white space
  if (el.text !== undefined) return `${pad}<${el.tag}${attrs}>${escapeHtml(el.text)}</${el.tag}>`
  if (!el.children.length) return `${pad}<${el.tag}${attrs}></${el.tag}>`
  return [`${pad}<${el.tag}${attrs}>`, ...el.children.map((c) => renderHtml(c, depth + 1)), `${pad}</${el.tag}>`].join('\n')
}

function htmlReset(tree: ExportTree): string {
  const tags = new Set(tree.elements.map((e) => e.tag))
  const rules = [
    cssRule(['*', '*::before', '*::after'], 'box-sizing: border-box;'),
    cssRule('body', 'margin: 0;\n-webkit-font-smoothing: antialiased;'),
  ]
  const text = ORDERED_TAGS.filter((t) => tags.has(t))
  if (text.length) rules.push(cssRule(text, 'margin: 0;'))
  const media = ['img', 'canvas', 'svg'].filter((t) => tags.has(t))
  if (media.length) rules.push(cssRule(media, 'display: block;'))
  return rules.join('\n\n')
}

function scriptTag(js: string, depth: number): string {
  const pad = '  '.repeat(depth)
  return `${pad}<script>\n${indent(js.replace(/<\/script/gi, '<\\/script'), depth + 1)}\n${pad}</script>`
}

function exportHtml(doc: KDoc, tree: ExportTree, shaderFn: ShaderSnippetFn | null): ExportResult {
  const title = tree.root.node.name.trim() || doc.name || 'Kiln export'
  const href = googleFontsHref(tree.fonts)
  const head = [
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${escapeHtml(title)}</title>`,
    ...(href
      ? [
          '<link rel="preconnect" href="https://fonts.googleapis.com" />',
          '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />',
          `<link rel="stylesheet" href="${escapeAttr(href)}" />`,
        ]
      : []),
    '<link rel="stylesheet" href="styles.css" />',
  ]
  const shaders = tree.elements.filter((e) => e.shaderId)
  const body = [renderHtml(tree.root, 2), ...shaders.map((el) => scriptTag(shaderJs(el, shaderFn), 2))]
  const html = [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    indent(head.join('\n'), 2),
    '  </head>',
    '  <body>',
    ...body,
    '  </body>',
    '</html>',
    '',
  ].join('\n')
  const css = [htmlReset(tree), tree.tokens.length ? rootVarsBlock(tree.tokens) : null, cssRules(tree, false)].filter(Boolean).join('\n\n') + '\n'
  return {
    files: [
      { path: 'index.html', contents: html, language: 'html' },
      { path: 'styles.css', contents: css, language: 'css' },
    ],
    snippet: renderHtml(tree.root, 0),
    snippetLanguage: 'html',
  }
}

// ---------------------------------------------------------------- JSX (React + Tailwind)

function jsxAttr(k: string, v: string): string {
  return /^[^"&\\{}<>\n]*$/.test(v) ? `${k}="${v}"` : `${k}={${jsString(v)}}`
}

function jsxText(text: string): string {
  return isSimpleText(text) && !/[{}<>&\\]/.test(text) ? text : `{${jsString(text)}}`
}

/** stroke-width → strokeWidth (SVG presentation attributes); aria-* and data-* stay as they are */
function jsxAttrName(k: string): string {
  return /^(aria|data)-/.test(k) ? k : k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

function renderJsx(el: ExportElement, depth: number, classAttr: (el: ExportElement) => string): string {
  const pad = '  '.repeat(depth)
  const attrs = [...(el.bare ? [] : [classAttr(el)]), ...el.attrs.map(([k, v]) => jsxAttr(jsxAttrName(k), v))].map((a) => ' ' + a).join('')
  const hasText = el.text !== undefined && el.text !== ''
  if (isVoidLike(el) || (!hasText && !el.children.length)) return `${pad}<${el.tag}${attrs} />`
  if (hasText) {
    const content = jsxText(el.text as string)
    const inline = `${pad}<${el.tag}${attrs}>${content}</${el.tag}>`
    if (inline.length <= 100) return inline
    return `${pad}<${el.tag}${attrs}>\n${pad}  ${content}\n${pad}</${el.tag}>`
  }
  return [`${pad}<${el.tag}${attrs}>`, ...el.children.map((c) => renderJsx(c, depth + 1, classAttr)), `${pad}</${el.tag}>`].join('\n')
}

function reactComponent(name: string, imports: string[], tree: ExportTree, shaderFn: ShaderSnippetFn | null, classAttr: (el: ExportElement) => string): string {
  const shaders = tree.elements.filter((e) => e.shaderId)
  const effects = shaders.map((el) => `  useEffect(() => {\n${indent(shaderJs(el, shaderFn), 2)}\n  }, [])\n`)
  return [
    ...(imports.length ? [imports.join('\n'), ''] : []),
    `export default function ${name}() {`,
    ...effects,
    '  return (',
    renderJsx(tree.root, 2, classAttr),
    '  )',
    '}',
    '',
  ].join('\n')
}

function exportReact(name: string, tree: ExportTree, shaderFn: ShaderSnippetFn | null): ExportResult {
  const global = globalCSS(tree)
  const imports = [
    ...(tree.elements.some((e) => e.shaderId) ? ["import { useEffect } from 'react'"] : []),
    ...(global ? ["import './global.css'"] : []),
    `import styles from './${name}.module.css'`,
  ]
  const classAttr = (el: ExportElement) => `className={${isIdentifier(el.className) ? `styles.${el.className}` : `styles[${jsString(el.className)}]`}}`
  const tsx = reactComponent(name, imports, tree, shaderFn, classAttr)
  const css = [scopedBoxSizing(tree), cssRules(tree, true)].join('\n\n') + '\n'
  const files: ExportFile[] = [
    { path: `${name}.tsx`, contents: tsx, language: 'tsx' },
    { path: `${name}.module.css`, contents: css, language: 'css' },
  ]
  if (global) files.push({ path: 'global.css', contents: global, language: 'css' })
  return { files, snippet: tsx, snippetLanguage: 'tsx' }
}

function exportTailwind(name: string, tree: ExportTree, shaderFn: ShaderSnippetFn | null): ExportResult {
  const imports = tree.elements.some((e) => e.shaderId) ? ["import { useEffect } from 'react'"] : []
  const classAttr = (el: ExportElement) => {
    const classes = cssToTailwind(el.css, { fontFamily: el.node.type === 'text' ? el.node.text?.fontFamily : undefined })
    if (el.tag === 'button') classes.push('cursor-pointer')
    return `className="${classes.join(' ')}"`
  }
  const tsx = reactComponent(name, imports, tree, shaderFn, classAttr)
  const fonts = fontsImport(tree)
  const theme = tailwindTheme(tree.tokens, tree.fonts)
  const css = [[fonts, "@import 'tailwindcss';"].filter(Boolean).join('\n'), theme].filter(Boolean).join('\n\n') + '\n'
  return {
    files: [
      { path: `${name}.tsx`, contents: tsx, language: 'tsx' },
      { path: 'tailwind.css', contents: css, language: 'css' },
    ],
    snippet: tsx,
    snippetLanguage: 'tsx',
  }
}

// ---------------------------------------------------------------- Vue

/** A JS string that is also safe inside a Vue template interpolation. */
function vueString(s: string): string {
  return jsString(s).replace(/[<>&}]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
}

function renderVue(el: ExportElement, depth: number): string {
  const pad = '  '.repeat(depth)
  const attrs = [...(el.bare ? [] : [['class', el.className] as [string, string]]), ...el.attrs].map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('')
  const hasText = el.text !== undefined && el.text !== ''
  if (isVoidLike(el) || (!hasText && !el.children.length)) return `${pad}<${el.tag}${attrs} />`
  if (hasText) {
    const t = el.text as string
    const content = isSimpleText(t) && !t.includes('{{') ? escapeHtml(t) : `{{ ${vueString(t)} }}`
    return `${pad}<${el.tag}${attrs}>${content}</${el.tag}>`
  }
  return [`${pad}<${el.tag}${attrs}>`, ...el.children.map((c) => renderVue(c, depth + 1)), `${pad}</${el.tag}>`].join('\n')
}

function exportVue(name: string, tree: ExportTree, shaderFn: ShaderSnippetFn | null): ExportResult {
  const shaders = tree.elements.filter((e) => e.shaderId)
  const blocks: string[] = []
  if (shaders.length) {
    const mounts = shaders.map((el) => `onMounted(() => {\n${indent(shaderJs(el, shaderFn), 1)}\n})`)
    blocks.push(['<script setup lang="ts">', "import { onMounted } from 'vue'", '', mounts.join('\n\n'), '</script>'].join('\n'))
  }
  blocks.push(['<template>', renderVue(tree.root, 1), '</template>'].join('\n'))
  const global = globalCSS(tree)
  if (global) blocks.push(`<style>\n${global}</style>`)
  blocks.push(`<style scoped>\n${[scopedBoxSizing(tree), cssRules(tree, true)].join('\n\n')}\n</style>`)
  const sfc = blocks.join('\n\n') + '\n'
  return { files: [{ path: `${name}.vue`, contents: sfc, language: 'vue' }], snippet: sfc, snippetLanguage: 'vue' }
}

// ---------------------------------------------------------------- entry

export function exportNode(doc: KDoc, nodeId: string, target: ExportTarget, opts: ExportOptions = {}): ExportResult {
  const useTokens = opts.useTokens ?? doc.tokens.length > 0
  const tree = buildTree(doc, nodeId, { tokenMode: useTokens ? 'var' : 'value' })
  const name = pascalCase(opts.componentName ?? tree.root.node.name, 'Component')
  const shaderFn = opts.shaderSnippet ?? loadedShaderSnippet
  switch (target) {
    case 'html':
      return exportHtml(doc, tree, shaderFn)
    case 'react':
      return exportReact(name, tree, shaderFn)
    case 'tailwind':
      return exportTailwind(name, tree, shaderFn)
    case 'vue':
      return exportVue(name, tree, shaderFn)
  }
}
