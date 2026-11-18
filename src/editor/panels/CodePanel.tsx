import { useEffect, useMemo, useState } from 'react'
import { Check, Copy, Download, FolderDown } from 'lucide-react'
import { useEditor, getEditor } from '../store'
import { exportNode, exportTokensCSS, exportTokensTailwind, nodeCSSDeclarations, shaderRuntimeReady, type ExportTarget, type ExportFile } from '../../codegen'
import { isTauri, desktopExport } from '../../platform/tauri'
import { snapshotNode, downloadDataURL } from '../snapshot'
import { Select, type SelectOption } from '../../ui/Select'
import { FormatIcon, type FormatKind } from './FormatIcons'
import './code-panel.css'

type Tab = ExportTarget | 'css' | 'tokens'

const FORMATS: SelectOption<Tab>[] = [
  { value: 'tailwind', label: 'Tailwind CSS', icon: <FormatIcon kind="tailwind" /> },
  { value: 'react', label: 'React', icon: <FormatIcon kind="react" /> },
  { value: 'html', label: 'HTML', icon: <FormatIcon kind="html" /> },
  { value: 'vue', label: 'Vue', icon: <FormatIcon kind="vue" /> },
  { value: 'css', label: 'CSS', icon: <FormatIcon kind="css" /> },
  { value: 'tokens', label: 'Design tokens', icon: <FormatIcon kind="tokens" /> },
]

/** Tiny syntax highlighter — enough to make code readable, no dependencies. */
function highlight(code: string, lang: string): string {
  const esc = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  if (lang === 'css') {
    return esc
      .replace(/(\/\*[\s\S]*?\*\/)/g, '<i class="c">$1</i>')
      .replace(/^(\s*)([a-z-]+)(:)/gm, '$1<i class="p">$2</i>$3')
      .replace(/(#[0-9a-fA-F]{3,8}\b)/g, '<i class="n">$1</i>')
      .replace(/(-?\d*\.?\d+)(px|%|em|deg|s)\b/g, '<i class="n">$1$2</i>')
  }
  return esc
    .replace(/(\/\/[^\n]*)/g, '<i class="c">$1</i>')
    .replace(/(&quot;|"|')((?:(?!\1).)*?)\1/g, '<i class="s">$1$2$1</i>')
    .replace(/(&lt;\/?)([A-Za-z][\w.-]*)/g, '$1<i class="t">$2</i>')
    .replace(/\b(import|from|export|default|function|return|const|let|useEffect|className|style)\b/g, '<i class="k">$1</i>')
}

/** Language icon for a file tab, picked from its extension. */
function fileIconKind(path: string): FormatKind | null {
  const ext = path.split('.').pop()?.toLowerCase()
  if (ext === 'tsx' || ext === 'jsx') return 'react'
  if (ext === 'vue') return 'vue'
  if (ext === 'html') return 'html'
  if (ext === 'css') return 'css'
  return null
}

function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name.split('/').pop() ?? name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function CodePanel() {
  const selection = useEditor((s) => s.selection)
  const doc = useEditor((s) => s.doc)
  const pageId = useEditor((s) => s.pageId)
  const [tab, setTab] = useState<Tab>('tailwind')
  const [copied, setCopied] = useState(false)
  const [, force] = useState(0)
  useEffect(() => {
    shaderRuntimeReady.then(() => force((x) => x + 1))
  }, [])

  const page = doc.pages.find((p) => p.id === pageId)
  const targetId = selection[0] ?? page?.children[0]
  const node = targetId ? doc.nodes[targetId] : null

  const result = useMemo(() => {
    if (tab === 'tokens') return { files: [{ path: 'tokens.css', contents: exportTokensCSS(doc) + '\n\n/* Tailwind v4 */\n' + exportTokensTailwind(doc), language: 'css' as const }], snippet: '', snippetLanguage: 'css' as const }
    if (!targetId || !node) return null
    if (tab === 'css') return { files: [{ path: 'layer.css', contents: nodeCSSDeclarations(doc, targetId), language: 'css' as const }], snippet: '', snippetLanguage: 'css' as const }
    try {
      return exportNode(doc, targetId, tab)
    } catch (e) {
      return { files: [{ path: 'error.txt', contents: String((e as Error).message), language: 'css' as const }], snippet: '', snippetLanguage: 'css' as const }
    }
  }, [doc, targetId, node, tab])

  const [fileIdx, setFileIdx] = useState(0)
  useEffect(() => setFileIdx(0), [tab, targetId])
  const files: ExportFile[] = result?.files ?? []
  const file = files[Math.min(fileIdx, files.length - 1)]
  const lang = file?.language === 'css' ? 'css' : 'tsx'
  const showTarget = !!node && tab !== 'tokens'

  return (
    <div className="k-code">
      <header className="k-code-top">
        <span className="k-code-name" title={showTarget ? node!.name : 'Design tokens'}>
          {showTarget ? node!.name : 'Design tokens'}
        </span>
        <Select<Tab> value={tab} options={FORMATS} onChange={setTab} title="Export format" width={158} menuWidth={184} />
      </header>

      {files.length > 1 && (
        <div className="k-code-files" role="tablist" aria-label="Files">
          {files.map((f, i) => (
            <button key={f.path} type="button" role="tab" aria-selected={i === fileIdx} className={i === fileIdx ? 'is-on' : ''} onClick={() => setFileIdx(i)}>
              {(() => {
                const kind = fileIconKind(f.path)
                return kind ? <FormatIcon kind={kind} size={12} /> : null
              })()}
              {f.path}
            </button>
          ))}
        </div>
      )}

      {file ? (
        <div className="k-code-card">
          <div className="k-code-bar">
            <span className="k-code-file">{file.path}</span>
            <button
              type="button"
              className="k-code-copy"
              aria-label={copied ? 'Copied' : 'Copy code'}
              title={copied ? 'Copied' : 'Copy code'}
              onClick={() => {
                void navigator.clipboard.writeText(file.contents)
                setCopied(true)
                setTimeout(() => setCopied(false), 1400)
              }}
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
            </button>
          </div>
          <pre className="k-code-pre" dangerouslySetInnerHTML={{ __html: highlight(file.contents, lang) }} />
        </div>
      ) : (
        <div className="k-code-empty">
          <p className="k-code-empty-title">No layer selected</p>
          <p className="k-code-empty-body">Select a layer to see its code.</p>
        </div>
      )}

      {file && (
        <footer className="k-code-actions">
          <button
            type="button"
            className="k-btn-primary k-code-primary"
            onClick={async () => {
              if (isTauri) {
                const where = await desktopExport(files.map((f) => ({ path: f.path, contents: f.contents })))
                if (where) getEditor().notify(`Exported ${files.length} file${files.length > 1 ? 's' : ''} to ${where}`)
              } else files.forEach((f) => downloadText(f.path, f.contents))
            }}
          >
            {isTauri ? <FolderDown size={13} /> : <Download size={13} />}
            {isTauri ? 'Export to folder' : files.length > 1 ? `Download ${files.length} files` : 'Download'}
          </button>
          {node && (
            <button
              type="button"
              className="k-btn-ghost k-code-secondary"
              onClick={async () => {
                const url = await snapshotNode(node.id, { scale: 2 })
                if (url) downloadDataURL(url, `${node.name.replace(/[^\w-]+/g, '-')}@2x.png`)
                else getEditor().notify('Could not render PNG for this layer')
              }}
            >
              <Download size={13} />
              PNG @2x
            </button>
          )}
        </footer>
      )}
    </div>
  )
}
