/**
 * Rasterise a layer to PNG (thumbnails, PNG export, agent screenshots).
 *
 * 1. Fast path: serialise the live DOM subtree into an SVG <foreignObject>
 *    (high fidelity in Chromium/Firefox).
 * 2. Fallback: a "box painter" that walks the laid-out DOM and paints
 *    backgrounds, borders, radii, images, shader canvases and text word by
 *    word using Range rects. Works in WebKit (Tauri on macOS) where
 *    foreignObject taints the canvas.
 */
import { measureSize, nodeEl } from './geometry'

export interface SnapshotOptions {
  scale?: number
  maxSize?: number
  background?: string
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

async function viaForeignObject(el: HTMLElement, w: number, h: number, scale: number, bg?: string): Promise<string> {
  const clone = el.cloneNode(true) as HTMLElement
  // shader canvases → images
  const srcCanvases = el.querySelectorAll('canvas')
  const dstCanvases = clone.querySelectorAll('canvas')
  srcCanvases.forEach((c, i) => {
    const img = document.createElement('img')
    try {
      img.src = c.toDataURL()
    } catch {
      /* ignore */
    }
    img.setAttribute('style', c.getAttribute('style') ?? '')
    img.style.width = '100%'
    img.style.height = '100%'
    dstCanvases[i]?.replaceWith(img)
  })
  clone.style.position = 'relative'
  clone.style.left = '0'
  clone.style.top = '0'
  clone.style.transform = 'none'
  clone.style.margin = '0'
  const xhtml = new XMLSerializer().serializeToString(clone)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><foreignObject x="0" y="0" width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="width:${w}px;height:${h}px;font-family:Geist,system-ui,sans-serif;">${xhtml}</div></foreignObject></svg>`
  const img = await loadImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(w * scale))
  canvas.height = Math.max(1, Math.round(h * scale))
  const ctx = canvas.getContext('2d')!
  if (bg) {
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }
  ctx.scale(scale, scale)
  ctx.drawImage(img, 0, 0)
  return canvas.toDataURL('image/png') // throws if tainted
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number[]) {
  ctx.beginPath()
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r.map((v) => Math.min(v, w / 2, h / 2)))
  else ctx.rect(x, y, w, h)
}

function firstGradientColor(bgImage: string) {
  return /(rgba?\([^)]*\)|#[0-9a-f]{3,8})/i.exec(bgImage)?.[1]
}

async function viaBoxPainter(el: HTMLElement, w: number, h: number, scale: number, bg?: string): Promise<string> {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(w * scale))
  canvas.height = Math.max(1, Math.round(h * scale))
  const ctx = canvas.getContext('2d')!
  if (bg) {
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }
  const base = el.getBoundingClientRect()
  const k = (w / base.width) * scale // screen px → output px
  const z = base.width / w // screen px per layout px (canvas zoom)
  ctx.scale(k, k)
  const imgCache = new Map<string, HTMLImageElement | null>()
  const getImg = async (src: string) => {
    if (imgCache.has(src)) return imgCache.get(src)!
    const img = await loadImage(src).catch(() => null)
    imgCache.set(src, img)
    return img
  }

  /** vector layers: replay each <path> with Path2D, stretched from the viewBox to the laid-out box */
  const paintSvg = (svg: SVGSVGElement, cs: CSSStyleDeclaration) => {
    const r = svg.getBoundingClientRect()
    const vb = svg.viewBox.baseVal
    const sx = vb && vb.width ? r.width / vb.width : z
    const sy = vb && vb.height ? r.height / vb.height : z
    ctx.save()
    ctx.globalAlpha *= Number(cs.opacity)
    const m = new DOMMatrix().translate(r.left - base.left, r.top - base.top).scale(sx, sy)
    for (const p of svg.querySelectorAll('path')) {
      const shape = new Path2D()
      shape.addPath(new Path2D(p.getAttribute('d') ?? ''), m)
      const pcs = getComputedStyle(p)
      let fill = pcs.fill
      if (fill.startsWith('url(')) {
        // gradients: approximate with their first stop
        const id = /#([^")]+)/.exec(fill)?.[1]
        const stop = id ? svg.querySelector(`[id="${CSS.escape(id)}"] stop`) : null
        fill = stop ? getComputedStyle(stop).stopColor : 'none'
      }
      if (fill && fill !== 'none') {
        ctx.fillStyle = fill
        ctx.fill(shape)
      }
      const sw = parseFloat(pcs.strokeWidth) || 0
      if (pcs.stroke && pcs.stroke !== 'none' && sw > 0) {
        // non-scaling stroke: its width is in layout px, not viewBox units
        ctx.lineWidth = sw * z
        ctx.strokeStyle = pcs.stroke
        ctx.lineCap = pcs.strokeLinecap as CanvasLineCap
        ctx.lineJoin = pcs.strokeLinejoin as CanvasLineJoin
        const dash = pcs.strokeDasharray
        ctx.setLineDash(dash && dash !== 'none' ? dash.split(/[\s,]+/).map((v) => (parseFloat(v) || 0) * z) : [])
        ctx.stroke(shape)
        ctx.setLineDash([])
      }
    }
    ctx.restore()
  }

  const paint = async (node: HTMLElement) => {
    const cs = getComputedStyle(node)
    if (cs.display === 'none' || cs.visibility === 'hidden') return
    if (node instanceof SVGSVGElement) return paintSvg(node, cs)
    const r = node.getBoundingClientRect()
    const x = r.left - base.left
    const y = r.top - base.top
    const radii = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map((v) =>
      v.endsWith('%') ? (parseFloat(v) / 100) * Math.min(r.width, r.height) : (parseFloat(v) || 0) * z,
    )
    ctx.save()
    ctx.globalAlpha *= Number(cs.opacity)
    // shadow (first drop shadow only)
    const sh = /(rgba?\([^)]*\))\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px/.exec(cs.boxShadow)
    if (sh && !cs.boxShadow.includes('inset')) {
      ctx.shadowColor = sh[1]
      ctx.shadowOffsetX = parseFloat(sh[2]) * scale
      ctx.shadowOffsetY = parseFloat(sh[3]) * scale
      ctx.shadowBlur = parseFloat(sh[4]) * scale
    }
    const bgColor = cs.backgroundColor
    const bgImg = cs.backgroundImage
    roundRectPath(ctx, x, y, r.width, r.height, radii)
    if (bgColor && !/rgba\(0, 0, 0, 0\)|transparent/.test(bgColor)) {
      ctx.fillStyle = bgColor
      ctx.fill()
    }
    ctx.shadowColor = 'transparent'
    if (bgImg && bgImg !== 'none') {
      const url = /url\("?(.*?)"?\)/.exec(bgImg)?.[1]
      if (url) {
        const img = await getImg(url)
        if (img) {
          ctx.save()
          roundRectPath(ctx, x, y, r.width, r.height, radii)
          ctx.clip()
          const s = Math.max(r.width / img.width, r.height / img.height)
          const iw = img.width * s
          const ih = img.height * s
          ctx.drawImage(img, x + (r.width - iw) / 2, y + (r.height - ih) / 2, iw, ih)
          ctx.restore()
        }
      }
      const lin = /linear-gradient\(([-\d.]+)deg,(.*)\)/.exec(bgImg)
      if (lin) {
        const ang = ((parseFloat(lin[1]) - 90) * Math.PI) / 180
        const cx = x + r.width / 2
        const cy = y + r.height / 2
        const len = (Math.abs(r.width * Math.cos(ang)) + Math.abs(r.height * Math.sin(ang))) / 2
        const g = ctx.createLinearGradient(cx - Math.cos(ang) * len, cy - Math.sin(ang) * len, cx + Math.cos(ang) * len, cy + Math.sin(ang) * len)
        const stops = [...lin[2].matchAll(/(rgba?\([^)]*\)|#[0-9a-f]{3,8})\s*([\d.]+)?%?/gi)]
        stops.forEach((m, i) => g.addColorStop(m[2] ? Math.min(1, parseFloat(m[2]) / 100) : i / Math.max(1, stops.length - 1), m[1]))
        roundRectPath(ctx, x, y, r.width, r.height, radii)
        ctx.fillStyle = g
        ctx.fill()
      } else if (!url) {
        const c = firstGradientColor(bgImg)
        if (c) {
          roundRectPath(ctx, x, y, r.width, r.height, radii)
          ctx.fillStyle = c
          ctx.fill()
        }
      }
    }
    const bw = parseFloat(cs.borderTopWidth) * z
    if (bw > 0 && cs.borderTopStyle !== 'none') {
      ctx.lineWidth = bw
      ctx.strokeStyle = cs.borderTopColor
      if (cs.borderTopStyle === 'dashed') ctx.setLineDash([bw * 3, bw * 2])
      roundRectPath(ctx, x + bw / 2, y + bw / 2, r.width - bw, r.height - bw, radii.map((v) => Math.max(0, v - bw / 2)))
      ctx.stroke()
      ctx.setLineDash([])
    }
    const clip = cs.overflow === 'hidden' || cs.overflow === 'clip'
    if (clip) {
      roundRectPath(ctx, x, y, r.width, r.height, radii)
      ctx.clip()
    }
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        const text = child.textContent ?? ''
        if (!text.trim()) continue
        ctx.fillStyle = cs.color
        const fsz = parseFloat(cs.fontSize) * z
        ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${fsz}px ${cs.fontFamily}`
        ctx.textBaseline = 'alphabetic'
        const t = cs.textTransform
        const range = document.createRange()
        // paint word by word so wrapping matches the DOM exactly
        const re = /\S+/g
        let m: RegExpExecArray | null
        while ((m = re.exec(text))) {
          range.setStart(child, m.index)
          range.setEnd(child, m.index + m[0].length)
          const rects = range.getClientRects()
          const wr = rects[0]
          if (!wr) continue
          const word = t === 'uppercase' ? m[0].toUpperCase() : t === 'lowercase' ? m[0].toLowerCase() : m[0]
          ctx.fillText(word, wr.left - base.left, wr.top - base.top + wr.height / 2 + fsz * 0.35)
        }
      } else if (child.nodeType === 1) {
        const c = child as HTMLElement
        if (c.tagName === 'CANVAS') {
          const cr = c.getBoundingClientRect()
          try {
            ctx.drawImage(c as HTMLCanvasElement, cr.left - base.left, cr.top - base.top, cr.width, cr.height)
          } catch {
            /* ignore */
          }
        } else if (c.tagName === 'IMG') {
          const cr = c.getBoundingClientRect()
          const img = await getImg((c as HTMLImageElement).src)
          if (img) ctx.drawImage(img, cr.left - base.left, cr.top - base.top, cr.width, cr.height)
        } else await paint(c)
      }
    }
    ctx.restore()
  }
  await paint(el)
  return canvas.toDataURL('image/png')
}

export async function snapshotNode(id: string, opts: SnapshotOptions = {}): Promise<string | null> {
  const el = nodeEl(id)
  if (!el) return null
  const size = measureSize(id)
  const w = size?.w ?? 0
  const h = size?.h ?? 0
  if (!w || !h) return null
  let scale = opts.scale ?? 1
  if (opts.maxSize) scale = Math.min(scale, opts.maxSize / Math.max(w, h))
  const hasCanvas = !!el.querySelector('canvas')
  const isWebKit = /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg/.test(navigator.userAgent)
  if (!hasCanvas && !isWebKit) {
    try {
      return await viaForeignObject(el, w, h, scale, opts.background)
    } catch {
      /* fall through */
    }
  }
  try {
    return await viaBoxPainter(el, w, h, scale, opts.background)
  } catch {
    return null
  }
}

export function dataURLToBase64(url: string) {
  return url.slice(url.indexOf(',') + 1)
}

export function downloadDataURL(url: string, filename: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
}
