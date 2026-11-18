/**
 * Kiln agent tool API — one typed surface used by:
 *  - the desktop MCP server (Claude Code, Cursor, … over http://127.0.0.1:7457/mcp)
 *  - window.kiln in the browser (any in-page / browser-driving agent)
 *  - the built-in agent panel (Claude with a user-supplied key)
 */
import type { McpContent, McpTool } from '../platform/tauri'
import { getEditor, pathTo, childrenOf } from '../editor/store'
import type { KDoc, KNode, Layout, NodeType, ShaderKind } from '../editor/types'
import { createNode, createPage, createToken, solidFill, linearFill, dropShadow } from '../editor/factory'
import { htmlToNodes } from '../editor/importHtml'
import { snapshotNode, dataURLToBase64 } from '../editor/snapshot'
import { measure } from '../editor/geometry'
import { exportNode, nodeCSSDeclarations, type ExportTarget } from '../codegen'
import { defaultShaderSpec, SHADER_KINDS } from '../shaders/defs'
import { ensureFont } from '../editor/fonts'
import { zoomToFit } from '../editor/Canvas'
import { toolLabel, toolNodeIds } from './humanize'

type Args = Record<string, unknown>
type Handler = (args: Args) => Promise<McpContent[]> | McpContent[]

const text = (v: unknown): McpContent[] => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }]

class ToolError extends Error {}
const need = <T>(v: T | undefined | null, msg: string): T => {
  if (v == null) throw new ToolError(msg)
  return v
}
function nodeOr404(id: unknown): KNode {
  const n = getEditor().doc.nodes[String(id)]
  if (!n) throw new ToolError(`No layer with id "${String(id)}": it has been deleted or never existed. Don't retry it; call get_document or get_tree for the current ids.`)
  return n
}

/* ------------------------------------------------------------------ summaries */

function summarize(n: KNode, doc: KDoc, depth: number, maxDepth: number): unknown {
  const r = measure(n.id)
  const out: Record<string, unknown> = {
    id: n.id,
    type: n.type,
    name: n.name,
    size: r ? `${Math.round(r.w)}x${Math.round(r.h)}` : undefined,
    sizing: n.widthMode !== 'fixed' || n.heightMode !== 'fixed' ? `${n.widthMode}/${n.heightMode}` : undefined,
  }
  if (n.type === 'frame' && n.layout.mode === 'flex') out.layout = `flex-${n.layout.direction} gap=${n.layout.gap} pad=${n.layout.padding.join(',')} align=${n.layout.align} justify=${n.layout.justify}`
  if (n.path) out.path = n.path.d.length > 160 ? n.path.d.slice(0, 157) + '…' : n.path.d
  if (n.text) out.text = n.text.content.length > 120 ? n.text.content.slice(0, 117) + '…' : n.text.content
  if (n.fills[0]?.visible && n.fills[0].type === 'solid') out.fill = n.fills[0].color
  if (!n.visible) out.hidden = true
  if (n.binding) out.binding = n.binding
  if (n.children.length) {
    if (depth < maxDepth) out.children = n.children.map((c) => doc.nodes[c]).filter(Boolean).map((c) => summarize(c, doc, depth + 1, maxDepth))
    else out.childCount = n.children.length
  }
  return out
}

/* ------------------------------------------------------------------ prop patching */

