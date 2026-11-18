/**
 * Kiln's own eyedropper (WebKit has no EyeDropper API): a veil with a pipette
 * cursor; a click renders the artboard under the pointer and reads that pixel.
 * Empty canvas gives the page colour, the app's own chrome its background.
 */
import { getEditor } from './store'
import { snapshotNode } from './snapshot'
import { nodeEl } from './geometry'
import { parseColor, rgbToHex } from '../ui/color'

const PIPETTE_PATHS = ['m2 22 1-1h3l9-9', 'M3 21v-3l9-9', 'm15 6 3.4-3.4a2.1 2.1 0 1 1 3 3l-3.4 3.4.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z']
const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round">` +
  PIPETTE_PATHS.map((d) => `<path d="${d}" stroke="#fff" stroke-width="4"/>`).join('') +
  PIPETTE_PATHS.map((d) => `<path d="${d}" stroke="#141413" stroke-width="1.75"/>`).join('') +
  `</svg>`
const CURSOR = `url("data:image/svg+xml,${encodeURIComponent(svg)}") 2 22, crosshair`

let active = false

export function sampleCanvasColor(): Promise<string | null> {
  if (active) return Promise.resolve(null)
  active = true
  return new Promise((resolve) => {
    const veil = document.createElement('div')
    veil.className = 'k-eyedrop'
    veil.style.cursor = CURSOR
    // counts as a popover above every open one, so pressing it doesn't close the picker
    veil.setAttribute('data-k-popover', '')
    veil.setAttribute('data-k-depth', '999')
    const hint = document.createElement('div')
    hint.className = 'k-eyedrop-hint'
    hint.textContent = 'Click to pick a colour · Esc to cancel'
    veil.appendChild(hint)
    document.body.appendChild(veil)

    const move = (e: PointerEvent) => {
      // beside the pointer, flipped to stay inside the window
      const w = hint.offsetWidth
      const h = hint.offsetHeight
      const x = e.clientX + 16 + w > window.innerWidth - 8 ? e.clientX - 12 - w : e.clientX + 16
      const y = e.clientY + 18 + h > window.innerHeight - 8 ? e.clientY - 12 - h : e.clientY + 18
      hint.style.left = Math.round(x) + 'px'
      hint.style.top = Math.round(y) + 'px'
      hint.style.opacity = '1'
    }
    let result: Promise<string | null> | null = null
    let done = false
    const finish = (hex: string | null) => {
      if (done) return
      done = true
      veil.removeEventListener('pointermove', move)
      veil.removeEventListener('pointerdown', down)
      veil.removeEventListener('click', click)
      veil.removeEventListener('pointerup', up)
      window.removeEventListener('keydown', key, true)
      veil.remove()
      active = false
      resolve(hex)
    }
    const down = (e: PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.button !== 0) return finish(null)
      // look underneath for this instant only; the veil stays up to swallow the rest of the click
      veil.style.pointerEvents = 'none'
      const els = document.elementsFromPoint(e.clientX, e.clientY)
      veil.style.pointerEvents = ''
      hint.style.opacity = '0'
      result = sampleAt(e.clientX, e.clientY, els).catch(() => null)
    }
    // a press that turns into a drag never clicks: finish shortly after release anyway
    const up = () => window.setTimeout(() => result && void result.then(finish), 80)
    const click = (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (result) void result.then(finish)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      finish(null)
    }
    veil.addEventListener('pointermove', move)
    veil.addEventListener('pointerdown', down)
    veil.addEventListener('click', click)
    veil.addEventListener('pointerup', up)
    window.addEventListener('keydown', key, true)
  })
}

async function sampleAt(x: number, y: number, els: Element[]): Promise<string | null> {
  const s = getEditor()
  // a layer on the canvas: render its artboard and read the pixel
  const hit = els.find((el) => el.closest('.k-world [data-id]'))
  if (hit) {
    let id = (hit.closest('[data-id]') as HTMLElement).dataset.id!
    while (s.doc.nodes[id]?.parentId) id = s.doc.nodes[id].parentId!
    const el = nodeEl(id)
    const page = s.doc.pages.find((p) => p.id === s.pageId)
    if (el) {
      const r = el.getBoundingClientRect()
      const zoom = s.camera.zoom
      // enough resolution that one screen pixel is one sample, without huge renders
      const scale = Math.min(2, Math.max(0.1, zoom * (window.devicePixelRatio || 1)))
      const url = await snapshotNode(id, { scale, background: page?.background })
      if (url) {
        const img = await loadImage(url)
        const c = document.createElement('canvas')
        c.width = img.width
        c.height = img.height
        const ctx = c.getContext('2d', { willReadFrequently: true })!
        ctx.drawImage(img, 0, 0)
        const px = Math.min(img.width - 1, Math.max(0, Math.floor(((x - r.left) / r.width) * img.width)))
        const py = Math.min(img.height - 1, Math.max(0, Math.floor(((y - r.top) / r.height) * img.height)))
        const d = ctx.getImageData(px, py, 1, 1).data
        return rgbToHex({ r: d[0], g: d[1], b: d[2], a: 1 })
      }
    }
  }
  // empty canvas: the page colour
  if (els.some((el) => el.closest('.k-stage')) && !els[0]?.closest('.k-toolbar, .k-left-mini')) {
    const page = s.doc.pages.find((p) => p.id === s.pageId)
    const c = page && parseColor(page.background)
    if (c) return rgbToHex({ ...c, a: 1 })
  }
  // anything else on screen: the first painted background under the point
  for (const el of els) {
    const c = parseColor(getComputedStyle(el).backgroundColor)
    if (c && c.a > 0) return rgbToHex({ ...c, a: 1 })
  }
  return null
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}
