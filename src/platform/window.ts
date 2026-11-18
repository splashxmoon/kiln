/**
 * Start-up window fit for Windows and Linux. The window opens at 1440×900, which is taller
 * than many Windows laptops (1366×768, or 1920×1080 at 150% scaling, minus the taskbar).
 * When it doesn't fit the screen's work area, open it maximised instead of half off-screen.
 * The Mac keeps its own behaviour.
 */
import { isTauri } from './tauri'
import { isMac, isWindows, osOverridden } from './os'

/** Whether this window draws its own caption buttons (the frameless Windows window). */
export const drawsWindowControls = isWindows && (isTauri || osOverridden)

export async function fitWindowToScreen(): Promise<void> {
  if (!isTauri || isMac || osOverridden) return
  try {
    const { getCurrentWindow, currentMonitor } = await import('@tauri-apps/api/window')
    const w = getCurrentWindow()
    const [mon, size] = await Promise.all([currentMonitor(), w.outerSize()])
    const area = mon?.workArea?.size ?? mon?.size
    if (area && (size.width > area.width || size.height > area.height)) await w.maximize()
  } catch (e) {
    console.warn('Kiln: could not fit the window to the screen', e)
  }
}