/** Accepts a friendly, CSS-ish patch and applies it to a node draft. */
function applyPatch(n: KNode, p: Args) {
  const num = (k: string) => (typeof p[k] === 'number' ? (p[k] as number) : undefined)
  if (typeof p.name === 'string') n.name = p.name
  if (num('x') != null) n.x = num('x')!
  if (num('y') != null) n.y = num('y')!
  const size = (axis: 'width' | 'height') => {
    const v = p[axis]
    const modeKey = axis === 'width' ? 'widthMode' : 'heightMode'
    if (typeof v === 'number') {
      n[axis] = v
      n[modeKey] = 'fixed'
    } else if (v === 'hug' || v === 'fill' || v === 'fixed') n[modeKey] = v
  }
  size('width')
  size('height')
  if (num('rotation') != null) n.rotation = num('rotation')!
  if (num('opacity') != null) n.opacity = num('opacity')!
  if (typeof p.visible === 'boolean') n.visible = p.visible
  if (typeof p.locked === 'boolean') n.locked = p.locked
  if (p.radius != null) n.radius = p.radius as KNode['radius']
  if (typeof p.clip === 'boolean') n.clip = p.clip
  if (typeof p.position === 'string') n.positioning = p.position === 'absolute' ? 'absolute' : 'auto'
  if (typeof p.fill === 'string') n.fills = p.fill === 'none' ? [] : [solidFill(p.fill)]
  if (Array.isArray(p.gradient) && p.gradient.length >= 2) n.fills = [linearFill([String(p.gradient[0]), String(p.gradient[1])], Number(p.gradient[2] ?? 180))]
  if (typeof p.imageUrl === 'string') {
    if (n.type === 'image') n.image = { src: p.imageUrl, fit: 'cover', alt: n.image?.alt ?? '' }
    else n.fills = [{ id: 'img', type: 'image', visible: true, opacity: 1, color: '#000', stops: [], angle: 0, src: p.imageUrl, fit: 'cover' }]
  }
  if (p.stroke === null || p.stroke === 'none') n.stroke = null
  else if (typeof p.stroke === 'object' && p.stroke) {
    const s = p.stroke as Args
    n.stroke = { visible: true, color: String(s.color ?? '#141413'), width: Number(s.width ?? 1), style: (s.style as 'solid') ?? 'solid', position: (s.position as 'inside') ?? 'inside' }
  }
  if (typeof p.shadow === 'string') {
    n.shadows =
      p.shadow === 'none'
        ? []
        : p.shadow === 'sm'
          ? [dropShadow({ y: 1, blur: 3, color: 'rgba(20,20,19,0.08)' })]
          : p.shadow === 'lg'
            ? [dropShadow({ y: 24, blur: 48, spread: -12, color: 'rgba(20,20,19,0.22)' })]
            : [dropShadow({ y: 4, blur: 14, color: 'rgba(20,20,19,0.10)' })]
  }
  if (num('blur') != null) n.blur = num('blur')!
  if (num('backdropBlur') != null) n.backdropBlur = num('backdropBlur')!
  if (typeof p.layout === 'object' && p.layout) {
    const l = p.layout as Omit<Partial<Layout>, "padding"> & { padding?: number | number[] }
    if (l.mode) n.layout.mode = l.mode
    if (l.direction) {
      n.layout.direction = l.direction
      n.layout.mode = 'flex'
    }
    if (typeof l.gap === 'number') n.layout.gap = l.gap
    if (l.padding != null) {
      const v = l.padding
      n.layout.padding = typeof v === 'number' ? [v, v, v, v] : v.length === 2 ? [v[0], v[1], v[0], v[1]] : (v.slice(0, 4) as [number, number, number, number])
    }
    if (l.align) n.layout.align = l.align
    if (l.justify) n.layout.justify = l.justify
    if (typeof l.wrap === 'boolean') n.layout.wrap = l.wrap
  }
  if (typeof p.text === 'object' && p.text && n.text) {
    const t = p.text as Args
    if (typeof t.content === 'string') n.text.content = t.content
    if (typeof t.fontFamily === 'string') {
      n.text.fontFamily = t.fontFamily
      ensureFont(t.fontFamily)
    }
    if (typeof t.fontSize === 'number') n.text.fontSize = t.fontSize
    if (typeof t.fontWeight === 'number') n.text.fontWeight = t.fontWeight
    if (typeof t.lineHeight === 'number') n.text.lineHeight = t.lineHeight
    if (typeof t.letterSpacing === 'number') n.text.letterSpacing = t.letterSpacing
    if (typeof t.textAlign === 'string') n.text.textAlign = t.textAlign as 'left'
    if (typeof t.color === 'string') {
      n.text.color = t.color
      delete n.text.tokenId
    }
    if (typeof t.italic === 'boolean') n.text.italic = t.italic
    if (typeof t.transform === 'string') n.text.transform = t.transform as 'none'
  }
  if (typeof p.shader === 'object' && p.shader && n.shader) {
    const s = p.shader as Args
    if (typeof s.kind === 'string' && (SHADER_KINDS as string[]).includes(s.kind)) n.shader = defaultShaderSpec(s.kind as ShaderKind)
    if (typeof s.speed === 'number') n.shader.speed = s.speed
    if (typeof s.params === 'object' && s.params) Object.assign(n.shader.params, s.params)
  }
  if (typeof p.path === 'object' && p.path && n.type === 'path') {
    const v = p.path as Args
    if (typeof v.d === 'string') {
      const vb = Array.isArray(v.viewBox) ? v.viewBox.map(Number) : []
      const w = vb[0] > 0 ? vb[0] : n.width
      const h = vb[1] > 0 ? vb[1] : n.height
      // agent-written geometry replaces the pen anchors
      n.path = { d: v.d, w, h, closed: /z\s*$/i.test(v.d.trim()) }
      if (typeof p.width !== 'number') n.width = w
      if (typeof p.height !== 'number') n.height = h
    }
  }
  if (typeof p.binding === 'string') n.binding = p.binding || undefined
  if (typeof p.note === 'string') n.note = p.note || undefined
}

