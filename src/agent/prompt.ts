import { getEditor } from '../editor/store'
import { measure } from '../editor/geometry'

/** Shared system prompt for every agent provider driving the Kiln canvas. */
export const AGENT_SYSTEM_PROMPT = `You are the design agent inside Kiln, a design tool whose canvas is real HTML/CSS. Every layer is a DOM element; frames with layout.mode "flex" are CSS flexbox containers; sizing modes are fixed / hug (fit-content) / fill (flex:1 or stretch).

The document is live: the user edits it between your messages (deleting, renaming, moving, adding pages and layers). Each message ends with a "Kiln context" block that is the state of the document right now. It replaces anything earlier in this conversation: a page, artboard or id that isn't in the latest context, or that it says was deleted, no longer exists, so don't mention it, plan around it or try to use it. When you need detail, call the tools again rather than relying on results from earlier messages. If a tool says a layer doesn't exist, it was deleted: re-read the document instead of retrying.

How to work:
- Start with get_document (and get_selection when the user refers to "this" or "selected").
- Work on the page the user is looking at, named in the Kiln context with its artboards and the selection: build there, place new artboards beside the existing ones, and match the look of what is already on the page (its tokens, type, spacing, colours). Don't create or switch pages unless the user asks.
- To build UI, prefer write_html with well-structured HTML using display:flex, gap and padding — it becomes native editable layers. Use real, specific copy (never lorem ipsum).
- For edits, use update_nodes / set_text on existing ids rather than recreating layers.
- After building or changing something visual, call get_screenshot once to check the result and fix obvious problems.
- Respect the document's tokens and existing type styles; keep spacing on a 4px grid.
- Keep replies short: say what you changed in one or two sentences.`

/** What the previous Kiln context told the agent, so the next one can say what has gone since. */
interface Seen {
  docId: string
  pages: Map<string, string>
  boards: Map<string, string>
}
let seen: Seen | null = null

const MAX_PAGES = 30
const MAX_BOARDS = 20
const MAX_GONE = 12

const quote = (s: string) => `"${s.replace(/\s+/g, ' ').slice(0, 80)}"`
const list = (xs: string[], max: number) => (xs.length > max ? `${xs.slice(0, max).join(', ')} and ${xs.length - max} more` : xs.join(', '))

/**
 * A note appended to every user message: the document as it is right now (every page, the page
 * the user is looking at, its artboards and the selection), and what has been deleted since the
 * previous note. Agents keep earlier tool results in their conversation, so without this they
 * would go on planning around pages and layers the user has already removed.
 */
export function kilnContext(): string {
  const s = getEditor()
  const d = s.doc
  const page = d.pages.find((p) => p.id === s.pageId)
  if (!page) return ''

  const describe = (id: string) => {
    const n = d.nodes[id]
    if (!n) return null
    const r = measure(id)
    return `${quote(n.name)} (id ${id}, ${n.type}${r ? `, ${Math.round(r.w)}x${Math.round(r.h)}` : ''})`
  }
  const boardCount = (n: number) => (n === 1 ? '1 artboard' : `${n} artboards`)

  const pages = d.pages.map(
    (p) => `${quote(p.name)} (id ${p.id}, ${boardCount(p.children.filter((c) => d.nodes[c]).length)}${p.id === page.id ? ', the user is on this page' : ''})`,
  )
  const boards = page.children.map(describe).filter((x): x is string => !!x)
  const sel = s.selection.map(describe).filter((x): x is string => !!x)

  // what the previous note listed that is gone now (same document only)
  const nowPages = new Map(d.pages.map((p) => [p.id, p.name]))
  const nowBoards = new Map<string, string>()
  for (const p of d.pages) for (const c of p.children) if (d.nodes[c]) nowBoards.set(c, d.nodes[c].name)
  const gone: string[] = []
  let switched = false
  if (seen && seen.docId !== d.id) switched = true
  else if (seen) {
    for (const [id, name] of seen.pages) if (!nowPages.has(id)) gone.push(`page ${quote(name)} (id ${id})`)
    for (const [id, name] of seen.boards) if (!nowBoards.has(id)) gone.push(`artboard ${quote(name)} (id ${id})`)
  }
  seen = { docId: d.id, pages: nowPages, boards: nowBoards }

  const lines = [
    `Kiln context — the live state of the document right now, which replaces anything earlier in this conversation.`,
    switched ? `The user has opened a different file since your last message: everything you knew about the previous file no longer applies.` : '',
    `File: ${quote(d.name)}. Pages (${d.pages.length}, nothing else exists): ${list(pages, MAX_PAGES)}.`,
    gone.length ? `Deleted since your last message, so they no longer exist: ${list(gone, MAX_GONE)}. Don't use or mention them.` : '',
    `The user is looking at page ${quote(page.name)}. Build on this page and in the style of what is already on it.`,
    boards.length ? `Artboards on this page: ${list(boards, MAX_BOARDS)}.` : 'This page is empty.',
    sel.length ? `Selected: ${sel.join(', ')}.` : 'Nothing is selected.',
  ]
  return '\n\n(' + lines.filter(Boolean).join('\n') + ')'
}
