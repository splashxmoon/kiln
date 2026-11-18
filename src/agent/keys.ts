const KEY_STORAGE = 'kiln.anthropicKey'

export function getApiKey() {
  return localStorage.getItem(KEY_STORAGE) ?? ''
}
export function setApiKey(k: string) {
  if (k) localStorage.setItem(KEY_STORAGE, k.trim())
  else localStorage.removeItem(KEY_STORAGE)
}

/** An image attached to a prompt. Already downscaled for the agent (long side ≤ 1568px). */
export interface ChatImage {
  id: string
  name: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  /** base64, without the data: prefix */
  data: string
  width: number
  height: number
}

export type ChatItem =
  | { role: 'user'; text: string; images?: ChatImage[] }
  /** `demo`: shown in the open chat by the dev demo, never saved */
  | { role: 'assistant'; text: string; demo?: true }
  /**
   * A tool call. Built-in agents push it twice with the same callId: once with
   * `running: true` before the call runs, then again with the result, and the
   * chat replaces the first with the second. CLI steps arrive finished and have neither.
   */
  | { role: 'tool'; name: string; input: unknown; ok: boolean; summary: string; callId?: string; running?: boolean; demo?: true }
  | { role: 'error'; text: string }
