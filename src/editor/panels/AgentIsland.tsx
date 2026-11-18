import { useEffect, useState } from 'react'
import { Check, Square } from 'lucide-react'
import { useEditor } from '../store'
import { PROVIDERS } from '../../agent/providers'
import { formatElapsed, toolLabel } from '../../agent/humanize'
import { ProviderIcon } from './ProviderIcon'
import { agentRun, agentSession, useNow } from './agentSession'
import './agent-chat.css'

type Done = { provider: string; steps: number; ms: number }

/**
 * The agent's status in the top bar, for the whole turn: its mark inside a turning
 * ring, what it is doing now (cross-fading as that changes), steps and time, and Stop.
 * When the turn ends it says "Done" for a moment, then goes.
 */
export function AgentIsland() {
  const turn = useEditor((s) => s.agentTurn)
  const action = useEditor((s) => s.agentAction)
  const busy = useEditor((s) => s.agentBusy)
  const on = !!(turn || busy)
  const now = useNow(on)

  // remember the turn as it ends, to show a short "Done" state
  const [prev, setPrev] = useState(turn)
  const [done, setDone] = useState<Done | null>(null)
  if (turn !== prev) {
    setPrev(turn)
    if (prev && !turn) setDone({ provider: prev.provider, steps: prev.steps, ms: Math.max(0, now - prev.startedAt) })
    else if (turn && done) setDone(null)
  }
  useEffect(() => {
    if (!done) return
    const t = window.setTimeout(() => setDone(null), 2200)
    return () => window.clearTimeout(t)
  }, [done])

  if (!on && !done) return null

  const providerName = (on ? turn?.provider : done?.provider) ?? 'Agent'
  const provider = PROVIDERS.find((p) => p.label === providerName)
  const steps = on ? (turn?.steps ?? 0) : (done?.steps ?? 0)
  const elapsed = on ? (turn ? formatElapsed(now - turn.startedAt) : '') : formatElapsed(done?.ms ?? 0)
  const label = !on ? 'Done' : action?.label ?? (busy && !turn ? toolLabel(busy).verb : 'Thinking')
  const meta = [steps ? `${steps} step${steps === 1 ? '' : 's'}` : '', elapsed].filter(Boolean).join(' · ')

  return (
    <div className={'k-island' + (on ? ' is-live' : ' is-done')} role="status" aria-live="polite" aria-label={`${providerName}: ${label}`}>
      <span className="k-island-mark" aria-hidden="true">
        {on ? <ProviderIcon id={provider?.id} size={12} /> : <Check size={12} strokeWidth={2.75} />}
        {on && <i className="k-island-ring" />}
      </span>
      <span className="k-island-who">{providerName}</span>
      <span className="k-island-text">
        <span key={label} className="k-island-label">
          {label}
        </span>
      </span>
      {meta && <span className="k-island-meta">{meta}</span>}
      {on && agentRun.active && (
        <button type="button" className="k-island-stop" onClick={() => agentSession.cancel()} title="Stop the agent" aria-label="Stop the agent">
          <Square size={8} fill="currentColor" strokeWidth={0} />
        </button>
      )}
    </div>
  )
}