/* ------------------------------------------------------------------ presence */

/*
 * The agent's live activity, shared by the canvas, the top bar and the chat:
 *   agentAction  what it is doing now; set when a tool starts, cleared ACTION_LINGER after the last one ends
 *   agentFocus   the nodes that action touches
 *   agentTrail   node id -> when an edit last touched it (pruned after TRAIL_MS)
 *   agentTurn    the whole turn; its step count goes up with each tool
 * Used by runTool, the MCP bridge (Editor.tsx) and the dev demo (demo.ts).
 */
export const ACTION_LINGER = 900
export const TRAIL_MS = 3000

let clearTimer: number | undefined
let pruneTimer: number | undefined
/** nodes the running tool pointed at with presence(), e.g. the ones it created */
let touched: string[] | null = null

const existing = (ids: string[]) => {
  const nodes = getEditor().doc.nodes
  return [...new Set(ids)].filter((id) => nodes[id])
}

/** A tool started: show its label on the nodes it touches, and count a step if a turn is running. */
export function activityStart(tool: string, label: string, ids: string[], countStep = true) {
  window.clearTimeout(clearTimer)
  const s = getEditor()
  const live = existing(ids)
  const turn = s.agentTurn
  s.set({
    agentAction: { tool, label, ids: live, at: Date.now() },
    agentFocus: live,
    ...(countStep && turn ? { agentTurn: { ...turn, steps: turn.steps + 1 } } : {}),
  })
}

/** Point the current action at these nodes (a tool calls this once it knows them, e.g. after creating them). */
function presence(ids: string[]) {
  const s = getEditor()
  const live = existing(ids)
  touched = live
  if (s.agentAction) s.set({ agentAction: { ...s.agentAction, ids: live }, agentFocus: live })
  else s.set({ agentFocus: live })
}

/** These nodes were just changed: they glow on the canvas for TRAIL_MS. */
export function markTrail(ids: string[]) {
  const s = getEditor()
  const now = Date.now()
  const trail: Record<string, number> = {}
  for (const [id, t] of Object.entries(s.agentTrail)) if (now - t < TRAIL_MS && s.doc.nodes[id]) trail[id] = t
  for (const id of existing(ids)) trail[id] = now
  window.clearTimeout(pruneTimer)
  const kept = Object.keys(trail)
  // an idle prune that changes nothing skips the store update, so nothing re-renders
  const same = kept.length === Object.keys(s.agentTrail).length && kept.every((id) => s.agentTrail[id] === trail[id])
  if (!same) s.set({ agentTrail: trail })
  // prune again only while something is left to fade
  if (kept.length) pruneTimer = window.setTimeout(() => markTrail([]), TRAIL_MS + 50)
}

/** A tool ended: clear the action after ACTION_LINGER, unless another tool starts first. */
export function activityEnd() {
  window.clearTimeout(clearTimer)
  clearTimer = window.setTimeout(() => getEditor().set({ agentAction: null, agentFocus: [] }), ACTION_LINGER)
}

/** The turn is over (done, failed or cancelled): drop all live state now. The trail fades by itself. */
export function activityReset() {
  window.clearTimeout(clearTimer)
  getEditor().set({ agentTurn: null, agentBusy: null, agentAction: null, agentFocus: [] })
}

/* ------------------------------------------------------------------ tool table */

const PATCH_SCHEMA = {
  type: 'object',
  description:
    'CSS-like properties. width/height: number (px) | "hug" | "fill". fill: CSS colour or "none". gradient: [from, to, angleDeg]. layout: {mode:"flex"|"none", direction:"row"|"column", gap, padding: n | [v,h] | [t,r,b,l], align:"start"|"center"|"end"|"stretch", justify:"start"|"center"|"end"|"space-between"}. text: {content, fontFamily, fontSize, fontWeight, lineHeight (multiplier), letterSpacing (em), textAlign, color}. stroke: {color,width,position} | "none". shadow: "none"|"sm"|"md"|"lg". radius: n | [tl,tr,br,bl]. position: "auto"|"absolute" (absolute inside flex parents uses x/y). shader: {kind, speed, params}. path (path layers only): {d: SVG path data, viewBox: [w, h]}; on a path, fill paints the shape and stroke follows the line (stroke position is ignored). imageUrl. binding (data field path). note.',
  additionalProperties: true,
}

