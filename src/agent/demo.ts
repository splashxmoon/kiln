/**
 * Dev aid: plays a scripted agent turn over the open page's real layers, so the
 * canvas presence, the top-bar status and the chat steps can be checked without
 * a model. It only drives the live-activity state (agentTurn, agentAction,
 * agentFocus, agentTrail) and the chat; it never changes the document, so there
 * is nothing to save or undo.
 *
 * Run it with `kiln.demo()` in the console, or "Agent: play demo activity" in the
 * command palette (shown in dev builds, or with localStorage['kiln.debug'] = '1').
 */
import { getEditor } from '../editor/store'
import { COMMANDS } from '../editor/commands'
import { agentChat } from '../editor/panels/agentSession'
import { toolLabel, toolNodeIds } from './humanize'
import { activityStart, activityEnd, activityReset, markTrail, ACTION_LINGER } from './tools'

/** time from one step's start to the next */
const STEP_MS = 1200
/** how long each step "runs" before it finishes */
const RUN_MS = 800

type Args = Record<string, unknown>
interface Step {
  tool: string
  args: Args
  /** nodes to show when the args don't name them (e.g. a search's hits) */
  ids?: string[]
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms))

/** The open page's layers, top-level boards first, then everything under them in order. */
function pageLayers() {
  const s = getEditor()
  const page = s.doc.pages.find((p) => p.id === s.pageId)
  const boards = page?.children.filter((id) => s.doc.nodes[id]) ?? []
  const all: string[] = []
  const walk = (ids: string[]) => {
    for (const id of ids) {
      const n = s.doc.nodes[id]
      if (!n) continue
      all.push(id)
      walk(n.children)
    }
  }
  walk(boards)
  const nested = all.filter((id) => !boards.includes(id))
  const texts = nested.filter((id) => s.doc.nodes[id].type === 'text')
  const shapes = nested.filter((id) => s.doc.nodes[id].type !== 'text')
  const frames = shapes.filter((id) => s.doc.nodes[id].type === 'frame')
  return { boards, texts, shapes, frames }
}

function script(): Step[] {
  const { boards, texts, shapes, frames } = pageLayers()
  const board = boards[0]
  const some = (ids: string[], n: number) => ids.slice(0, n)
  const styled = some(shapes.length ? shapes : boards, 3)
  const copy = texts[0]
  return [
    { tool: 'get_document', args: {} },
    { tool: 'get_tree', args: board ? { nodeId: board } : {} },
    { tool: 'get_screenshot', args: board ? { nodeId: board } : {} },
    { tool: 'find_nodes', args: { query: 'button' }, ids: some(shapes, 2) },
    { tool: 'update_nodes', args: { nodeIds: styled, props: { fill: '#1F2A24', radius: 12 } } },
    { tool: 'set_text', args: copy ? { texts: { [copy]: 'Design that ships itself' } } : { texts: {} } },
    { tool: 'update_nodes', args: { nodeIds: some(frames.length ? frames : boards, 1), props: { layout: { mode: 'flex', gap: 16 } } } },
    { tool: 'apply_token', args: { tokenId: 'demo', nodeIds: some(texts.length ? texts.slice(1) : styled, 2) } },
    { tool: 'write_html', args: board ? { html: '<section></section>', parentId: board } : { html: '<section></section>' } },
    { tool: 'get_screenshot', args: board ? { nodeId: board } : {} },
  ]
}

let playing = false

/** Plays the scripted turn: about 10 steps, STEP_MS apart. Resolves when it has finished. */
export async function playAgentDemo(): Promise<void> {
  const s = getEditor()
  if (playing || s.agentTurn) {
    s.notify('The agent is already working')
    return
  }
  playing = true
  const startedAt = Date.now()
  const run = startedAt.toString(36)
  s.set({ agentTurn: { provider: 'Demo agent', startedAt, steps: 0 }, agentBusy: 'Demo agent is working…' })
  // a real turn starting (or ours being cleared) ends the demo early, leaving that turn alone
  const ours = () => getEditor().agentTurn?.startedAt === startedAt
  try {
    const steps = script()
    for (let i = 0; i < steps.length && ours(); i++) {
      const { tool, args, ids } = steps[i]
      const label = toolLabel(tool, args)
      const callId = `demo-${run}-${i}`
      const touched = ids ?? toolNodeIds(tool, args)
      activityStart(tool, label.verb, touched)
      agentChat.push?.({ role: 'tool', name: tool, input: args, ok: true, summary: '', callId, running: true, demo: true })
      await sleep(RUN_MS)
      if (!ours()) break
      if (label.kind === 'edit') markTrail(touched)
      agentChat.push?.({ role: 'tool', name: tool, input: args, ok: true, summary: `(demo) ${label.done}`, callId, demo: true })
      activityEnd()
      await sleep(STEP_MS - RUN_MS)
    }
    if (ours()) {
      agentChat.push?.({ role: 'assistant', text: 'That was a demo turn. Nothing on the canvas changed, and these steps aren’t saved.', demo: true })
      // let the last action linger as it would after a real tool, then end the turn
      await sleep(ACTION_LINGER)
    }
  } finally {
    if (ours()) activityReset()
    playing = false
  }
}

// palette entry, for dev builds and for anyone who turns debugging on (once, even across hot reloads)
if ((import.meta.env.DEV || localStorage.getItem('kiln.debug') === '1') && !COMMANDS.some((c) => c.id === 'agent.demo')) {
  COMMANDS.push({ id: 'agent.demo', label: 'Agent: play demo activity', group: 'Agent', run: () => void playAgentDemo(), enabled: () => !getEditor().agentTurn })
}
