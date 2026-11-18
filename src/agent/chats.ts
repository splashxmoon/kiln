import type { ChatImage, ChatItem } from './keys'

/** The agent-side context of a chat, enough to pick the conversation back up later. */
export interface SessionSnapshot {
  anthropicHistory: unknown[]
  compatHistory: unknown[]
  cliState: { sessionId?: string }
  providerId: string
}

export interface SavedChat {
  id: string
  title: string
  updatedAt: number
  items: ChatItem[]
  session: SessionSnapshot
}

const MAX_CHATS = 30

const keyFor = (docId: string) => `kiln.agentChats.${docId}`

export function newChatId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

/** Past chats for one design, newest first. Corrupt storage reads as no history. */
export function loadChats(docId: string): SavedChat[] {
  try {
    const raw = localStorage.getItem(keyFor(docId))
    const list = raw ? (JSON.parse(raw) as SavedChat[]) : []
    return Array.isArray(list) ? list.sort((a, b) => b.updatedAt - a.updatedAt) : []
  } catch {
    return []
  }
}

function writeChats(docId: string, list: SavedChat[]) {
  let kept = list.slice(0, MAX_CHATS)
  // localStorage is small: if the write is refused, drop the oldest chats until it fits
  for (;;) {
    try {
      localStorage.setItem(keyFor(docId), JSON.stringify(kept))
      return kept
    } catch {
      if (kept.length <= 1) return kept
      kept = kept.slice(0, -1)
    }
  }
}

/* ------------------------------------------------------------------ image thumbnails */

const THUMB_SIDE = 160
/** Thumbnail (base64 JPEG) per image id, once made. A failed decode keeps the original so nothing is lost. */
const thumbs = new Map<string, { data: string; mediaType: ChatImage['mediaType'] }>()
const pendingThumbs = new Set<string>()

function makeThumb(img: ChatImage): Promise<string> {
  return new Promise((resolve, reject) => {
    const el = new Image()
    el.onload = () => {
      const w = el.naturalWidth
      const h = el.naturalHeight
      if (!w || !h) return reject(new Error('empty image'))
      const k = Math.min(1, THUMB_SIDE / Math.max(w, h))
      const c = document.createElement('canvas')
      c.width = Math.max(1, Math.round(w * k))
      c.height = Math.max(1, Math.round(h * k))
      const ctx = c.getContext('2d')
      if (!ctx) return reject(new Error('no canvas'))
      // JPEG has no transparency: paint white under it first
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, c.width, c.height)
      ctx.drawImage(el, 0, 0, c.width, c.height)
      resolve(c.toDataURL('image/jpeg', 0.8).slice('data:image/jpeg;base64,'.length))
    }
    el.onerror = () => reject(new Error('undecodable image'))
    el.src = `data:${img.mediaType};base64,${img.data}`
  })
}

/**
 * The version of an image that goes to localStorage: a small JPEG thumbnail.
 * Thumbnails are made asynchronously; until one is ready the stored data is empty
 * and `repairThumbs` fills it in once the thumbnail exists.
 */
function storedImage(docId: string, img: ChatImage): ChatImage {
  const done = thumbs.get(img.id)
  if (done) return { ...img, mediaType: done.mediaType, data: done.data }
  if (!pendingThumbs.has(img.id)) {
    pendingThumbs.add(img.id)
    makeThumb(img).then(
      (data) => {
        thumbs.set(img.id, { data, mediaType: 'image/jpeg' })
        pendingThumbs.delete(img.id)
        repairThumbs(docId)
      },
      () => {
        thumbs.set(img.id, { data: img.data, mediaType: img.mediaType })
        pendingThumbs.delete(img.id)
        repairThumbs(docId)
      },
    )
  }
  return { ...img, data: '' }
}

/** Fill in stored images that were saved before their thumbnail was ready. */
function repairThumbs(docId: string) {
  const list = loadChats(docId)
  let changed = false
  const fixed = list.map((c) => {
    const items = c.items.map((it) => {
      if (it.role !== 'user' || !it.images?.some((i) => !i.data && thumbs.has(i.id))) return it
      changed = true
      return {
        ...it,
        images: it.images.map((i) => {
          const t = thumbs.get(i.id)
          return !i.data && t ? { ...i, mediaType: t.mediaType, data: t.data } : i
        }),
      }
    })
    return { ...c, items }
  })
  if (changed) writeChats(docId, fixed)
}

function compactItems(docId: string, items: ChatItem[]): ChatItem[] {
  return items.map((it) => (it.role === 'user' && it.images?.length ? { ...it, images: it.images.map((i) => storedImage(docId, i)) } : it))
}

/** Insert or update a chat. `session` is only passed at the end of a turn, when the agent context is complete. */
export function saveChat(docId: string, id: string, items: ChatItem[], session?: SessionSnapshot): SavedChat[] {
  if (!items.length) return loadChats(docId)
  const all = loadChats(docId)
  const prev = all.find((c) => c.id === id)
  const chat: SavedChat = {
    id,
    title: chatTitle(items),
    updatedAt: Date.now(),
    items: compactItems(docId, items),
    session: session ?? prev?.session ?? { anthropicHistory: [], compatHistory: [], cliState: {}, providerId: '' },
  }
  const next = [chat, ...all.filter((c) => c.id !== id)].sort((a, b) => b.updatedAt - a.updatedAt)
  return writeChats(docId, next)
}

export function deleteChat(docId: string, id: string): SavedChat[] {
  return writeChats(docId, loadChats(docId).filter((c) => c.id !== id))
}

/** Names of attached images, so the model (and a restored chat) can refer to them. */
export function attachedNote(images: ChatImage[]): string {
  return images.length ? `\n\n(Attached images: ${images.map((i) => i.name).join(', ')})` : ''
}

/** The first thing the user asked, on one line. */
export function chatTitle(items: ChatItem[]): string {
  const first = items.find((i) => i.role === 'user')
  const t = first && first.role === 'user' ? first.text.replace(/\s+/g, ' ').trim() : ''
  if (t) return t.length > 60 ? t.slice(0, 59).trimEnd() + '…' : t
  const n = first && first.role === 'user' ? first.images?.length ?? 0 : 0
  return n === 1 ? 'Image' : n > 1 ? `${n} images` : 'New chat'
}

export function timeAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
