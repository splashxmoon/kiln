import { memo, useLayoutEffect, useRef } from 'react'
import type { CSSProperties } from 'react'
import { useEditor, getEditor } from './store'
import { nodeToCSS } from './style'
import { ShaderCanvas } from '../shaders/ShaderCanvas'
import { vectorPaint, type SvgGradient } from './vector'

export const NodeView = memo(function NodeView({ id }: { id: string }) {
  const node = useEditor((s) => s.doc.nodes[id])
  const parent = useEditor((s) => {
    const n = s.doc.nodes[id]
    return n?.parentId ? s.doc.nodes[n.parentId] : null
  })
  const tokens = useEditor((s) => s.doc.tokens)
  const editing = useEditor((s) => s.editingTextId === id)
  const drag = useEditor((s) => (s.drag && s.drag.ids.includes(id) ? s.drag : null))

  if (!node) return null
  const style = nodeToCSS(node, parent, tokens) as CSSProperties
  if (drag) {
    style.transform = `translate(${drag.dx}px, ${drag.dy}px)${style.transform ? ' ' + style.transform : ''}`
    style.zIndex = 10000
    style.pointerEvents = 'none'
    style.opacity = Math.min(Number(style.opacity ?? 1), 0.85)
  }

  const common = {
    'data-id': id,
    'data-type': node.type,
    className: 'kn',
  }

  if (node.type === 'text') {
    if (editing) return <TextEditor id={id} style={style} />
    return (
      <div {...common} style={style}>
        {node.text?.content || '​'}
      </div>
    )
  }
  if (node.type === 'path' && node.path) {
    const p = node.path
    const paint = vectorPaint(node, tokens, 'kg-' + id)
    const st = paint.stroke
    return (
      <svg {...common} style={style} viewBox={`0 0 ${p.w} ${p.h}`} preserveAspectRatio="none">
        {paint.gradient && (
          <defs>
            <SvgGradientDef g={paint.gradient} />
          </defs>
        )}
        <path
          d={p.d}
          fill={paint.fill}
          stroke={st?.color ?? 'none'}
          strokeWidth={st?.width}
          strokeDasharray={st?.dash}
          strokeLinecap={st?.cap}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    )
  }
  if (node.type === 'shader' && node.shader) {
    return (
      <div {...common} style={style}>
        <ShaderCanvas spec={node.shader} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
        {node.children.map((c) => (
          <NodeView key={c} id={c} />
        ))}
      </div>
    )
  }
  return (
    <div {...common} style={style}>
      {node.children.map((c) => (
        <NodeView key={c} id={c} />
      ))}
    </div>
  )
})

export function SvgGradientDef({ g }: { g: SvgGradient }) {
  const stops = g.stops.map((s, i) => <stop key={i} offset={s.offset} stopColor={s.color} />)
  return g.type === 'radial' ? (
    <radialGradient id={g.id}>{stops}</radialGradient>
  ) : (
    <linearGradient id={g.id} gradientTransform={g.transform}>
      {stops}
    </linearGradient>
  )
}

function TextEditor({ id, style }: { id: string; style: CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null)
  const initial = useRef(getEditor().doc.nodes[id]?.text?.content ?? '')

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.textContent = initial.current
    el.focus()
    const range = document.createRange()
    range.selectNodeContents(el)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  }, [])


  return (
    <div
      ref={ref}
      data-id={id}
      data-type="text"
      className="kn kn-editing"
      style={{ ...style, cursor: 'text', outline: 'none', userSelect: 'text' }}
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      spellCheck={false}
      onInput={(e) => {
        const text = (e.currentTarget as HTMLDivElement).innerText.replace(/\n$/, '')
        const s = getEditor()
        s.setProps([id], (n) => {
          if (n.text) n.text.content = text
        }, 'text:' + id)
        s.bumpMeasure()
      }}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
          e.preventDefault()
          getEditor().set({ editingTextId: null, selection: [id] })
        }
      }}
      onBlur={() => {
        const s = getEditor()
        if (s.editingTextId === id) s.set({ editingTextId: null })
      }}
      onPointerDown={(e) => e.stopPropagation()}
    />
  )
}
