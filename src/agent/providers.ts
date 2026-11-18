/**
 * Agent providers. Kiln never resells model access — every provider runs on
 * the user's own account:
 *  - "subscription" providers launch the vendor's official CLI (Claude Code,
 *    Codex, Gemini CLI, Cursor Agent, OpenCode) which uses its own login, and
 *    point it at Kiln's local MCP server (desktop app only);
 *  - "API key" providers call the vendor API directly with the user's key.
 */
import type Anthropic from '@anthropic-ai/sdk'
import type OpenAI from 'openai'
import { setApiKey, getApiKey, type ChatImage, type ChatItem } from './keys'
import type { SessionSnapshot } from './chats'
import { AGENT_SYSTEM_PROMPT, kilnContext } from './prompt'
import { isTauri } from '../platform/tauri'
import { runAgentCli, cancelAgentCli, onCliOutput, onCliExit } from '../platform/agents'
import { getEditor } from '../editor/store'
import { activityReset } from './tools'

export type CliId = 'claude' | 'codex' | 'gemini' | 'cursor-agent' | 'opencode'

export interface ProviderDef {
  id: string
  kind: 'cli' | 'api'
  label: string
  vendor: string
  /** what pays for it */
  plan: string
  cli?: CliId
  baseURL?: string
  needsKey?: boolean
  modelHint?: string
  defaultModel?: string
  keyUrl?: string
  desktopOnly?: boolean
  /** shown to the user before they pick it */
  caution?: string
}

export const PROVIDERS: ProviderDef[] = [
  { id: 'cli:claude', kind: 'cli', cli: 'claude', label: 'Claude Code', vendor: 'Anthropic', plan: 'Your Claude Pro / Max plan (or Claude Console login)', modelHint: 'sonnet, opus…', desktopOnly: true },
  { id: 'cli:codex', kind: 'cli', cli: 'codex', label: 'Codex', vendor: 'OpenAI', plan: 'Your ChatGPT Plus / Pro / Team plan', desktopOnly: true },
  { id: 'cli:gemini', kind: 'cli', cli: 'gemini', label: 'Gemini CLI', vendor: 'Google', plan: 'Your Google account / Gemini plan', desktopOnly: true, caution: 'Runs with auto-approve (--yolo), so it may also run shell commands in Kiln’s private agent folder.' },
  { id: 'cli:cursor-agent', kind: 'cli', cli: 'cursor-agent', label: 'Cursor Agent', vendor: 'Cursor', plan: 'Your Cursor plan', desktopOnly: true, caution: 'Runs with --force, so it may also run shell commands in Kiln’s private agent folder.' },
  { id: 'cli:opencode', kind: 'cli', cli: 'opencode', label: 'OpenCode', vendor: 'OpenCode', plan: 'Whatever providers you configured in OpenCode', desktopOnly: true },
  { id: 'api:anthropic', kind: 'api', label: 'Anthropic API', vendor: 'Anthropic', plan: 'Your API key, billed by Anthropic', needsKey: true, defaultModel: 'claude-opus-5-5', keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'api:openai', kind: 'api', label: 'OpenAI API', vendor: 'OpenAI', plan: 'Your API key, billed by OpenAI', needsKey: true, baseURL: 'https://api.openai.com/v1', modelHint: 'model id', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'api:openrouter', kind: 'api', label: 'OpenRouter', vendor: 'OpenRouter', plan: 'Your OpenRouter key — any model they host', needsKey: true, baseURL: 'https://openrouter.ai/api/v1', modelHint: 'vendor/model' },
  { id: 'api:ollama', kind: 'api', label: 'Ollama (local)', vendor: 'Local', plan: 'Free — runs on this computer', needsKey: false, baseURL: 'http://localhost:11434/v1', modelHint: 'a tool-capable local model' },
  { id: 'api:custom', kind: 'api', label: 'Custom (OpenAI-compatible)', vendor: 'Any', plan: 'Any OpenAI-compatible endpoint (LM Studio, Groq, vLLM…)', needsKey: false, modelHint: 'model id' },
]

export interface ProviderSettings {
  active: string
  models: Record<string, string>
  /** reasoning / effort level per CLI provider; '' means the CLI's own default */
  efforts?: Record<string, string>
  keys: Record<string, string>
  baseURLs: Record<string, string>
}

export interface Choice {
  value: string
  label: string
  hint?: string
}

/** Reasoning levels each CLI takes. Kiln passes only these to the CLI. */
export const CLI_EFFORTS: Partial<Record<CliId, Choice[]>> = {
  claude: [
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'xhigh', label: 'Extra high' },
    { value: 'max', label: 'Max' },
  ],
  codex: [
    { value: 'minimal', label: 'Minimal' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
  ],
}

const SETTINGS_KEY = 'kiln.agentProviders'

