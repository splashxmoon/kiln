import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Palette, Code2, Bot } from 'lucide-react'
import { useEditor, getEditor } from './store'
import { Canvas, zoomToFit } from './Canvas'
import { LeftPanel, LeftPanelCollapsed } from './panels/LayersPanel'
import { Inspector } from './panels/Inspector'
import { CodePanel } from './panels/CodePanel'
import { AgentPanel } from './panels/AgentPanel'
import { Toolbar } from './panels/Toolbar'
import { TopBar } from './panels/TopBar'
import { CommandPalette, ContextMenu, ShortcutsSheet, Toast } from './panels/Menus'
import { PreviewSheet } from './panels/Preview'
import { handleKeyDown, handleKeyUp, handlePaste, copySelection, isTypingTarget } from './commands'
import { storage } from '../platform/storage'
import { isTauri, startAgentBridge, onAgentActivity } from '../platform/tauri'
import { AGENT_TOOLS, runTool, installWindowApi, activityStart, activityEnd, activityReset } from '../agent/tools'
import { toolLabel } from '../agent/humanize'
import '../agent/demo'
import { snapshotNode } from './snapshot'
import { sampleCanvasColor } from './eyedropper'
import { registerEyedropper } from '../ui/eyedropper'
import { ensureFont } from './fonts'
import type { KDoc } from './types'
import './editor.css'

/** Save now (with a fresh thumbnail) — used before leaving the editor. */
export async function flushSave() {
  const s = getEditor()
  if (!s.doc.pages.length) return
  const first = s.doc.pages[0]?.children[0]
  const thumbnail = (first && (await snapshotNode(first, { maxSize: 480 }).catch(() => null))) || s.doc.thumbnail
  const doc: KDoc = { ...getEditor().doc, thumbnail }
  try {
    await storage.save(doc)
    if (getEditor().doc.updatedAt === doc.updatedAt) getEditor().set({ doc, saveState: 'saved' })
  } catch (e) {
    getEditor().notify('Save failed: ' + (e as Error).message)
  }
}

function useAutosave() {
  const doc = useEditor((s) => s.doc)
  const saveState = useEditor((s) => s.saveState)
  const timer = useRef<number | undefined>(undefined)
  const lastThumb = useRef(0)
  useEffect(() => {
    if (saveState !== 'unsaved') return
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(async () => {
      const s = getEditor()
      s.set({ saveState: 'saving' })
      let thumbnail = s.doc.thumbnail
      if (Date.now() - lastThumb.current > 8000) {
        lastThumb.current = Date.now()
        const first = s.doc.pages[0]?.children[0]
        if (first) thumbnail = (await snapshotNode(first, { maxSize: 480 }).catch(() => null)) ?? thumbnail
      }
      const toSave: KDoc = { ...getEditor().doc, thumbnail }
      try {
        await storage.save(toSave)
        if (getEditor().doc.updatedAt === toSave.updatedAt) getEditor().set({ saveState: 'saved' })
        else getEditor().set({ saveState: 'unsaved' })
      } catch (e) {
        getEditor().set({ saveState: 'unsaved' })
        getEditor().notify('Save failed: ' + (e as Error).message)
      }
    }, 700)
  }, [doc, saveState])
  useEffect(() => () => window.clearTimeout(timer.current), [])
  // flush on unload
  useEffect(() => {
    const f = (e: BeforeUnloadEvent) => {
      if (getEditor().saveState !== 'saved') {
        void storage.save(getEditor().doc)
        e.preventDefault()
      }
    }
    window.addEventListener('beforeunload', f)
    return () => {
      window.removeEventListener('beforeunload', f)
      // backstop: leaving the editor by any route never drops pending edits
      if (getEditor().saveState !== 'saved') void storage.save(getEditor().doc)
    }
  }, [])
}

function useAgentBridge() {
  useEffect(() => {
    const uninstall = installWindowApi()
    if (!isTauri) return uninstall
    let stop: (() => void) | undefined
    let stopActivity: (() => void) | undefined
    startAgentBridge(AGENT_TOOLS, (name, args) => runTool(name, args))
      .then((f) => (stop = f))
      .catch((e) => console.warn('MCP bridge failed', e))
    // Tool calls from MCP clients: the in-app CLI runs and the user's own terminal agents.
    // runTool (called right after 'start') fills in the nodes, the step count and the trail.
    // A terminal agent has no turn of its own, so one is opened here and closed once it goes quiet.
    let idle: number | undefined
    let bridgeTurnAt: number | null = null
    onAgentActivity((a) => {
      const s = getEditor()
      window.clearTimeout(idle)
      if (a.phase === 'start') {
        if (!s.agentTurn) {
          bridgeTurnAt = Date.now()
          s.set({ agentTurn: { provider: 'Agent', startedAt: bridgeTurnAt, steps: 0 }, agentBusy: 'Agent is working…' })
        }
        activityStart(a.name, toolLabel(a.name).verb, [], false)
      } else {
        activityEnd()
        idle = window.setTimeout(() => {
          // close only the turn opened here, never an in-app run's
          if (bridgeTurnAt !== null && getEditor().agentTurn?.startedAt === bridgeTurnAt) activityReset()
          bridgeTurnAt = null
        }, BRIDGE_IDLE_MS)
      }
    }).then((f) => (stopActivity = f))
    return () => {
      uninstall()
      stop?.()
      stopActivity?.()
      window.clearTimeout(idle)
    }
  }, [])
}

