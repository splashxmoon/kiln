import { Circle, Frame, Hand, Image as ImageIcon, MessageCircle, MousePointer2, PenTool, Sparkles, Square, Type } from 'lucide-react'
import { useEditor, getEditor } from '../store'
import type { Tool } from '../types'

const TOOLS: { tool: Tool; icon: typeof Frame; label: string; key: string }[] = [
  { tool: 'move', icon: MousePointer2, label: 'Move', key: 'V' },
  { tool: 'hand', icon: Hand, label: 'Hand', key: 'H' },
  { tool: 'frame', icon: Frame, label: 'Frame', key: 'F' },
  { tool: 'rect', icon: Square, label: 'Rectangle', key: 'R' },
  { tool: 'ellipse', icon: Circle, label: 'Ellipse', key: 'O' },
  { tool: 'pen', icon: PenTool, label: 'Pen', key: 'P' },
  { tool: 'text', icon: Type, label: 'Text', key: 'T' },
  { tool: 'image', icon: ImageIcon, label: 'Image', key: 'I' },
  { tool: 'shader', icon: Sparkles, label: 'Shader', key: 'S' },
  { tool: 'comment', icon: MessageCircle, label: 'Comment', key: 'C' },
]

export function Toolbar() {
  const tool = useEditor((s) => s.tool)
  return (
    <div className="k-toolbar" role="toolbar" aria-label="Tools">
      {TOOLS.map(({ tool: t, icon: Icon, label, key }, i) => (
        <span key={t} className="k-toolbar-slot">
          {(t === 'frame' || t === 'comment') && i > 0 && <span className="k-toolbar-sep" />}
          <button
            className={'k-tool' + (tool === t ? ' is-on' : '')}
            onClick={() => getEditor().setTool(t)}
            aria-label={`${label} (${key})`}
            aria-pressed={tool === t}
          >
            <Icon size={16} />
            <span className="k-tip">
              {label} <kbd>{key}</kbd>
            </span>
          </button>
        </span>
      ))}
    </div>
  )
}