export function loadProviderSettings(): ProviderSettings {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '') as ProviderSettings
    if (s && s.active) return { ...s, models: s.models ?? {}, efforts: s.efforts ?? {}, keys: s.keys ?? {}, baseURLs: s.baseURLs ?? {} }
  } catch {
    /* defaults */
  }
  return { active: isTauri ? 'cli:claude' : 'api:anthropic', models: {}, efforts: {}, keys: {}, baseURLs: {} }
}

export function saveProviderSettings(s: ProviderSettings) {
  // Anthropic key lives with the Anthropic client helper
  if (s.keys['api:anthropic'] !== undefined) setApiKey(s.keys['api:anthropic'])
  const { keys, ...rest } = s
  const otherKeys = Object.fromEntries(Object.entries(keys).filter(([k]) => k !== 'api:anthropic'))
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...rest, keys: otherKeys }))
}

export function providerKey(s: ProviderSettings, id: string) {
  return id === 'api:anthropic' ? getApiKey() : s.keys[id] ?? ''
}

export function providerById(id: string) {
  return PROVIDERS.find((p) => p.id === id)
}

/* ------------------------------------------------------------------ CLI stream parsing */

/** Turn one JSONL line from a CLI's stream output into chat items (best effort per vendor). */
export function parseCliLine(cli: CliId, line: string, state: { sessionId?: string }): ChatItem[] {
  const out: ChatItem[] = []
  let ev: Record<string, unknown>
  try {
    ev = JSON.parse(line)
  } catch {
    if (line.trim() && cli !== 'claude' && cli !== 'cursor-agent' && cli !== 'codex') out.push({ role: 'assistant', text: line })
    return out
  }
  const toolName = (n: unknown) => String(n ?? '').replace(/^mcp__kiln__/, '').replace(/^kiln[._]/, '')
  const type = String(ev.type ?? '')
  if (typeof ev.session_id === 'string') state.sessionId = ev.session_id
  // Claude Code & Cursor Agent stream-json
  if ((type === 'assistant' || type === 'user') && ev.message && typeof ev.message === 'object') {
    const content = (ev.message as { content?: unknown }).content
    if (Array.isArray(content)) {
      for (const b of content as Record<string, unknown>[]) {
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim() && type === 'assistant') out.push({ role: 'assistant', text: b.text })
        if (b.type === 'tool_use') out.push({ role: 'tool', name: toolName(b.name), input: b.input, ok: true, summary: '' })
        // a failed tool call isn't shown: the agent sees the error itself and retries or works around it
      }
    }
    return out
  }
  if (type === 'tool_call' && ev.subtype === 'started') {
    const tc = ev.tool_call as Record<string, unknown> | undefined
    const name = tc ? Object.keys(tc)[0] : 'tool'
    out.push({ role: 'tool', name: toolName(name), input: null, ok: true, summary: '' })
    return out
  }
  if (type === 'result') {
    if (ev.is_error) out.push({ role: 'error', text: String(ev.result ?? 'The agent reported an error.') })
    return out
  }
  // Codex exec --json
  if (type === 'item.completed' && ev.item && typeof ev.item === 'object') {
    const item = ev.item as Record<string, unknown>
    if (item.type === 'agent_message' && typeof item.text === 'string') out.push({ role: 'assistant', text: item.text })
    if (item.type === 'mcp_tool_call') out.push({ role: 'tool', name: toolName(item.tool), input: item.arguments, ok: item.status !== 'failed', summary: '' })
    if (item.type === 'error') out.push({ role: 'error', text: String(item.message ?? 'Codex error') })
    return out
  }
  if (type === 'thread.started' && typeof ev.thread_id === 'string') state.sessionId = ev.thread_id
  if (type === 'error' || type === 'turn.failed') out.push({ role: 'error', text: String((ev.error as { message?: string })?.message ?? ev.message ?? 'Agent error') })
  // Gemini / generic: pick obvious text fields
  if (!out.length && typeof ev.text === 'string' && type !== 'thinking') out.push({ role: 'assistant', text: ev.text })
  if (!out.length && typeof ev.response === 'string') out.push({ role: 'assistant', text: ev.response })
  return out
}

/* ------------------------------------------------------------------ session */

/**
 * Replace image blocks (Anthropic base64 images, OpenAI image_url parts, including
 * screenshots returned by tools) with a text placeholder, so a stored snapshot
 * stays valid without carrying the image bytes.
 */
export function slimImages(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(slimImages)
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    const src = o.source as { type?: unknown } | undefined
    if (o.type === 'image' && src && typeof src === 'object' && src.type === 'base64') return { type: 'text', text: '[image]' }
    if (o.type === 'image_url') return { type: 'text', text: '[image]' }
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, slimImages(x)]))
  }
  return v
}

