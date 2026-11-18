import { useLayoutEffect, useRef, useState } from 'react'
import { Sparkles, type LucideIcon } from 'lucide-react'
import { useEditor, getEditor } from './store'
import { measure, measureSize, unionRects } from './geometry'
import { overlayStartMove, overlayStartResize } from './Canvas'
import type { Camera, Rect } from './types'
import type { PenDraft } from './store'
import { pointsToD } from './vector'
import { CommentThread } from './Comments'
import { parseColor } from '../ui/color'
import { toolLabel } from '../agent/humanize'
import './agent-presence.css'

interface Measured {
  sel: Record<string, Rect>
  hover: Rect | null
  target: Rect | null
  artboards: { id: string; r: Rect; name: string }[]
  gaps: Rect[]
  padding: Rect[]
  /** nodes the agent is touching: outlined */
  focus: Record<string, Rect>
  /** nodes it changed just now: fading afterglow */
  glow: { key: string; r: Rect }[]
  /** where the agent's cursor points, in document space (kept while the agent is between actions) */
  cursor: { x: number; y: number } | null
  /** provider label for the cursor pill */
  provider: string
  /** the canvas box in CSS pixels, so the cursor and its pill stay inside it */
  box: { w: number; h: number }
  comments: Record<string, Rect>
}

const AFTERGLOW_MS = 1200
const LEAVE_MS = 600

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const

