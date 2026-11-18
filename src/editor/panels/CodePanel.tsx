import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Check, Copy, Download, FolderDown, Images } from 'lucide-react'
import { useEditor, getEditor, type EditorState } from '../store'
import { exportNode, exportTokensCSS, exportTokensTailwind, nodeCSSDeclarations, shaderRuntimeReady, type ExportTarget, type ExportFile } from '../../codegen'
import { isTauri, desktopExport } from '../../platform/tauri'
import { exportArtboards, exportImage, imageFileName, saveImages, type ImageFormat } from '../snapshot'
import { Select, type SelectOption } from '../../ui/Select'
import { Segmented } from '../ui/controls'
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

/**
 * Everything the export of `targetId` reads, as object references: the layer and everything inside
 * it, its ancestors and its parent's children (position and tags depend on them) and the tokens.
 * Immer keeps unchanged layers the same objects, so this list changes only when one of those
 * layers does: an edit elsewhere, a pan or a hover doesn't regenerate the code.
 */
function exportInputs(s: EditorState, tab: Tab, targetId: string | undefined): unknown[] {
  const doc = s.doc
  // the tokens file lists the fonts of every text layer, so it follows the whole document
  if (tab === 'tokens') return [doc.tokens, doc.nodes]
  const n = targetId ? doc.nodes[targetId] : undefined
  if (!n) return [doc.tokens]
  const out: unknown[] = [doc.tokens]
  const walk = (id: string) => {
    const x = doc.nodes[id]
    if (!x) return
    out.push(x)
    for (const c of x.children) walk(c)
  }
  walk(n.id)
  for (let p = n.parentId; p; p = doc.nodes[p]?.parentId ?? null) {
    const a = doc.nodes[p]
    if (!a) break
    out.push(a)
    if (p === n.parentId) for (const c of a.children) if (c !== n.id) out.push(doc.nodes[c])
  }
  return out
}

