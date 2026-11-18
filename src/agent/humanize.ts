/**
 * Plain-English wording and an icon for each agent tool call, shared by the canvas
 * cursor, the top-bar status and the chat timeline so all three say the same thing.
 *
 *   toolLabel('update_nodes', { nodeIds: ['a', 'b'] })
 *   // { verb: 'Styling 2 layers', done: 'Styled 2 layers', icon: Paintbrush, kind: 'edit' }
 *
 * Accepts bare Kiln tool names and CLI-prefixed ones ("mcp__kiln__update_nodes").
 * Unknown tools (e.g. a CLI's own Read/Bash) get a readable fallback.
 */
import {
  Camera,
  Code2,
  Copy,
  FilePlus2,
  FileSearch,
  FileText,
  Layers,
  LayoutTemplate,
  ListTree,
  MessageSquarePlus,
  Move,
  MousePointerClick,
  Paintbrush,
  Palette,
  PenLine,
  Plus,
  Search,
  Sparkles,
  SquareTerminal,
  Trash2,
  Type,
  Wrench,
  type LucideIcon,
} from 'lucide-react'

/** read: looks without changing; edit: changes the document; other: anything else. */
export type ToolKind = 'read' | 'edit' | 'other'

export interface ToolLabel {
  /** in progress, e.g. "Styling 3 layers" */
  verb: string
  /** finished, e.g. "Styled 3 layers" */
  done: string
  icon: LucideIcon
  kind: ToolKind
}

type Args = Record<string, unknown> | undefined

/** "update_nodes" from "mcp__kiln__update_nodes" / "kiln.update_nodes" / "Agent: update nodes". */
export function bareToolName(name: string): string {
  const n = name.replace(/^Agent:\s*/i, '').trim()
  const tail = n.split(/__|\./).pop() ?? n
  return tail.replace(/\s+/g, '_').toLowerCase()
}