export class AgentSession {
  anthropicHistory: Anthropic.Beta.BetaMessageParam[] = []
  compatHistory: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = []
  cliState: { sessionId?: string } = {}
  private abort: AbortController | null = null
  private runId: string | null = null
  providerId = ''

  reset() {
    this.anthropicHistory = []
    this.compatHistory = []
    this.cliState = {}
  }

  /** A detached copy of the agent context, safe to store with a chat. */
  snapshot(): SessionSnapshot {
    return JSON.parse(
      JSON.stringify({
        anthropicHistory: slimImages(this.anthropicHistory),
        compatHistory: slimImages(this.compatHistory),
        cliState: this.cliState,
        providerId: this.providerId,
      }),
    )
  }

  /** Pick up a stored chat's agent context, so the next turn continues that conversation. */
  restore(s: SessionSnapshot) {
    const copy = JSON.parse(JSON.stringify(s)) as SessionSnapshot
    this.anthropicHistory = copy.anthropicHistory as Anthropic.Beta.BetaMessageParam[]
    this.compatHistory = copy.compatHistory as OpenAI.Chat.Completions.ChatCompletionMessageParam[]
    this.cliState = copy.cliState
    this.providerId = copy.providerId
  }

  cancel() {
    this.abort?.abort()
    if (this.runId) void cancelAgentCli(this.runId)
  }

  async send(settings: ProviderSettings, text: string, onItem: (i: ChatItem) => void, images: ChatImage[] = []) {
    const p = providerById(settings.active)
    if (!p) throw new Error('Pick an agent provider first.')
    if (p.id !== this.providerId) {
      this.reset()
      this.providerId = p.id
    }
    const model = settings.models[p.id] || p.defaultModel || ''
    const effort = settings.efforts?.[p.id] || ''
    this.abort = new AbortController()
    getEditor().set({ agentTurn: { provider: p.label, startedAt: Date.now(), steps: 0 }, agentBusy: `${p.label} is working…` })
    try {
      if (p.kind === 'api' && p.id === 'api:anthropic') {
        const { runAgentTurn } = await import('./claude')
        await runAgentTurn(this.anthropicHistory, text, onItem, this.abort.signal, images)
      } else if (p.kind === 'api') {
        const { runCompatTurn } = await import('./openaiCompat')
        await runCompatTurn({ baseURL: settings.baseURLs[p.id] || p.baseURL || '', apiKey: providerKey(settings, p.id), model }, this.compatHistory, text, onItem, this.abort.signal, images)
      } else {
        if (!isTauri) throw new Error(`${p.label} runs on your own subscription through its CLI, which needs the Kiln desktop app.`)
        await this.runCli(p.cli!, text, model, effort, onItem, images)
      }
    } finally {
      // the one place a turn ends, whether it finished, failed or was cancelled
      this.abort = null
      activityReset()
    }
  }

  private async runCli(cli: CliId, text: string, model: string, effort: string, onItem: (i: ChatItem) => void, images: ChatImage[] = []) {
    const runId = Math.random().toString(36).slice(2)
    this.runId = runId
    // only Claude Code is resumed; every other CLI starts a fresh process each message, so it needs the system prompt each time
    const resume = cli === 'claude' ? this.cliState.sessionId : undefined
    const isFirst = !resume
    const prompt = (isFirst ? AGENT_SYSTEM_PROMPT + '\n\n---\n\n' : '') + text + kilnContext()
    const stderr: string[] = []
    let gotOutput = false
    await new Promise<void>((resolve, reject) => {
      const unsubs: Promise<() => void>[] = []
      const done = (err?: Error) => {
        unsubs.forEach((u) => u.then((f) => f()))
        this.runId = null
        if (err) reject(err)
        else resolve()
      }
      unsubs.push(
        onCliOutput((o) => {
          if (o.runId !== runId) return
          if (o.stream === 'stderr') {
            if (o.line.trim()) stderr.push(o.line)
            return
          }
          const items = parseCliLine(cli, o.line, this.cliState)
          if (items.length) gotOutput = true
          items.forEach(onItem)
        }),
      )
      unsubs.push(
        onCliExit((x) => {
          if (x.runId !== runId) return
          if (x.error) done(new Error(x.error))
          else if (x.code && x.code !== 0 && !gotOutput) done(new Error(stderr.slice(-4).join('\n') || `${cli} exited with code ${x.code}`))
          else done()
        }),
      )
      Promise.all(unsubs)
        .then(() =>
          runAgentCli({
            runId,
            cli,
            prompt,
            model: model || undefined,
            // only a level this CLI knows; anything else would be refused by the desktop side
            effort: effort && CLI_EFFORTS[cli]?.some((e) => e.value === effort) ? effort : undefined,
            resume,
            images: images.length ? images.map(({ name, mediaType, data }) => ({ name, mediaType, data })) : undefined,
          }),
        )
        .catch((e) => done(e instanceof Error ? e : new Error(String(e))))
    })
  }
}
