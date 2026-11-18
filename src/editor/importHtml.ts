/**
 * HTML → Kiln layers. Used for pasting HTML and by agents (`write_html`).
 * The markup is rendered off-screen inside a shadow root (so its <style>
 * tags can't leak), then every element's *computed* style is read back and
 * mapped onto native Kiln layers with real flex layout where possible.
 */
import type { Fill, KNode, Shadow } from './types'
import { createNode, uid } from './factory'
import { ensureFont, FONT_FAMILIES } from './fonts'

const SKIP = new Set(['SCRIPT', 'STYLE', 'META', 'LINK', 'HEAD', 'TITLE', 'NOSCRIPT', 'TEMPLATE', 'BR'])
const TRANSPARENT = /^(transparent|rgba\(0, 0, 0, 0\))$/

function px(v: string) {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : 0
}

function splitTopLevel(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      out.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

function parseShadows(v: string): Shadow[] {
  if (!v || v === 'none') return []
  return splitTopLevel(v).map((part) => {
    const color = /(rgba?\([^)]*\)|#[0-9a-f]+)/i.exec(part)?.[1] ?? 'rgba(0,0,0,0.2)'
    const rest = part.replace(color, '').trim()
    const inset = /\binset\b/.test(rest)
    const nums = rest.replace('inset', '').trim().split(/\s+/).map(px)
    return { id: uid(6), visible: true, type: inset ? 'inner' : 'drop', x: nums[0] ?? 0, y: nums[1] ?? 0, blur: nums[2] ?? 0, spread: nums[3] ?? 0, color }
  })
}

function parseGradient(v: string): Fill | null {
  const m = /^(linear|radial)-gradient\((.*)\)$/.exec(v.trim())
  if (!m) return null
  const parts = splitTopLevel(m[2])
  let angle = 180
  if (m[1] === 'linear' && /deg|^to /.test(parts[0])) {
    const a = parts.shift()!
    if (a.endsWith('deg')) angle = parseFloat(a)
    else angle = ({ 'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270 } as Record<string, number>)[a] ?? 180
  } else if (m[1] === 'radial' && !/^(rgb|#|hsl)/.test(parts[0])) parts.shift()
  const stops = parts.map((p, i) => {
    const color = /(rgba?\([^)]*\)|#[0-9a-f]+|[a-z]+)/i.exec(p)?.[1] ?? '#000'
    const pos = /(-?[\d.]+)%/.exec(p.replace(color, ''))
    return { color, pos: pos ? parseFloat(pos[1]) / 100 : parts.length > 1 ? i / (parts.length - 1) : 0 }
  })
  if (stops.length < 2) return null
  return { id: uid(6), type: m[1] as 'linear' | 'radial', visible: true, opacity: 1, color: stops[0].color, stops, angle }
}

function firstFamily(ff: string) {
  const f = ff.split(',')[0].trim().replace(/^["']|["']$/g, '')
  return f || 'Geist'
}

const ALIGN: Record<string, KNode['layout']['align']> = {
  'flex-start': 'start', start: 'start', normal: 'stretch', stretch: 'stretch', center: 'center', 'flex-end': 'end', end: 'end', baseline: 'baseline',
}
const JUSTIFY: Record<string, KNode['layout']['justify']> = {
  'flex-start': 'start', start: 'start', normal: 'start', center: 'center', 'flex-end': 'end', end: 'end',
  'space-between': 'space-between', 'space-around': 'space-around', 'space-evenly': 'space-evenly',
}

function nameFor(el: Element) {
  const tag = el.tagName.toLowerCase()
  const cls = (el.getAttribute('class') ?? '').trim().split(/\s+/)[0]
  const id = el.id
  const base: Record<string, string> = { button: 'Button', a: 'Link', nav: 'Nav', header: 'Header', footer: 'Footer', section: 'Section', main: 'Main', aside: 'Aside', ul: 'List', li: 'Item', form: 'Form', input: 'Input', label: 'Label', h1: 'Heading', h2: 'Heading', h3: 'Heading', p: 'Paragraph', img: 'Image' }
  const label = id || (cls && !/^(w-|h-|p-|m-|flex|grid|text-|bg-)/.test(cls) ? cls : '')
  return (base[tag] ?? (tag === 'div' || tag === 'span' ? 'Frame' : tag)) + (label ? ' / ' + label : '')
}

export interface ImportResult {
  nodes: KNode[]
  rootIds: string[]
}

export function htmlToNodes(html: string, pageId: string, opts: { width?: number } = {}): ImportResult {
  const host = document.createElement('div')
  host.style.cssText = `position:fixed;left:-20000px;top:0;width:${opts.width ?? 1280}px;opacity:0;pointer-events:none;`
  document.body.appendChild(host)
  const root = host.attachShadow({ mode: 'open' })
  root.innerHTML = `<style>:host{all:initial;display:block;font-family:Geist,system-ui,sans-serif;color:#141413}*{box-sizing:border-box}</style><div id="__k">${html}</div>`
  const container = root.getElementById('__k')!
  const nodes: KNode[] = []

  try {
    const families = new Set<string>()
    const elements = [...container.children].filter((c) => !SKIP.has(c.tagName))
    // load fonts referenced so measurement is right on the next pass
    container.querySelectorAll('*').forEach((el) => families.add(firstFamily(getComputedStyle(el).fontFamily)))
    families.forEach((f) => FONT_FAMILIES.some((x) => x.family === f) && ensureFont(f))

    const textNode = (text: string, cs: CSSStyleDeclaration, parentId: string | null, rect: DOMRect, inline: boolean, name?: string): KNode => {
      const n = createNode('text', pageId)
      n.parentId = parentId
      n.name = name ?? text.trim().slice(0, 32)
      const fs = px(cs.fontSize) || 16
      const lh = cs.lineHeight === 'normal' ? 1.2 : px(cs.lineHeight) / fs
      n.text = {
        content: text.replace(/\s+/g, ' ').trim(),
        fontFamily: firstFamily(cs.fontFamily),
        fontSize: Math.round(fs * 100) / 100,
        fontWeight: Number(cs.fontWeight) || 400,
        lineHeight: Math.round(lh * 100) / 100,
        letterSpacing: cs.letterSpacing === 'normal' ? 0 : Math.round((px(cs.letterSpacing) / fs) * 1000) / 1000,
        textAlign: (['center', 'right', 'justify'].includes(cs.textAlign) ? cs.textAlign : 'left') as 'left',
        color: cs.color,
        italic: cs.fontStyle === 'italic',
        decoration: cs.textDecorationLine.includes('underline') ? 'underline' : cs.textDecorationLine.includes('line-through') ? 'line-through' : 'none',
        transform: (['uppercase', 'lowercase', 'capitalize'].includes(cs.textTransform) ? cs.textTransform : 'none') as 'none',
      }
      const lines = Math.round(rect.height / (lh * fs))
      if (inline || lines <= 1) {
        n.widthMode = 'hug'
      } else {
        n.widthMode = 'fixed'
        n.width = Math.ceil(rect.width) + 1
      }
      n.heightMode = 'hug'
      n.width = Math.ceil(rect.width)
      n.height = Math.ceil(rect.height)
      nodes.push(n)
      return n
    }

    const walk = (el: Element, parentId: string | null, parentRect: DOMRect | null, parentFlex: { dir: 'row' | 'column' } | null): KNode | null => {
      if (SKIP.has(el.tagName)) return null
      const cs = getComputedStyle(el)
      if (cs.display === 'none' || cs.visibility === 'hidden') return null
      const rect = el.getBoundingClientRect()
      const tag = el.tagName
      const place = (n: KNode) => {
        n.parentId = parentId
        if (parentRect && !parentFlex) {
          n.x = Math.round(rect.left - parentRect.left)
          n.y = Math.round(rect.top - parentRect.top)
        }
        if (cs.position === 'absolute' && parentRect) {
          n.positioning = 'absolute'
          n.x = Math.round(rect.left - parentRect.left)
          n.y = Math.round(rect.top - parentRect.top)
        }
      }
      const common = (n: KNode) => {
        n.opacity = Number(cs.opacity)
        const r = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map(px)
        n.radius = r.every((v) => v === r[0]) ? r[0] : (r as [number, number, number, number])
        n.shadows = parseShadows(cs.boxShadow)
        const bw = px(cs.borderTopWidth)
        if (bw > 0 && cs.borderTopStyle !== 'none') n.stroke = { visible: true, color: cs.borderTopColor, width: bw, style: (['dashed', 'dotted'].includes(cs.borderTopStyle) ? cs.borderTopStyle : 'solid') as 'solid', position: 'inside' }
        const fills: Fill[] = []
        if (cs.backgroundImage && cs.backgroundImage !== 'none') {
          for (const layer of splitTopLevel(cs.backgroundImage)) {
            const g = parseGradient(layer)
            if (g) fills.push(g)
            const url = /url\("?(.*?)"?\)/.exec(layer)?.[1]
            if (url) fills.push({ id: uid(6), type: 'image', visible: true, opacity: 1, color: '#000', stops: [], angle: 0, src: url, fit: cs.backgroundSize === 'contain' ? 'contain' : 'cover' })
          }
        }
        if (!TRANSPARENT.test(cs.backgroundColor)) fills.push({ id: uid(6), type: 'solid', visible: true, opacity: 1, color: cs.backgroundColor, stops: [], angle: 180 })
        n.fills = fills
        if (cs.overflow === 'hidden' || cs.overflow === 'clip') n.clip = true
        const blur = /blur\(([\d.]+)px\)/.exec(cs.filter)
        if (blur) n.blur = parseFloat(blur[1])
        const bblur = /blur\(([\d.]+)px\)/.exec(cs.backdropFilter ?? '')
        if (bblur) n.backdropBlur = parseFloat(bblur[1])
        if (cs.mixBlendMode && cs.mixBlendMode !== 'normal') n.blend = cs.mixBlendMode as KNode['blend']
      }

      if (tag === 'IMG') {
        const n = createNode('image', pageId, { name: (el as HTMLImageElement).alt || 'Image', fills: [] })
        n.image = { src: (el as HTMLImageElement).src, fit: cs.objectFit === 'contain' ? 'contain' : 'cover', alt: (el as HTMLImageElement).alt }
        n.width = Math.round(rect.width) || 200
        n.height = Math.round(rect.height) || 150
        common(n)
        n.fills = []
        place(n)
        nodes.push(n)
        return n
      }
      if (tag.toLowerCase() === 'svg') {
        const clone = el.cloneNode(true) as SVGElement
        clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
        clone.setAttribute('width', String(rect.width))
        clone.setAttribute('height', String(rect.height))
        clone.setAttribute('color', cs.color)
        const src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(clone).replace(/currentColor/g, cs.color))
        const n = createNode('image', pageId, { name: 'Icon', fills: [], width: Math.round(rect.width), height: Math.round(rect.height) })
        n.image = { src, fit: 'contain', alt: '' }
        place(n)
        nodes.push(n)
        return n
      }

      const kids = [...el.childNodes].filter((c) => (c.nodeType === 1 && !SKIP.has((c as Element).tagName)) || (c.nodeType === 3 && c.textContent!.trim()))
      const onlyText = kids.length > 0 && kids.every((c) => c.nodeType === 3 || (c.nodeType === 1 && ['B', 'STRONG', 'EM', 'I', 'SPAN', 'A', 'CODE', 'SMALL'].includes((c as Element).tagName) && !(c as Element).children.length && getComputedStyle(c as Element).display.startsWith('inline')))
      const hasBox =
        !TRANSPARENT.test(cs.backgroundColor) || (cs.backgroundImage && cs.backgroundImage !== 'none') || px(cs.borderTopWidth) > 0 || px(cs.paddingLeft) > 0 || px(cs.paddingTop) > 0 || cs.boxShadow !== 'none'

      if (onlyText && !hasBox) {
        const inline = cs.display.startsWith('inline') || !!parentFlex
        const n = textNode(el.textContent ?? '', cs, parentId, rect, inline, nameFor(el) === 'Frame' ? undefined : (el.textContent ?? '').trim().slice(0, 32))
        if (parentRect && !parentFlex) {
          n.x = Math.round(rect.left - parentRect.left)
          n.y = Math.round(rect.top - parentRect.top)
        }
        if (parentFlex?.dir === 'column' && !inline && parentRect) n.widthMode = 'fill'
        common(n)
        n.fills = []
        n.radius = 0
        return n
      }

      // ----- frame
      const n = createNode('frame', pageId, { name: nameFor(el), fills: [], clip: false })
      common(n)
      place(n)
      const isFlex = cs.display === 'flex' || cs.display === 'inline-flex'
      const isBlockFlow = !isFlex && ['block', 'flow-root', 'list-item', 'inline-block'].includes(cs.display)
      n.layout.padding = [px(cs.paddingTop), px(cs.paddingRight), px(cs.paddingBottom), px(cs.paddingLeft)].map(Math.round) as [number, number, number, number]
      let childFlex: { dir: 'row' | 'column' } | null = null
      if (isFlex) {
        const dir = cs.flexDirection.startsWith('column') ? 'column' : 'row'
        n.layout = { ...n.layout, mode: 'flex', direction: dir, gap: Math.round(px(dir === 'row' ? cs.columnGap : cs.rowGap)), align: ALIGN[cs.alignItems] ?? 'stretch', justify: JUSTIFY[cs.justifyContent] ?? 'start', wrap: cs.flexWrap === 'wrap' }
        childFlex = { dir }
      } else if (isBlockFlow) {
        n.layout = { ...n.layout, mode: 'flex', direction: 'column', gap: 0, align: 'stretch', justify: 'start' }
        childFlex = { dir: 'column' }
      }
      n.width = Math.round(rect.width)
      n.height = Math.round(rect.height)
      if (parentFlex) {
        const grow = Number(cs.flexGrow) > 0
        if (parentFlex.dir === 'row') {
          n.widthMode = grow ? 'fill' : isFlex ? 'hug' : 'fixed'
          n.heightMode = isFlex || isBlockFlow ? 'hug' : 'fixed'
        } else {
          n.widthMode = parentRect && Math.abs(rect.width - (parentRect.width - 0)) < 2 ? 'fill' : cs.display.startsWith('inline') ? 'hug' : grow ? 'fill' : 'fill'
          n.heightMode = grow ? 'fill' : isFlex || isBlockFlow ? 'hug' : 'fixed'
        }
        if (n.widthMode === 'hug' && !isFlex) n.widthMode = 'fixed'
      } else {
        n.widthMode = 'fixed'
        n.heightMode = isFlex || isBlockFlow ? 'hug' : 'fixed'
      }
      if (!kids.length) n.heightMode = 'fixed'
      if (n.heightMode === 'hug' && !childFlex) n.heightMode = 'fixed'
      nodes.push(n)

      // block flow: derive gap from consistent vertical spacing
      const contentRect = new DOMRect(rect.left + px(cs.borderLeftWidth), rect.top + px(cs.borderTopWidth), rect.width, rect.height)
      const childIds: string[] = []
      const rects: DOMRect[] = []
      for (const c of kids) {
        if (c.nodeType === 3) {
          const range = document.createRange()
          range.selectNodeContents(c)
          const r = range.getBoundingClientRect()
          const t = textNode(c.textContent ?? '', cs, n.id, r, true)
          if (!childFlex) {
            t.x = Math.round(r.left - contentRect.left)
            t.y = Math.round(r.top - contentRect.top)
          }
          childIds.push(t.id)
          rects.push(r)
        } else {
          const child = walk(c as Element, n.id, contentRect, childFlex)
          if (child) {
            childIds.push(child.id)
            rects.push((c as Element).getBoundingClientRect())
          }
        }
      }
      if (isBlockFlow && rects.length > 1) {
        const gaps = rects.slice(1).map((r, i) => r.top - rects[i].bottom)
        const g = Math.max(0, Math.round(Math.min(...gaps)))
        n.layout.gap = g
      }
      if (isFlex && cs.flexDirection.endsWith('reverse')) childIds.reverse()
      n.children = childIds
      return n
    }

    const roots: KNode[] = []
    const fromText = [...container.childNodes].filter((c) => c.nodeType === 3 && c.textContent!.trim())
    for (const el of elements) {
      const r = walk(el, null, null, null)
      if (r) roots.push(r)
    }
    if (!roots.length && fromText.length) {
      const range = document.createRange()
      range.selectNodeContents(container)
      roots.push(textNode(container.textContent ?? '', getComputedStyle(container), null, range.getBoundingClientRect(), true))
    }
    // stack multiple roots vertically
    let y = 0
    for (const r of roots) {
      r.x = 0
      r.y = y
      y += r.height + 40
      if (r.widthMode === 'fill') r.widthMode = 'fixed'
      if (r.heightMode === 'fill') r.heightMode = 'fixed'
    }
    // order: nodes array must have roots reachable; return all
    return { nodes, rootIds: roots.map((r) => r.id) }
  } finally {
    host.remove()
  }
}

export function looksLikeHtml(text: string) {
  const t = text.trim()
  return /^<([a-z][a-z0-9-]*)(\s|>|\/)/i.test(t) && /<\/[a-z]|\/>/i.test(t)
}