const count = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`
const arr = (v: unknown) => (Array.isArray(v) ? v : [])
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const quote = (s: string, max = 28) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `“${t.slice(0, max - 1)}…”` : `“${t}”`
}

const NODE_NOUN: Record<string, string> = {
  frame: 'frame',
  rect: 'rectangle',
  ellipse: 'ellipse',
  path: 'path',
  text: 'text',
  image: 'image',
  shader: 'shader',
}

/** The props an update_nodes call sets, summarised as a verb pair. */
function updateVerb(props: Args): [string, string, LucideIcon] {
  const keys = Object.keys(props ?? {})
  const has = (...k: string[]) => k.some((x) => keys.includes(x))
  if (keys.length === 1 && has('text')) return ['Setting type on', 'Set type on', Type]
  if (has('layout', 'width', 'height', 'x', 'y', 'position')) return ['Laying out', 'Laid out', LayoutTemplate]
  if (has('fill', 'gradient', 'stroke', 'shadow', 'radius', 'opacity')) return ['Styling', 'Styled', Paintbrush]
  return ['Updating', 'Updated', Paintbrush]
}

export function toolLabel(name: string, input?: Args): ToolLabel {
  const a = input ?? {}
  switch (bareToolName(name)) {
    case 'get_document':
      return { verb: 'Reading the document', done: 'Read the document', icon: FileText, kind: 'read' }
    case 'get_tree':
      return { verb: 'Reading the layers', done: 'Read the layers', icon: ListTree, kind: 'read' }
    case 'get_node':
      return { verb: 'Inspecting a layer', done: 'Inspected a layer', icon: FileSearch, kind: 'read' }
    case 'get_selection':
      return { verb: 'Looking at your selection', done: 'Looked at your selection', icon: MousePointerClick, kind: 'read' }
    case 'get_screenshot':
      return { verb: 'Taking a screenshot', done: 'Took a screenshot', icon: Camera, kind: 'read' }
    case 'find_nodes': {
      const q = str(a.query)
      return { verb: q ? `Searching for ${quote(q, 20)}` : 'Searching layers', done: q ? `Searched for ${quote(q, 20)}` : 'Searched layers', icon: Search, kind: 'read' }
    }
    case 'export_code':
      return { verb: 'Exporting code', done: 'Exported code', icon: Code2, kind: 'read' }
    case 'create_node': {
      const noun = NODE_NOUN[str(a.type)] ?? 'layer'
      const named = str(a.name)
      return { verb: `Adding ${named ? quote(named, 22) : `a ${noun}`}`, done: `Added ${named ? quote(named, 22) : `a ${noun}`}`, icon: Plus, kind: 'edit' }
    }
    case 'write_html':
      return { verb: 'Building a section', done: 'Built a section', icon: Layers, kind: 'edit' }
    case 'update_nodes': {
      const n = arr(a.nodeIds).length
      const [v, d, icon] = updateVerb(a.props as Args)
      const what = n ? count(n, 'layer') : 'layers'
      return { verb: `${v} ${what}`, done: `${d} ${what}`, icon, kind: 'edit' }
    }
    case 'set_text': {
      const texts = (a.texts && typeof a.texts === 'object' ? Object.values(a.texts as object) : []) as unknown[]
      const first = texts.find((t) => typeof t === 'string') as string | undefined
      if (texts.length === 1 && first) return { verb: `Writing ${quote(first)}`, done: `Wrote ${quote(first)}`, icon: PenLine, kind: 'edit' }
      const what = texts.length ? count(texts.length, 'text') : 'copy'
      return { verb: `Writing ${what}`, done: `Wrote ${what}`, icon: PenLine, kind: 'edit' }
    }
    case 'delete_nodes': {
      const what = count(arr(a.nodeIds).length || 1, 'layer')
      return { verb: `Removing ${what}`, done: `Removed ${what}`, icon: Trash2, kind: 'edit' }
    }
    case 'duplicate_node':
      return { verb: 'Duplicating a layer', done: 'Duplicated a layer', icon: Copy, kind: 'edit' }
    case 'move_node':
      return { verb: 'Moving a layer', done: 'Moved a layer', icon: Move, kind: 'edit' }
    case 'select_nodes':
      return { verb: 'Selecting layers', done: 'Selected layers', icon: MousePointerClick, kind: 'other' }
    case 'create_token': {
      const n = str(a.name)
      return { verb: `Adding token ${n || ''}`.trim(), done: `Added token ${n || ''}`.trim(), icon: Palette, kind: 'edit' }
    }
    case 'apply_token': {
      const what = count(arr(a.nodeIds).length || 1, 'layer')
      return { verb: `Applying a token to ${what}`, done: `Applied a token to ${what}`, icon: Palette, kind: 'edit' }
    }
    case 'add_comment':
      return { verb: 'Leaving a comment', done: 'Left a comment', icon: MessageSquarePlus, kind: 'other' }
    case 'create_page': {
      const n = str(a.name)
      return { verb: n ? `Creating page ${quote(n, 20)}` : 'Creating a page', done: n ? `Created page ${quote(n, 20)}` : 'Created a page', icon: FilePlus2, kind: 'edit' }
    }
    // a CLI's own tools, outside Kiln
    case 'read':
    case 'glob':
    case 'grep':
      return { verb: 'Reading files', done: 'Read files', icon: FileSearch, kind: 'read' }
    case 'bash':
      return { verb: 'Running a command', done: 'Ran a command', icon: SquareTerminal, kind: 'other' }
    case 'todowrite':
      return { verb: 'Planning', done: 'Made a plan', icon: Sparkles, kind: 'other' }
    default: {
      const words = bareToolName(name).replace(/_/g, ' ').trim() || 'tool'
      const cap = words[0].toUpperCase() + words.slice(1)
      return { verb: `Using ${words}`, done: cap, icon: Wrench, kind: 'other' }
    }
  }
}

/** Node ids a tool call touches, for the canvas cursor and afterglow. */
export function toolNodeIds(name: string, input?: Args): string[] {
  const a = input ?? {}
  const ids = [...arr(a.nodeIds), a.nodeId, a.parentId]
  if (bareToolName(name) === 'set_text' && a.texts && typeof a.texts === 'object') ids.push(...Object.keys(a.texts as object))
  return ids.filter((x): x is string => typeof x === 'string' && !!x)
}

/** "12s", "1m 04s" */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}