/** How long a terminal agent can be quiet before its turn counts as over. */
const BRIDGE_IDLE_MS = 4000

const RIGHT_MIN = 340
const RIGHT_MAX = 640
const RIGHT_DEFAULT = 380

export function Editor({ fileId, onBack }: { fileId: string; onBack: () => void }) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing'>('loading')
  const rightTab = useEditor((s) => s.rightTab)
  const loadedId = useEditor((s) => s.doc.id)

  useEffect(() => {
    let alive = true
    if (getEditor().doc.id === fileId && getEditor().pageId) {
      setStatus('ready')
      return
    }
    storage.load(fileId).then((doc) => {
      if (!alive) return
      if (!doc) return setStatus('missing')
      for (const n of Object.values(doc.nodes)) if (n.text) ensureFont(n.text.fontFamily)
      getEditor().loadDoc(doc)
      setStatus('ready')
      requestAnimationFrame(() => requestAnimationFrame(() => zoomToFit()))
    })
    return () => {
      alive = false
    }
  }, [fileId])

  useAutosave()
  useAgentBridge()
  useEffect(() => {
    registerEyedropper(sampleCanvasColor)
    return () => registerEyedropper(null)
  }, [])

  useEffect(() => {
    const kd = (e: KeyboardEvent) => handleKeyDown(e)
    const ku = (e: KeyboardEvent) => handleKeyUp(e)
    const paste = (e: ClipboardEvent) => {
      if (isTypingTarget(e.target)) return
      void handlePaste(e)
    }
    const copy = (e: ClipboardEvent) => {
      if (isTypingTarget(e.target) || !getEditor().selection.length) return
      e.preventDefault()
      void copySelection()
    }
    const blur = () => getEditor().set({ spaceDown: false })
    window.addEventListener('keydown', kd)
    window.addEventListener('keyup', ku)
    window.addEventListener('paste', paste)
    window.addEventListener('copy', copy)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', kd)
      window.removeEventListener('keyup', ku)
      window.removeEventListener('paste', paste)
      window.removeEventListener('copy', copy)
      window.removeEventListener('blur', blur)
    }
  }, [])

  // right panel width: drag its left edge; remembered between sessions, double-click resets
  const [rightW, setRightW] = useState(() => {
    const v = Number(localStorage.getItem('kiln.rightPanelWidth'))
    return v >= RIGHT_MIN && v <= RIGHT_MAX ? v : RIGHT_DEFAULT
  })
  useEffect(() => localStorage.setItem('kiln.rightPanelWidth', String(rightW)), [rightW])
  const startResize = (e: ReactPointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    const startX = e.clientX
    const startW = rightW
    const move = (ev: PointerEvent) => setRightW(Math.min(RIGHT_MAX, Math.max(RIGHT_MIN, startW - (ev.clientX - startX))))
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove('k-resizing')
    }
    document.body.classList.add('k-resizing')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  if (status === 'missing')
    return (
      <div className="k-app k-center">
        <p>That file doesn’t exist anymore.</p>
        <button className="k-btn-primary" onClick={onBack}>
          Back to files
        </button>
      </div>
    )

  return (
    <div className="k-app">
      <TopBar
        onBack={async () => {
          await flushSave()
          onBack()
        }}
      />
      <div className="k-main">
        <LeftPanel />
        <div className="k-stage">
          {status === 'ready' && loadedId === fileId ? <Canvas /> : <div className="k-loading">Opening…</div>}
          <LeftPanelCollapsed />
          <Toolbar />
        </div>
        <aside className="k-right" style={{ width: rightW }}>
          <div
            className="k-right-grip"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize panel"
            aria-valuemin={RIGHT_MIN}
            aria-valuemax={RIGHT_MAX}
            aria-valuenow={rightW}
            title="Drag to resize · double-click to reset"
            onPointerDown={startResize}
            onDoubleClick={() => setRightW(RIGHT_DEFAULT)}
          />
          <div className="k-tabs k-right-tabs">
            {(
              [
                ['design', 'Design', Palette],
                ['code', 'Code', Code2],
                ['agent', 'Agent', Bot],
              ] as const
            ).map(([id, label, Icon]) => (
              <button key={id} className={rightTab === id ? 'is-on' : ''} onClick={() => getEditor().set({ rightTab: id })}>
                <Icon size={13} /> {label}
              </button>
            ))}
          </div>
          <div className="k-right-body">
            {rightTab === 'design' && <Inspector />}
            {rightTab === 'code' && <CodePanel />}
            {rightTab === 'agent' && <AgentPanel key={loadedId} />}
          </div>
        </aside>
      </div>
      <CommandPalette />
      <ContextMenu />
      <ShortcutsSheet />
      <PreviewSheet />
      <Toast />
    </div>
  )
}
