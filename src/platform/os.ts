/**
 * Which desktop OS Kiln is running on, for the few things that differ:
 * shortcut labels (⌘ vs Ctrl), the window's title bar, "Show in Finder / Explorer".
 *
 * For checking the other platforms' designs on a Mac, set `localStorage['kiln.os']` to
 * 'windows', 'linux' or 'mac' and reload, or open the app with `?kiln-os=windows`
 * (`?kiln-os=auto` goes back). Only the look changes; the app still runs where it is.
 */

export type Os = 'mac' | 'windows' | 'linux'

function override(): Os | null {
  try {
    if (typeof localStorage === 'undefined') return null
    // `?kiln-os=windows` (or linux / mac) sets it from a link; `?kiln-os=auto` clears it
    const q = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('kiln-os')
    if (q === 'auto') localStorage.removeItem('kiln.os')
    else if (q) localStorage.setItem('kiln.os', q)
    const o = localStorage.getItem('kiln.os')
    return o === 'mac' || o === 'windows' || o === 'linux' ? o : null
  } catch {
    return null // storage blocked
  }
}

function detect(): Os {
  if (typeof navigator === 'undefined') return 'mac'
  const o = override()
  if (o) return o
  const p = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || navigator.userAgent
  if (/Mac|iPhone|iPad|iPod/i.test(p)) return 'mac'
  if (/Win/i.test(p)) return 'windows'
  return 'linux'
}

/** True when `localStorage['kiln.os']` picks the look (design checks), not the real OS. */
export const osOverridden = override() !== null
export const os: Os = detect()
export const isMac = os === 'mac'
export const isWindows = os === 'windows'
export const isLinux = os === 'linux'

/** The system file manager's name, for "Show in …". */
export const fileManagerName = isMac ? 'Finder' : isWindows ? 'File Explorer' : 'Files'