const IMAGE_FORMATS: { value: ImageFormat; label: string; title: string }[] = [
  { value: 'png', label: 'PNG', title: 'PNG: sharp, keeps transparency' },
  { value: 'jpg', label: 'JPG', title: 'JPG: smaller, white where the layer is transparent' },
  { value: 'svg', label: 'SVG', title: 'Browser SVG: the layer’s HTML inside an SVG' },
]
const SCALES: { value: '1' | '2' | '3'; label: string; title: string }[] = [
  { value: '1', label: '1x', title: 'Actual size' },
  { value: '2', label: '2x', title: 'Twice the size (retina)' },
  { value: '3', label: '3x', title: 'Three times the size' },
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
  const [tab, setTab] = useState<Tab>('tailwind')
  // the layer shown: the first selected, else the page's first artboard
  const targetId = useEditor((s) => s.selection[0] ?? s.doc.pages.find((p) => p.id === s.pageId)?.children[0])
  const node = useEditor((s) => (targetId ? s.doc.nodes[targetId] : undefined)) ?? null
  const inputs = useEditor(useShallow((s) => exportInputs(s, tab, targetId)))
  // typing or dragging keeps going at full speed; the code catches up when there's time
  const deferredInputs = useDeferredValue(inputs)
  const [copied, setCopied] = useState(false)
  const [imageFormat, setImageFormat] = useState<ImageFormat>('png')
  const [scale, setScale] = useState<'1' | '2' | '3'>('2')
  const [exporting, setExporting] = useState(false)
  const artboardCount = useEditor((s) => {
    const page = s.doc.pages.find((p) => p.id === s.pageId)
    return (page?.children ?? []).filter((id) => s.doc.nodes[id]?.type === 'frame' && s.doc.nodes[id].visible).length
  })
  const [, force] = useState(0)
  useEffect(() => {
    shaderRuntimeReady.then(() => force((x) => x + 1))
  }, [])

  const result = useMemo(() => {
    void deferredInputs // what this depends on; the export reads the current document
    const doc = getEditor().doc
    if (tab === 'tokens') return { files: [{ path: 'tokens.css', contents: exportTokensCSS(doc) + '\n\n/* Tailwind v4 */\n' + exportTokensTailwind(doc), language: 'css' as const }], snippet: '', snippetLanguage: 'css' as const }
    if (!targetId || !doc.nodes[targetId]) return null
    if (tab === 'css') return { files: [{ path: 'layer.css', contents: nodeCSSDeclarations(doc, targetId), language: 'css' as const }], snippet: '', snippetLanguage: 'css' as const }
    try {
      return exportNode(doc, targetId, tab)
    } catch (e) {
      return { files: [{ path: 'error.txt', contents: String((e as Error).message), language: 'css' as const }], snippet: '', snippetLanguage: 'css' as const }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deferredInputs, targetId, tab])

  const [fileIdx, setFileIdx] = useState(0)
  useEffect(() => setFileIdx(0), [tab, targetId])
  const files: ExportFile[] = result?.files ?? []
  const file = files[Math.min(fileIdx, files.length - 1)]
  const lang = file?.language === 'css' ? 'css' : 'tsx'
  const showTarget = !!node && tab !== 'tokens'

  /** run one image export at a time; the button shows it is busy meanwhile */
  const busy = async (job: () => Promise<void>) => {
    if (exporting) return
    setExporting(true)
    try {
      await job()
    } catch (e) {
      getEditor().notify('Export failed: ' + ((e as Error)?.message ?? String(e)))
    } finally {
      setExporting(false)
    }
  }
  const exportLayer = () =>
    busy(async () => {
      if (!node) return
      const url = await exportImage(node.id, imageFormat, Number(scale))
      if (!url) return getEditor().notify(`Could not render ${imageFormat.toUpperCase()} for this layer`)
      const name = imageFileName(node.name, imageFormat, Number(scale))
      const where = await saveImages([{ path: name, url }])
      if (where) getEditor().notify(`Exported ${name} to ${where}`)
    })
  const exportAll = () =>
    busy(async () => {
      const { saved, failed, where } = await exportArtboards(imageFormat, Number(scale))
      const skipped = failed ? ` (${failed} couldn’t be rendered)` : ''
      if (!saved) getEditor().notify('No artboards could be rendered' + skipped)
      else if (where) getEditor().notify(`Exported ${saved} artboard${saved > 1 ? 's' : ''} to ${where}${skipped}`)
      else if (failed) getEditor().notify(`Downloaded ${saved} artboard${saved > 1 ? 's' : ''}${skipped}`)
    })

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
        <footer className="k-code-actions" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
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
        </footer>
      )}

      {(node || artboardCount > 0) && (
        <footer className="k-code-actions" aria-label="Export as image" aria-busy={exporting}>
          <Segmented<ImageFormat> size="sm" value={imageFormat} options={IMAGE_FORMATS} onChange={setImageFormat} />
          {imageFormat === 'svg' ? (
            <span style={{ alignSelf: 'center', fontSize: 11, color: 'var(--k-muted)' }} title="The layer’s HTML inside an SVG <foreignObject>: it shows in browsers, not in most design tools">
              Browser SVG
            </span>
          ) : (
            <div style={{ width: 108, display: 'flex' }}>
              <Segmented size="sm" value={scale} options={SCALES} onChange={setScale} />
            </div>
          )}
          <button type="button" className="k-btn-ghost k-code-secondary" disabled={!node || exporting} onClick={exportLayer} title={node ? `Export “${node.name}” as ${imageFormat.toUpperCase()}` : 'Select a layer to export it'}>
            <Download size={13} />
            {imageFormat.toUpperCase()}
            {imageFormat !== 'svg' && ` @${scale}x`}
          </button>
          <button type="button" className="k-btn-ghost k-code-secondary" disabled={!artboardCount || exporting} onClick={exportAll} title={`Export every artboard on this page as ${imageFormat.toUpperCase()}`}>
            <Images size={13} />
            All artboards
          </button>
        </footer>
      )}
    </div>
  )
}