interface ToolDef {
  tool: McpTool
  run: Handler
}

const TOOLS: ToolDef[] = [
  {
    tool: {
      name: 'get_document',
      description: 'Overview of the open Kiln document: pages, top-level artboards (id, name, size), colour tokens and the current selection. Call this first.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
    },
    run: () => {
      const s = getEditor()
      const d = s.doc
      return text({
        name: d.name,
        currentPageId: s.pageId,
        currentPageName: d.pages.find((p) => p.id === s.pageId)?.name,
        note: 'The user is looking at the current page: build there (new artboards go beside its existing ones) and match its style, unless asked otherwise.',
        pages: d.pages.map((p) => ({
          id: p.id,
          name: p.name,
          artboards: p.children.map((id) => {
            const n = d.nodes[id]
            const r = measure(id)
            return { id, name: n?.name, type: n?.type, size: r ? `${Math.round(r.w)}x${Math.round(r.h)}` : undefined }
          }),
        })),
        tokens: d.tokens.map((t) => ({ id: t.id, name: t.name, value: t.value })),
        selection: s.selection,
        conventions:
          'Every layer is a real DOM element. Frames with layout.mode="flex" lay out children with CSS flexbox; widthMode/heightMode hug=fit-content, fill=flex:1/stretch. Prefer flex layouts over absolute positioning so designs export to clean code.',
      })
    },
  },
  {
    tool: {
      name: 'get_tree',
      description: 'Layer tree under a node (or the current page) with ids, types, names, measured sizes, flex settings and text. Use depth to limit output.',
      inputSchema: { type: 'object', properties: { nodeId: { type: 'string', description: 'Root layer id; omit for the whole current page' }, depth: { type: 'number', default: 4 } } },
      annotations: { readOnlyHint: true },
    },
    run: (a) => {
      const s = getEditor()
      const depth = Number(a.depth ?? 4)
      if (a.nodeId) return text(summarize(nodeOr404(a.nodeId), s.doc, 0, depth))
      const page = s.doc.pages.find((p) => p.id === s.pageId)!
      return text(page.children.map((id) => summarize(s.doc.nodes[id], s.doc, 0, depth)))
    },
  },
  {
    tool: {
      name: 'get_node',
      description: 'Full JSON of one layer (all style properties) plus its generated CSS.',
      inputSchema: { type: 'object', properties: { nodeId: { type: 'string' } }, required: ['nodeId'] },
      annotations: { readOnlyHint: true },
    },
    run: (a) => {
      const n = nodeOr404(a.nodeId)
      const out = { ...n, image: n.image ? { ...n.image, src: n.image.src.slice(0, 80) + (n.image.src.length > 80 ? '…' : '') } : undefined }
      return text({ node: out, css: nodeCSSDeclarations(getEditor().doc, n.id), path: pathTo(getEditor().doc, n.id) })
    },
  },
  {
    tool: {
      name: 'get_selection',
      description: 'Ids and summaries of the layers the user currently has selected.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
    },
    run: () => {
      const s = getEditor()
      return text(s.selection.map((id) => summarize(s.doc.nodes[id], s.doc, 0, 2)))
    },
  },
  {
    tool: {
      name: 'get_screenshot',
      description: 'PNG screenshot of a layer (defaults to the selection or first artboard). Use to check your work visually.',
      inputSchema: { type: 'object', properties: { nodeId: { type: 'string' }, scale: { type: 'number', default: 1 } } },
      annotations: { readOnlyHint: true },
    },
    run: async (a) => {
      const s = getEditor()
      const page = s.doc.pages.find((p) => p.id === s.pageId)!
      const id = String(a.nodeId ?? s.selection[0] ?? page.children[0] ?? '')
      nodeOr404(id)
      presence([id])
      const url = await snapshotNode(id, { scale: Number(a.scale ?? 1), maxSize: 1600 })
      if (!url) throw new ToolError('Could not render that layer.')
      return [{ type: 'image', data: dataURLToBase64(url), mimeType: 'image/png' }]
    },
  },
  {
    tool: {
      name: 'create_node',
      description:
        'Create one layer. type: frame | rect | ellipse | path | text | image | shader. A path is a vector shape: pass props.path {d, viewBox}. Omit parentId to create a top-level artboard on the current page. Inside flex frames the child flows automatically (index sets order).',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['frame', 'rect', 'ellipse', 'path', 'text', 'image', 'shader'] },
          parentId: { type: 'string' },
          index: { type: 'number' },
          props: PATCH_SCHEMA,
        },
        required: ['type'],
      },
    },
    run: (a) => {
      const s = getEditor()
      const type = String(a.type) as NodeType
      if (!['frame', 'rect', 'ellipse', 'path', 'text', 'image', 'shader'].includes(type)) throw new ToolError('Unknown type ' + type)
      const parent = a.parentId ? nodeOr404(a.parentId) : null
      const parentId = parent?.id ?? null
      // inside a parent: that parent's page; a new artboard: the page the user is looking at
      const n = createNode(type, parent?.pageId ?? s.pageId)
      if (type === 'shader') n.shader = defaultShaderSpec('aurora')
      if (type === 'frame' && parentId) {
        n.fills = []
        n.clip = false
      }
      applyPatch(n, (a.props as Args) ?? {})
      if (!parentId && n.x === 0 && n.y === 0) {
        const page = s.doc.pages.find((p) => p.id === s.pageId)!
        const right = Math.max(0, ...page.children.map((c) => (measure(c)?.x ?? 0) + (measure(c)?.w ?? 0)))
        n.x = page.children.length ? Math.round(right + 100) : 0
      }
      s.addNode(n, parentId, typeof a.index === 'number' ? a.index : undefined)
      presence([n.id])
      return text({ id: n.id, name: n.name })
    },
  },
  {
    tool: {
      name: 'write_html',
      description:
        'Fastest way to build UI: write HTML with inline styles or a <style> block. Kiln renders it, reads computed styles and converts it into native editable layers with flex layout, text, images and SVG icons. Use display:flex for layout. Omit parentId to create a new artboard.',
      inputSchema: {
        type: 'object',
        properties: {
          html: { type: 'string' },
          parentId: { type: 'string', description: 'Frame to insert into' },
          index: { type: 'number' },
          width: { type: 'number', description: 'Viewport width used to lay out the HTML (default 1280)' },
          x: { type: 'number' },
          y: { type: 'number' },
        },
        required: ['html'],
      },
    },
    run: (a) => {
      const s = getEditor()
      const parent = a.parentId ? nodeOr404(a.parentId) : null
      const parentId = parent?.id ?? null
      const { nodes, rootIds } = htmlToNodes(String(a.html), parent?.pageId ?? s.pageId, { width: Number(a.width ?? (parentId ? measure(parentId)?.w ?? 1280 : 1280)) })
      if (!rootIds.length) throw new ToolError('The HTML produced no visible elements.')
      if (!parentId) {
        const page = s.doc.pages.find((p) => p.id === s.pageId)!
        const right = Math.max(0, ...page.children.map((c) => (measure(c)?.x ?? 0) + (measure(c)?.w ?? 0)))
        let y = Number(a.y ?? 0)
        for (const id of rootIds) {
          const n = nodes.find((x) => x.id === id)!
          n.x = typeof a.x === 'number' ? a.x : page.children.length ? Math.round(right + 100) : 0
          n.y = y
          y += n.height + 40
          if (n.type === 'frame' && !n.fills.length) n.fills = [solidFill('#FFFFFF')]
          n.clip = true
        }
      }
      s.insertNodes(nodes, rootIds, parentId, typeof a.index === 'number' ? a.index : undefined)
      presence(rootIds)
      return text({ created: rootIds, layers: nodes.length })
    },
  },
  {
    tool: {
      name: 'update_nodes',
      description: 'Patch style/content of one or more layers. Same props format as create_node.',
      inputSchema: { type: 'object', properties: { nodeIds: { type: 'array', items: { type: 'string' } }, props: PATCH_SCHEMA }, required: ['nodeIds', 'props'] },
    },
    run: (a) => {
      const ids = (a.nodeIds as string[]).map((id) => nodeOr404(id).id)
      getEditor().setProps(ids, (n) => applyPatch(n as KNode, a.props as Args))
      presence(ids)
      return text({ updated: ids.length })
    },
  },
  {
    tool: {
      name: 'set_text',
      description: 'Replace the text content of text layers. Pass a map of nodeId → string to update many at once (great for real content).',
      inputSchema: { type: 'object', properties: { texts: { type: 'object', additionalProperties: { type: 'string' } } }, required: ['texts'] },
    },
    run: (a) => {
      const map = need(a.texts as Record<string, string>, 'texts is required')
      const ids = Object.keys(map).map((id) => nodeOr404(id).id)
      getEditor().setProps(ids, (n) => {
        if (n.text) n.text.content = map[n.id]
      })
      presence(ids)
      return text({ updated: ids.length })
    },
  },
  {
    tool: {
      name: 'delete_nodes',
      description: 'Delete layers (and their children).',
      inputSchema: { type: 'object', properties: { nodeIds: { type: 'array', items: { type: 'string' } } }, required: ['nodeIds'] },
      annotations: { destructiveHint: true },
    },
    run: (a) => {
      const s = getEditor()
      const ids = (a.nodeIds as string[]).filter((id) => s.doc.nodes[id])
      s.select(ids)
      s.deleteSelection()
      return text({ deleted: ids.length })
    },
  },
  {
    tool: {
      name: 'duplicate_node',
      description: 'Duplicate a layer (deep copy). Top-level artboards are placed to the right. Returns the new id.',
      inputSchema: { type: 'object', properties: { nodeId: { type: 'string' }, name: { type: 'string' } }, required: ['nodeId'] },
    },
    run: (a) => {
      const s = getEditor()
      s.select([nodeOr404(a.nodeId).id])
      const [id] = s.duplicateSelection(true)
      if (a.name) s.setProps([id], (n) => void (n.name = String(a.name)))
      presence([id])
      return text({ id })
    },
  },
  {
    tool: {
      name: 'move_node',
      description: 'Reparent and/or reorder a layer. parentId null moves it to the top level of the page.',
      inputSchema: { type: 'object', properties: { nodeId: { type: 'string' }, parentId: { type: ['string', 'null'] }, index: { type: 'number' } }, required: ['nodeId'] },
    },
    run: (a) => {
      const n = nodeOr404(a.nodeId)
      const parentId = a.parentId == null ? null : nodeOr404(a.parentId).id
      getEditor().reparent([n.id], parentId, typeof a.index === 'number' ? a.index : null)
      presence([n.id])
      return text({ ok: true, siblings: childrenOf(getEditor().doc, parentId, n.pageId) })
    },
  },
  {
    tool: {
      name: 'select_nodes',
      description: 'Select layers in the editor and scroll them into view so the user can see what you mean.',
      inputSchema: { type: 'object', properties: { nodeIds: { type: 'array', items: { type: 'string' } } }, required: ['nodeIds'] },
    },
    run: (a) => {
      const ids = (a.nodeIds as string[]).map((id) => nodeOr404(id).id)
      const s = getEditor()
      const pageId = s.doc.nodes[ids[0]]?.pageId
      if (pageId && pageId !== s.pageId) s.setPage(pageId)
      s.select(ids)
      requestAnimationFrame(() => zoomToFit(ids))
      return text({ selected: ids })
    },
  },
  {
    tool: {
      name: 'export_code',
      description: 'Generate production code for a layer: html (HTML+CSS), react (TSX + CSS module), tailwind (TSX + Tailwind v4) or vue (SFC).',
      inputSchema: { type: 'object', properties: { nodeId: { type: 'string' }, target: { type: 'string', enum: ['html', 'react', 'tailwind', 'vue'] } }, required: ['nodeId', 'target'] },
      annotations: { readOnlyHint: true },
    },
    run: (a) => {
      const n = nodeOr404(a.nodeId)
      const res = exportNode(getEditor().doc, n.id, String(a.target) as ExportTarget)
      return text(res.files.map((f) => `// ${f.path}\n${f.contents}`).join('\n\n'))
    },
  },
  {
    tool: {
      name: 'create_token',
      description: 'Add a colour design token (exported as a CSS variable). Returns its id; apply with update_nodes is not needed — tokens are applied in the inspector or via apply_token.',
      inputSchema: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } }, required: ['name', 'value'] },
    },
    run: (a) => {
      const t = createToken(String(a.name), String(a.value))
      getEditor().update((d) => void d.tokens.push(t))
      return text({ id: t.id })
    },
  },
  {
    tool: {
      name: 'apply_token',
      description: 'Bind a colour token to layers: their first solid fill (or text colour for text layers).',
      inputSchema: { type: 'object', properties: { tokenId: { type: 'string' }, nodeIds: { type: 'array', items: { type: 'string' } } }, required: ['tokenId', 'nodeIds'] },
    },
    run: (a) => {
      const s = getEditor()
      const token = need(s.doc.tokens.find((t) => t.id === a.tokenId), 'Unknown token')
      const ids = (a.nodeIds as string[]).map((id) => nodeOr404(id).id)
      s.setProps(ids, (n) => {
        if (n.type === 'text' && n.text) n.text.tokenId = token.id
        else {
          const f = n.fills.find((f) => f.type === 'solid')
          if (f) f.tokenId = token.id
          else n.fills.unshift({ ...solidFill(token.value), tokenId: token.id })
        }
      })
      presence(ids)
      return text({ ok: true })
    },
  },
  {
    tool: {
      name: 'add_comment',
      description: 'Leave a comment pinned to a layer (e.g. to explain a change or ask the designer a question).',
      inputSchema: { type: 'object', properties: { nodeId: { type: 'string' }, body: { type: 'string' } }, required: ['body'] },
    },
    run: (a) => {
      const s = getEditor()
      const r = a.nodeId ? measure(nodeOr404(a.nodeId).id) : null
      const id = s.addComment({ pageId: s.pageId, x: r ? r.x + r.w - 8 : 0, y: r ? r.y - 8 : 0, nodeId: a.nodeId ? String(a.nodeId) : undefined, author: 'Kiln Agent', body: String(a.body) })
      return text({ id })
    },
  },
  {
    tool: {
      name: 'create_page',
      description: 'Add a page and switch to it.',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
    run: (a) => {
      const page = createPage(String(a.name))
      const s = getEditor()
      s.update((d) => void d.pages.push(page))
      s.setPage(page.id)
      return text({ id: page.id })
    },
  },
  {
    tool: {
      name: 'find_nodes',
      description: 'Search layers on all pages by name or text content (case-insensitive).',
      inputSchema: { type: 'object', properties: { query: { type: 'string' }, type: { type: 'string' } }, required: ['query'] },
      annotations: { readOnlyHint: true },
    },
    run: (a) => {
      const q = String(a.query).toLowerCase()
      const hits = Object.values(getEditor().doc.nodes)
        .filter((n) => (!a.type || n.type === a.type) && (n.name.toLowerCase().includes(q) || n.text?.content.toLowerCase().includes(q)))
        .slice(0, 50)
        .map((n) => ({ id: n.id, type: n.type, name: n.name, pageId: n.pageId, text: n.text?.content.slice(0, 80) }))
      return text(hits)
    },
  },
]

