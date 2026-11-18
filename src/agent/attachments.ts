import type { ChatImage } from './keys'

/** Images per message, and the long side the agent gets (larger costs tokens without helping). */
export const MAX_IMAGES = 8
const MAX_SIDE = 1568
/** Originals at or under this size and side are sent untouched. */
const KEEP_BYTES = 3_500_000
const SUPPORTED: ChatImage['mediaType'][] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

export function chatImageUrl(img: Pick<ChatImage, 'mediaType' | 'data'>) {
  return `data:${img.mediaType};base64,${img.data}`
}

/** Opens the system picker for images. */
export function pickImageFiles(cb: (files: File[]) => void) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/png,image/jpeg,image/webp,image/gif'
  input.multiple = true
  input.onchange = () => cb([...(input.files ?? [])])
  input.click()
}

/** The image files among a paste or a drop. */
export function imageFiles(list: ArrayLike<File | DataTransferItem> | null | undefined): File[] {
  if (!list) return []
  const out: File[] = []
  for (const entry of Array.from(list)) {
    const f = entry instanceof File ? entry : entry.kind === 'file' ? entry.getAsFile() : null
    if (f && f.type.startsWith('image/')) out.push(f)
  }
  return out
}

/**
 * Reads an image file into a ChatImage: small supported files go as they are,
 * anything larger or in another format is redrawn at most 1568px on the long side.
 */
export async function fileToChatImage(file: File): Promise<ChatImage> {
  const url = URL.createObjectURL(file)
  try {
    const img = await loadImage(url)
    const w = img.naturalWidth
    const h = img.naturalHeight
    if (!w || !h) throw new Error(`${file.name || 'That file'} isn't an image Kiln can read.`)
    const type = file.type as ChatImage['mediaType']
    const name = file.name || `pasted-image.${(type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`
    if (SUPPORTED.includes(type) && file.size <= KEEP_BYTES && Math.max(w, h) <= MAX_SIDE) {
      return { id: uid(), name, mediaType: type, data: await toBase64(file), width: w, height: h }
    }
    const k = Math.min(1, MAX_SIDE / Math.max(w, h))
    const cw = Math.max(1, Math.round(w * k))
    const ch = Math.max(1, Math.round(h * k))
    const c = document.createElement('canvas')
    c.width = cw
    c.height = ch
    const ctx = c.getContext('2d')!
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, 0, 0, cw, ch)
    // keep transparency for PNGs, photos go smaller as JPEG
    const out: ChatImage['mediaType'] = type === 'image/png' || type === 'image/gif' || type === 'image/webp' ? 'image/png' : 'image/jpeg'
    const dataUrl = c.toDataURL(out, 0.9)
    return { id: uid(), name: name.replace(/\.\w+$/, '') + (out === 'image/png' ? '.png' : '.jpg'), mediaType: out, data: dataUrl.slice(dataUrl.indexOf(',') + 1), width: cw, height: ch }
  } finally {
    URL.revokeObjectURL(url)
  }
}

function uid() {
  return Math.random().toString(36).slice(2, 10)
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error("That file isn't an image Kiln can read."))
    img.src = src
  })
}

function toBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => {
      const s = String(r.result)
      resolve(s.slice(s.indexOf(',') + 1))
    }
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}
