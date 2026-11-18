import { getEditor } from './store'
import { createNode } from './factory'

export function readAsDataURL(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

export function imageSize(src: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ w: img.naturalWidth || 400, h: img.naturalHeight || 300 })
    img.onerror = () => resolve({ w: 400, h: 300 })
    img.src = src
  })
}

/** Downscale very large images so documents stay light. */
async function compress(src: string, max = 2000): Promise<string> {
  const { w, h } = await imageSize(src)
  if (Math.max(w, h) <= max || src.startsWith('data:image/svg')) return src
  const scale = max / Math.max(w, h)
  const c = document.createElement('canvas')
  c.width = Math.round(w * scale)
  c.height = Math.round(h * scale)
  const img = new Image()
  img.src = src
  await img.decode().catch(() => {})
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
  return c.toDataURL('image/jpeg', 0.88)
}

export async function insertImageFiles(files: File[], at: { x: number; y: number }) {
  const s = getEditor()
  const created: string[] = []
  let offset = 0
  for (const f of files) {
    const raw = await readAsDataURL(f)
    const src = await compress(raw)
    const { w, h } = await imageSize(src)
    const scale = Math.min(1, 640 / Math.max(w, h))
    const node = createNode('image', s.pageId, {
      name: f.name.replace(/\.[a-z0-9]+$/i, '') || 'Image',
      x: Math.round(at.x + offset),
      y: Math.round(at.y + offset),
      width: Math.round(w * scale),
      height: Math.round(h * scale),
      fills: [],
      image: { src, fit: 'cover', alt: f.name.replace(/\.[a-z0-9]+$/i, '') },
    })
    getEditor().addNode(node, null)
    created.push(node.id)
    offset += 24
  }
  getEditor().set({ selection: created })
}