export function Overlay({ createRect }: { createRect: Rect | null }) {
  const doc = useEditor((s) => s.doc)
  const pageId = useEditor((s) => s.pageId)
  const selection = useEditor((s) => s.selection)
  const hoverId = useEditor((s) => s.hoverId)
  const drag = useEditor((s) => s.drag)
  const marquee = useEditor((s) => s.marquee)
  const guides = useEditor((s) => s.guides)
  const tick = useEditor((s) => s.measureTick)
  const cam = useEditor((s) => s.camera)
  const editingTextId = useEditor((s) => s.editingTextId)
  const agentFocus = useEditor((s) => s.agentFocus)
  const agentAction = useEditor((s) => s.agentAction)
  const agentTrail = useEditor((s) => s.agentTrail)
  const agentTurn = useEditor((s) => s.agentTurn)
  const activeCommentId = useEditor((s) => s.activeCommentId)
  const layoutGuides = useEditor((s) => s.view.layoutGuides)
  const presence = useEditor((s) => s.view.presence)
  const showComments = useEditor((s) => s.view.showComments)
  const [m, setM] = useState<Measured>({ sel: {}, hover: null, target: null, artboards: [], gaps: [], padding: [], focus: {}, glow: [], cursor: null, provider: '', box: { w: 0, h: 0 }, comments: {} })
  const rootRef = useRef<HTMLDivElement>(null)
  // the cursor stays up for a moment after the turn ends, then leaves
  const turnLive = useLingering(!!agentTurn, LEAVE_MS)

  const page = doc.pages.find((p) => p.id === pageId)

  useLayoutEffect(() => {
    const sel: Record<string, Rect> = {}
    for (const id of selection) {
      const r = measure(id)
      if (r) sel[id] = r
    }
    const artboards: Measured['artboards'] = []
    for (const id of page?.children ?? []) {
      const n = doc.nodes[id]
      if (n?.type === 'frame' && n.visible) {
        const r = measure(id)
        if (r) artboards.push({ id, r, name: n.name })
      }
    }
    // flex visualisation for a single selected flex frame
    const gaps: Rect[] = []
    const padding: Rect[] = []
    if (selection.length === 1 && !drag) {
      const n = doc.nodes[selection[0]]
      const fr = sel[selection[0]]
      if (n?.type === 'frame' && n.layout.mode === 'flex' && fr && !n.rotation) {
        const [pt, pr, pb, pl] = n.layout.padding
        if (pt) padding.push({ x: fr.x, y: fr.y, w: fr.w, h: pt })
        if (pb) padding.push({ x: fr.x, y: fr.y + fr.h - pb, w: fr.w, h: pb })
        if (pl) padding.push({ x: fr.x, y: fr.y + pt, w: pl, h: fr.h - pt - pb })
        if (pr) padding.push({ x: fr.x + fr.w - pr, y: fr.y + pt, w: pr, h: fr.h - pt - pb })
        if (n.layout.gap && !n.layout.wrap) {
          const kids = n.children.filter((c) => doc.nodes[c]?.visible && doc.nodes[c]?.positioning !== 'absolute')
          const rs = kids.map((k) => measure(k)).filter(Boolean) as Rect[]
          for (let i = 1; i < rs.length; i++) {
            const a = rs[i - 1]
            const b = rs[i]
            if (n.layout.direction === 'row') gaps.push({ x: a.x + a.w, y: fr.y + pt, w: Math.max(0, b.x - a.x - a.w), h: fr.h - pt - pb })
            else gaps.push({ x: fr.x + pl, y: a.y + a.h, w: fr.w - pl - pr, h: Math.max(0, b.y - a.y - a.h) })
          }
        }
      }
    }
    const focus: Record<string, Rect> = {}
    for (const id of agentFocus) {
      const r = measure(id)
      if (r) focus[id] = r
    }
    const now = Date.now()
    const glow: Measured['glow'] = []
    for (const [id, at] of Object.entries(agentTrail)) {
      const r = now - at <= AFTERGLOW_MS ? measure(id) : null
      if (r) glow.push({ key: `${id}:${at}`, r })
    }
    // one cursor per agent, aimed at the union of what the current action touches
    const hit = (agentAction?.ids ?? []).map((id) => measure(id)).filter((r): r is Rect => !!r)
    const target = unionRects(hit)
    const comments: Record<string, Rect> = {}
    setM((prev) => ({
      sel,
      hover: hoverId && !selection.includes(hoverId) ? measure(hoverId) : null,
      target: drag?.targetParent ? measure(drag.targetParent) : null,
      artboards,
      gaps,
      padding,
      focus,
      glow,
      cursor: target ? { x: target.x, y: target.y } : prev.cursor,
      provider: agentTurn?.provider ?? prev.provider,
      box: { w: rootRef.current?.clientWidth ?? 0, h: rootRef.current?.clientHeight ?? 0 },
      comments,
    }))
  }, [doc, selection, hoverId, drag, tick, pageId, page, agentFocus, agentAction, agentTrail, agentTurn])

  const S = (r: Rect) => ({ left: r.x * cam.zoom + cam.x, top: r.y * cam.zoom + cam.y, width: r.w * cam.zoom, height: r.h * cam.zoom })
  const selRects = Object.values(m.sel)
  const single = selection.length === 1 ? m.sel[selection[0]] : null
  const singleNode = selection.length === 1 ? doc.nodes[selection[0]] : null
  const group = selRects.length > 1 ? unionRects(selRects) : null
  const showHandles = single && singleNode && !singleNode.locked && !drag && !editingTextId

  const sizeLabel = () => {
    if (!singleNode || !single) {
      if (group) return `${Math.round(group.w)} × ${Math.round(group.h)}`
      return ''
    }
    const w = singleNode.widthMode === 'hug' ? 'Hug' : singleNode.widthMode === 'fill' ? 'Fill' : ''
    const h = singleNode.heightMode === 'hug' ? 'Hug' : singleNode.heightMode === 'fill' ? 'Fill' : ''
    const size = measureSize(singleNode.id)
    const W = size ? size.w : Math.round(single.w)
    const H = size ? size.h : Math.round(single.h)
    return `${Math.round(W)}${w ? ' ' + w : ''} × ${Math.round(H)}${h ? ' ' + h : ''}`
  }
  const badgeRect = single ?? group

  const [renamingFrame, setRenamingFrame] = useState<string | null>(null)
  const pageBg = useEditor((s) => s.doc.pages.find((p) => p.id === s.pageId)?.background ?? '#E9E6E1')
  const bg = parseColor(pageBg)
  const darkCanvas = !!bg && (0.2126 * bg.r + 0.7152 * bg.g + 0.0722 * bg.b) / 255 < 0.45
  const pageComments = showComments ? doc.comments.filter((c) => c.pageId === pageId && !c.resolved) : []

  return (
    <div className={'k-overlay' + (darkCanvas ? ' is-dark-canvas' : '')} ref={rootRef}>
      {/* artboard labels */}
      {m.artboards.map(({ id, r, name }) => {
        const s = S(r)
        const selected = selection.includes(id)
        return (
          <div
            key={id}
            data-overlay-ui
            className={'k-artboard-label' + (selected ? ' is-selected' : '')}
            style={{ left: s.left, top: s.top - 20, maxWidth: Math.max(40, s.width) }}
            onPointerDown={(e) => {
              if (e.button !== 0) return
              e.stopPropagation()
              const st = getEditor()
              if (e.shiftKey) st.select([id], true)
              else if (!st.selection.includes(id)) st.select([id])
              overlayStartMove(e.clientX, e.clientY, e.pointerId)
            }}
            onDoubleClick={(e) => {
              e.stopPropagation()
              setRenamingFrame(id)
            }}
          >
            {renamingFrame === id ? (
              <input
                className="k-artboard-rename"
                autoFocus
                defaultValue={name}
                spellCheck={false}
                autoComplete="off"
                onFocus={(e) => e.currentTarget.select()}
                onPointerDown={(e) => e.stopPropagation()}
                onBlur={(e) => {
                  const v = e.currentTarget.value.trim()
                  if (v && v !== name) getEditor().setProps([id], (n) => void (n.name = v))
                  setRenamingFrame(null)
                }}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') e.currentTarget.blur()
                  if (e.key === 'Escape') setRenamingFrame(null)
                }}
              />
            ) : (
              name
            )}
          </div>
        )
      })}

      {/* flex visualisation */}
      {layoutGuides &&
        m.padding.map((r, i) => (
          <div key={'p' + i} className="k-pad" style={S(r)} />
        ))}
      {layoutGuides &&
        m.gaps.map((r, i) => (
          <div key={'g' + i} className="k-gap" style={S(r)} />
        ))}

      {m.hover && !drag && <div className="k-hover" style={S(m.hover)} />}
      {m.target && <div className="k-drop-target" style={S(m.target)} />}
      {drag?.indicator && <div className="k-insert" style={S(drag.indicator)} />}

      {selRects.map((r, i) => (
        <div key={i} className={'k-sel' + (drag ? ' is-dragging' : '')} style={S(r)} />
      ))}
      {group && !drag && <div className="k-sel-group" style={S(group)} />}

      {/* agent presence: outlines on the nodes in use, afterglow on the ones just changed, and one cursor */}
      {presence &&
        Object.entries(m.focus).map(([id, r]) => (
          <div key={'f' + id} className="k-ap-focus" style={S(r)}>
            <i className="k-ap-tick tl" />
            <i className="k-ap-tick tr" />
            <i className="k-ap-tick bl" />
            <i className="k-ap-tick br" />
          </div>
        ))}
      {presence && m.glow.map((g) => <div key={'g' + g.key} className="k-ap-glow" style={S(g.r)} />)}
      {presence && turnLive && m.cursor && (
        <AgentCursor
          at={clampPoint(S({ x: m.cursor.x, y: m.cursor.y, w: 0, h: 0 }), m.box)}
          box={m.box}
          provider={agentTurn?.provider ?? m.provider ?? 'Agent'}
          label={agentAction?.label ?? 'Working…'}
          icon={agentAction ? toolLabel(agentAction.tool).icon : Sparkles}
          leaving={!agentTurn}
        />
      )}

      {showHandles &&
        HANDLES.map((h) => {
          const s = S(single!)
          const isText = singleNode!.type === 'text'
          if (isText && singleNode!.widthMode === 'hug' && (h === 'n' || h === 's')) return null
          const x = h.includes('w') ? s.left : h.includes('e') ? s.left + s.width : s.left + s.width / 2
          const y = h.includes('n') ? s.top : h.includes('s') ? s.top + s.height : s.top + s.height / 2
          const edge = h.length === 1
          return (
            <div
              key={h}
              data-overlay-ui
              className={'k-handle ' + (edge ? 'is-edge is-' + h : 'is-corner')}
              style={
                edge
                  ? h === 'n' || h === 's'
                    ? { left: s.left + 6, top: y - 4, width: Math.max(0, s.width - 12), height: 8, cursor: 'ns-resize' }
                    : { left: x - 4, top: s.top + 6, width: 8, height: Math.max(0, s.height - 12), cursor: 'ew-resize' }
                  : { left: x - 4, top: y - 4, cursor: h === 'nw' || h === 'se' ? 'nwse-resize' : 'nesw-resize' }
              }
              onPointerDown={(e) => {
                if (e.button !== 0) return
                e.stopPropagation()
                overlayStartResize(singleNode!.id, h, e.clientX, e.clientY, e.pointerId)
              }}
            />
          )
        })}

      {badgeRect && !editingTextId && (
        <div
          className="k-size-badge"
          style={{
            left: Math.round(S(badgeRect).left + (badgeRect.w * cam.zoom) / 2),
            top: Math.round(S(badgeRect).top + badgeRect.h * cam.zoom + 8),
          }}
        >
          {sizeLabel()}
        </div>
      )}

      {guides.map((g, i) =>
        g.axis === 'x' ? (
          <div key={'gd' + i} className="k-guide" style={{ left: g.pos * cam.zoom + cam.x, top: g.from * cam.zoom + cam.y, width: 1, height: (g.to - g.from) * cam.zoom }} />
        ) : (
          <div key={'gd' + i} className="k-guide" style={{ left: g.from * cam.zoom + cam.x, top: g.pos * cam.zoom + cam.y, height: 1, width: (g.to - g.from) * cam.zoom }} />
        ),
      )}

      {marquee && <div className="k-marquee" style={S(marquee)} />}
      <PenPreview cam={cam} />
      {createRect && <div className="k-create" style={S(createRect)} />}

      {pageComments.map((c, i) => {
        const left = c.x * cam.zoom + cam.x
        const top = c.y * cam.zoom + cam.y
        const open = activeCommentId === c.id
        return (
          <div key={c.id} data-overlay-ui className="k-comment-anchor" style={{ left, top }}>
            <button
              className={'k-comment-pin' + (open ? ' is-open' : '')}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => getEditor().set({ activeCommentId: open ? null : c.id })}
              title={c.body || 'Comment'}
            >
              {i + 1}
            </button>
            {open && <CommentThread comment={c} />}
          </div>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------- pen */

/** The path being drawn: segments so far, the rubber band to the pointer, anchors and the live handles. */
function PenPreview({ cam }: { cam: Camera }) {
  const d: PenDraft | null = useEditor((s) => s.penDraft)
  if (!d || !d.points.length) return null
  const T = (p: { x: number; y: number }) => ({ x: p.x * cam.zoom + cam.x, y: p.y * cam.zoom + cam.y })
  const pts = d.points.map((p) => ({ ...T(p), in: p.in && T(p.in), out: p.out && T(p.out) }))
  const last = pts[pts.length - 1]
  const cur = d.cursor && T(d.cursor)
  // the rubber band follows the last anchor's outgoing handle, and curves into the first anchor when closing
  const first = pts[0]
  const band = cur
    ? last.out || (d.closing && first.in)
      ? `M${last.x} ${last.y} C${(last.out ?? last).x} ${(last.out ?? last).y} ${(d.closing && first.in ? first.in : cur).x} ${(d.closing && first.in ? first.in : cur).y} ${cur.x} ${cur.y}`
      : `M${last.x} ${last.y} L${cur.x} ${cur.y}`
    : null
  // handles are shown for the anchor being placed (and its neighbour's incoming side)
  const handles = [last, pts.length > 1 ? pts[pts.length - 2] : null, d.closing ? first : null].filter(Boolean) as typeof pts
  return (
    <svg className="k-pen" aria-hidden>
      <path className="k-pen-path" d={pointsToD(pts, false)} />
      {band && <path className="k-pen-band" d={band} />}
      {handles.map((p, i) =>
        [p.in, p.out].map(
          (h, j) =>
            h && (
              <g key={i + '-' + j}>
                <line className="k-pen-arm" x1={p.x} y1={p.y} x2={h.x} y2={h.y} />
                <circle className="k-pen-knob" cx={h.x} cy={h.y} r={3} />
              </g>
            ),
        ),
      )}
      {pts.map((p, i) => (
        <rect
          key={i}
          className={'k-pen-anchor' + (i === pts.length - 1 ? ' is-last' : '') + (i === 0 && d.closing ? ' is-target' : '')}
          x={p.x - (i === 0 && d.closing ? 5 : 3.5)}
          y={p.y - (i === 0 && d.closing ? 5 : 3.5)}
          width={i === 0 && d.closing ? 10 : 7}
          height={i === 0 && d.closing ? 10 : 7}
        />
      ))}
    </svg>
  )
}

/** True while `active`, and for `ms` after it turns off. */
function useLingering(active: boolean, ms: number): boolean {
  const [was, setWas] = useState(active)
  const [lingering, setLingering] = useState(false)
  // the turn just ended: keep the cursor up for `ms`. Set during render, the React pattern for "state from a prop change"
  if (active !== was) {
    setWas(active)
    setLingering(!active)
  }
  useLayoutEffect(() => {
    if (!lingering) return
    const t = window.setTimeout(() => setLingering(false), ms)
    return () => window.clearTimeout(t)
  }, [lingering, ms])
  return active || lingering
}

/** Keeps a screen point inside the canvas, a few pixels in from the edge. */
function clampPoint(p: { left: number; top: number }, box: { w: number; h: number }) {
  if (!box.w || !box.h) return { x: p.left, y: p.top }
  return { x: Math.min(Math.max(p.left, 4), box.w - 4), y: Math.min(Math.max(p.top, 4), box.h - 4) }
}

function AgentCursor({
  at,
  box,
  provider,
  label,
  icon: Icon,
  leaving,
}: {
  at: { x: number; y: number }
  box: { w: number; h: number }
  provider: string
  label: string
  icon: LucideIcon
  leaving: boolean
}) {
  // flip the pill to the arrow's left near the right edge, and above it near the bottom
  const flip = box.w > 0 && at.x > box.w - 300
  const up = box.h > 0 && at.y > box.h - 60
  return (
    <div
      className={'k-ap-cursor' + (flip ? ' is-flip' : '') + (up ? ' is-up' : '')}
      style={{ transform: `translate3d(${at.x}px, ${at.y}px, 0)` }}
    >
      <div className={'k-ap-cursor-in' + (leaving ? ' is-leaving' : '')}>
        <svg className="k-ap-arrow" width="16" height="18" viewBox="0 0 16 18" aria-hidden="true">
          <path d="M1.5 1.5 L1.5 14.2 L5.1 10.9 L7.6 16.4 L10.1 15.3 L7.7 9.9 L12.4 9.9 Z" fill="var(--k-ember)" stroke="#fff" strokeWidth="1.2" strokeLinejoin="round" />
        </svg>
        <div className="k-ap-pill" role="status" aria-live="polite">
          <span className="k-ap-pill-icon" aria-hidden="true">
            <Icon size={10} strokeWidth={2.6} />
          </span>
          <span key={label} className="k-ap-pill-text">
            <b>{provider}</b>
            <span className="k-ap-sep">·</span>
            <span>{label}</span>
          </span>
        </div>
      </div>
    </div>
  )
}
