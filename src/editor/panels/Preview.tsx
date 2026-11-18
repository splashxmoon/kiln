import { X } from 'lucide-react'
import { useEditor, getEditor } from '../store'
import { isMac, isTauri, onWindowDragMouseDown } from '../../platform/tauri'
import { WindowControls } from '../../platform/WindowControls'

/**
 * Preview-only styles added to the exported page: the artboard is a fixed width, so
 * centre it on a dark backdrop (like the editor around it) instead of pinning it left
 * on a white page. The exported code itself is unchanged.
 */
const PREVIEW_STYLE = '<style data-kiln-preview>html{background:#1c1b19}body{min-height:100vh}body>:not(script){margin-inline:auto}</style>'

function withPreviewStyle(html: string) {
  return html.includes('</head>') ? html.replace('</head>', PREVIEW_STYLE + '</head>') : PREVIEW_STYLE + html
}

/**
 * Full-screen preview of the exported page. Rendered in an iframe with `srcdoc`
 * so it works in both the web app and the Tauri desktop webview (which cannot
 * open blob: URLs in a new window). `allow-scripts` lets the shader runtime run;
 * no same-origin access is granted to the exported document.
 */
export function PreviewSheet() {
  const preview = useEditor((s) => s.preview)
  if (!preview) return null
  const close = () => getEditor().set({ preview: null })
  return (
    <div className="k-preview" role="dialog" aria-label={`Preview: ${preview.title}`}>
      {/* on the Mac app this bar sits under the window buttons: inset it and let it drag the window */}
      <div className={'k-preview-head' + (isTauri && isMac ? ' is-desktop-mac' : '')} onMouseDown={onWindowDragMouseDown}>
        <b className="k-preview-title">{preview.title}</b>
        <span className="k-preview-hint">Esc to close</span>
        <button className="k-icon-btn" title="Close preview (Esc)" onClick={close}>
          <X size={14} />
        </button>
        <WindowControls />
      </div>
      {/* aria-label, not title: a title would become a Kiln tooltip over the whole page */}
      <iframe className="k-preview-frame" aria-label={preview.title} srcDoc={withPreviewStyle(preview.html)} sandbox="allow-scripts" />
    </div>
  )
}
