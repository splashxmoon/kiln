/**
 * Shortcut labels for the platform. Write every label the Mac way ("⌘⇧K", "⌥⌘G", "⌘↵");
 * `shortcut()` turns it into "Ctrl+Shift+K", "Ctrl+Alt+G", "Ctrl+Enter" on Windows and Linux.
 * Key handling itself already accepts Ctrl or ⌘ (see `isMod`).
 */
import { isMac } from './os'

const NAMES: Record<string, string> = {
  '⌘': 'Ctrl',
  '⌃': 'Ctrl',
  '⌥': 'Alt',
  '⇧': 'Shift',
  '↵': 'Enter',
  '⌫': 'Backspace',
  '⌦': 'Delete',
  '⎋': 'Esc',
  '⇥': 'Tab',
}
/** Windows/Linux order: Ctrl, Alt, Shift, then the key. */
const ORDER = ['Ctrl', 'Alt', 'Shift']

/** "⌘⇧K" → "Ctrl+Shift+K" off the Mac; unchanged on the Mac. Plain labels ("V", "Space") pass through. */
export function shortcut(label: string): string {
  if (isMac || !/[⌘⌃⌥⇧↵⌫⌦⎋⇥]/.test(label)) return label
  const mods: string[] = []
  let key = ''
  for (const ch of label) {
    const n = NAMES[ch]
    if (n && ORDER.includes(n)) {
      if (!mods.includes(n)) mods.push(n)
    } else key += n ?? ch
  }
  mods.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))
  return [...mods, key.trim()].filter(Boolean).join('+')
}

/** The main modifier's name: "⌘" on the Mac, "Ctrl" elsewhere. */
export const modKey = isMac ? '⌘' : 'Ctrl'

/** The platform's main modifier is held (⌘ on the Mac, Ctrl elsewhere). */
export const isMod = (e: { metaKey: boolean; ctrlKey: boolean }) => (isMac ? e.metaKey : e.ctrlKey)
