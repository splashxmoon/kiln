import { useEffect, useState } from 'react'
import { AgentSession } from '../../agent/providers'
import type { ChatItem } from '../../agent/keys'

/**
 * The in-app agent session, shared by the Agent panel (which sends) and the
 * top-bar status island (which can stop it).
 */
export const agentSession = new AgentSession()

/** True while the Agent panel's own turn runs (not for outside MCP clients, which can't be stopped from here). */
export const agentRun = { active: false }

/**
 * Adds an item to the open chat (set by the Agent panel while it is mounted). A tool item
 * with the `callId` of an earlier one replaces it, so a step can go running -> done.
 * Used by the dev demo (src/agent/demo.ts).
 */
export const agentChat: { push: ((i: ChatItem) => void) | null } = { push: null }

/** The current time, ticking once a second while `active`. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const tick = () => setNow(Date.now())
    const first = window.setTimeout(tick, 0)
    const id = window.setInterval(tick, 1000)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(id)
    }
  }, [active])
  return now
}
