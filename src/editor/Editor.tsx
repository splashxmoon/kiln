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
import { snapshotNode } from './snapshot'
import { sampleCanvasColor } from './eyedropper'
import { registerEyedropper } from '../ui/eyedropper'
import { ensureFont } from './fonts'
import type { KDoc } from './types'
import { isNewerThanApp, UnreadableFileError } from './migrate'
import './editor.css'

// the dev demo ("Agent: play demo activity") only loads where it can be used
if (import.meta.env.DEV || localStorage.getItem('kiln.debug') === '1') void import('../agent/demo')

/**
 * The newest file-card thumbnail. Autosave sends this instead of making one per save: a
 * snapshot clones the artboard's DOM and encodes a PNG on the main thread, so it is made
 * only while the browser is idle (see `refreshThumbnail`) and once more when leaving.
 */
const thumb = { docId: '', url: undefined as string | undefined, at: 0 }
/** How old the thumbnail may get while editing before an idle refresh. */
const THUMB_EVERY_MS = 20_000

const firstBoard = () => getEditor().doc.pages[0]?.children[0]

/** The thumbnail for the open doc: the latest snapshot, else the one the file was saved with. */
function currentThumbnail() {
  const d = getEditor().doc
  return thumb.docId === d.id && thumb.url ? thumb.url : d.thumbnail
}

/**
 * When the thumbnail is stale, snapshot the first artboard during idle time. If the file is
 * still saved when the snapshot is ready, write it straight away (same `updatedAt`, so it never
 * counts as a newer edit): closing the tab or app right after editing then still leaves the file
 * card current. If there are new edits, their save carries it instead.
 */
function refreshThumbnail() {
  const docId = getEditor().doc.id
  // a newly opened file starts its own clock, so it gets its first snapshot straight away
  if (thumb.docId !== docId) Object.assign(thumb, { docId, url: undefined, at: 0 })
  if (Date.now() - thumb.at < THUMB_EVERY_MS) return
  thumb.at = Date.now()
  const run = () => {
    const first = firstBoard()
    if (!first || getEditor().doc.id !== docId) return
    void snapshotNode(first, { maxSize: 480 })
      .then((url) => {
        const s = getEditor()
        if (!url || s.doc.id !== docId) return
        Object.assign(thumb, { docId, url })
        if (s.saveState === 'saved') void storage.save({ ...s.doc, thumbnail: url }).catch(() => {})
      })
      .catch(() => {})
  }
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run, { timeout: 5000 })
  else window.setTimeout(run, 1500) // WebKit (the macOS desktop app) has no requestIdleCallback
}

/** Save now (with a fresh thumbnail) — used before leaving the editor. */
export async function flushSave() {
  const s = getEditor()
  // a file from a newer Kiln is read-only here (storage would refuse it)
  if (!s.doc.pages.length || isNewerThanApp(s.doc)) return
  const first = firstBoard()
  const thumbnail = (first && (await snapshotNode(first, { maxSize: 480 }).catch(() => null))) || currentThumbnail()
  const doc: KDoc = { ...getEditor().doc, thumbnail }
  // this is now the newest snapshot: a later autosave must not send back an older idle one
  if (thumbnail) Object.assign(thumb, { docId: doc.id, url: thumbnail, at: Date.now() })
  try {
    await storage.save(doc)
    if (getEditor().doc.updatedAt === doc.updatedAt) getEditor().set({ doc, saveState: 'saved' })
  } catch (e) {
    getEditor().notify('Save failed: ' + (e as Error).message)
  }
}

/**
 * Saves 700 ms after the last edit. It watches the store directly rather than through a hook:
 * subscribing the editor to `doc` would re-render the whole editor (top bar, panels, canvas)
 * on every edit, every keystroke in a text layer and every step of an inspector scrub.
 */
function useAutosave() {
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => {
    const schedule = () => {
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(async () => {
        getEditor().set({ saveState: 'saving' })
        // the save never waits on a snapshot; the thumbnail rides along from the last idle refresh
        const toSave: KDoc = { ...getEditor().doc, thumbnail: currentThumbnail() }
        try {
          await storage.save(toSave)
          if (getEditor().doc.updatedAt === toSave.updatedAt) getEditor().set({ saveState: 'saved' })
          else getEditor().set({ saveState: 'unsaved' })
          refreshThumbnail()
        } catch (e) {
          getEditor().set({ saveState: 'unsaved' })
          getEditor().notify('Save failed: ' + (e as Error).message)
        }
      }, 700)
    }
    if (getEditor().saveState === 'unsaved' && !isNewerThanApp(getEditor().doc)) schedule()
    // same trigger as before: a new doc or a save state change, while there are unsaved edits;
    // never for a file from a newer Kiln, which is read-only here
    const unsubscribe = useEditor.subscribe((s, prev) => {
      if (s.saveState === 'unsaved' && (s.doc !== prev.doc || s.saveState !== prev.saveState) && !isNewerThanApp(s.doc)) schedule()
    })
    return () => {
      unsubscribe()
      window.clearTimeout(timer.current)
    }
  }, [])
  // flush on unload
  useEffect(() => {
    const f = (e: BeforeUnloadEvent) => {
      if (getEditor().saveState !== 'saved') {
        void storage.save({ ...getEditor().doc, thumbnail: currentThumbnail() }).catch(() => {})
        e.preventDefault()
      }
    }
    window.addEventListener('beforeunload', f)
    return () => {
      window.removeEventListener('beforeunload', f)
      // backstop: leaving the editor by any route never drops pending edits
      if (getEditor().saveState !== 'saved') void storage.save({ ...getEditor().doc, thumbnail: currentThumbnail() }).catch(() => {})
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
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'unreadable'>('loading')
  const rightTab = useEditor((s) => s.rightTab)
  const loadedId = useEditor((s) => s.doc.id)

  useEffect(() => {
    let alive = true
    if (getEditor().doc.id === fileId && getEditor().pageId) {
      setStatus('ready')
      return
    }
    storage
      .load(fileId)
      .then((doc) => {
        if (!alive) return
        if (!doc) return setStatus('missing')
        for (const n of Object.values(doc.nodes)) if (n.text) ensureFont(n.text.fontFamily)
        getEditor().loadDoc(doc)
        setStatus('ready')
        if (isNewerThanApp(doc)) getEditor().notify('This file was saved by a newer Kiln, so changes here won’t be saved. Update Kiln to edit it.')
        requestAnimationFrame(() => requestAnimationFrame(() => zoomToFit()))
      })
      .catch((e) => {
        if (!alive) return
        console.error('Kiln: could not open the file', e)
        // the file is there but can't be read: say so, rather than that it is gone
        setStatus(e instanceof UnreadableFileError ? 'unreadable' : 'missing')
        if (!(e instanceof UnreadableFileError)) getEditor().notify((e as Error).message || 'Could not open the file')
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

  if (status === 'missing' || status === 'unreadable')
    return (
      <div className="k-app k-center">
        <p>{status === 'missing' ? 'That file doesn’t exist anymore.' : 'Kiln can’t read this file. It may be damaged or not a Kiln file.'}</p>
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
