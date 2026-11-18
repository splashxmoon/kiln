import { isTauri, desktopReadClipboard } from './tauri'

/** Read plain text from the clipboard without any native UI. */
export async function readClipboardText(): Promise<string | null> {
  try {
    if (isTauri) return await desktopReadClipboard()
    return (await navigator.clipboard?.readText()) ?? null
  } catch {
    return null
  }
}