export const AGENT_TOOLS: McpTool[] = TOOLS.map((t) => t.tool)

export async function runTool(name: string, args: Args = {}): Promise<McpContent[]> {
  const def = TOOLS.find((t) => t.tool.name === name)
  if (!def) throw new Error(`Unknown tool "${name}"`)
  const a = args ?? {}
  const label = toolLabel(name, a)
  activityStart(name, label.verb, toolNodeIds(name, a))
  touched = null
  try {
    const out = await def.run(a)
    // the nodes it changed glow: the ones it pointed at (created ids included), else the ones it was given
    if (label.kind === 'edit') markTrail(touched ?? getEditor().agentAction?.ids ?? [])
    // let layout settle so follow-up reads (measure, screenshot) see the result
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    return out
  } finally {
    touched = null
    activityEnd()
  }
}

/** Expose the API on window for browser agents and the devtools console. */
export function installWindowApi() {
  const api = {
    version: 1,
    tools: AGENT_TOOLS,
    call: (name: string, args?: Args) => runTool(name, args ?? {}),
    /** plays a scripted agent turn over the open page without changing it (dev aid) */
    demo: () => import('./demo').then((m) => m.playAgentDemo()),
    help: () =>
      AGENT_TOOLS.map((t) => `${t.name} — ${t.description}`).join('\n') +
      '\n\nExample: await kiln.call("write_html", { html: "<div style=\\"display:flex;gap:12px;padding:24px\\">…</div>" })',
  }
  ;(window as unknown as { kiln: typeof api }).kiln = api
  return () => {
    delete (window as unknown as { kiln?: unknown }).kiln
  }
}
