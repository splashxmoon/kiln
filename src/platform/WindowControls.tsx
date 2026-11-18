/**
 * Minimise / maximise / close for the frameless Windows window, drawn at the right end of
 * each header bar (top bar, files home, preview). The Mac keeps its traffic lights and
 * Linux keeps its window manager's title bar, so this renders nothing there.
 *
 * In the web build it shows only with `localStorage['kiln.os']='windows'`, to check the design.
 */
import { useEffect, useState } from 'react'
import { isTauri } from './tauri'
import { drawsWindowControls } from './window'
import './window-controls.css'

type Win = Awaited<ReturnType<typeof getWin>>
const getWin = () => import('@tauri-apps/api/window').then((m) => m.getCurrentWindow())
const act = (fn: (w: Win) => Promise<unknown>) => {
  if (isTauri) void getWin().then(fn)
}

export function WindowControls() {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (!drawsWindowControls || !isTauri) return
    let stop: (() => void) | undefined
    let live = true
    void getWin().then(async (w) => {
      const sync = () => void w.isMaximized().then((m) => live && setMaximized(m))
      sync()
      const un = await w.onResized(sync)
      if (live) stop = un
      else un()
    })
    return () => {
      live = false
      stop?.()
    }
  }, [])

  if (!drawsWindowControls) return null
  return (
    <div className="k-winctl" role="group" aria-label="Window" data-no-drag onDoubleClick={(e) => e.stopPropagation()}>
      <button type="button" aria-label="Minimise" title="Minimise" onClick={() => act((w) => w.minimize())}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M0 5.5h10" />
        </svg>
      </button>
      <button type="button" aria-label={maximized ? 'Restore' : 'Maximise'} title={maximized ? 'Restore down' : 'Maximise'} onClick={() => act((w) => w.toggleMaximize())}>
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <path d="M2.5 2.5V1.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1" />
            <rect x="0.5" y="2.5" width="7" height="7" rx="1" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <rect x="0.5" y="0.5" width="9" height="9" rx="1" />
          </svg>
        )}
      </button>
      <button type="button" className="is-close" aria-label="Close" title="Close" onClick={() => act((w) => w.close())}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />
        </svg>
      </button>
    </div>
  )
}
