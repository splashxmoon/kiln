/**
 * Built-in agent: Claude with the user's own API key, driving the canvas
 * through the same tool API that external MCP clients use.
 *
 * The key is stored only in this browser/app (localStorage) and sent only to
 * api.anthropic.com.
 */
import Anthropic from '@anthropic-ai/sdk'
import { AGENT_TOOLS, runTool } from './tools'
import { AGENT_SYSTEM_PROMPT as SYSTEM, kilnContext } from './prompt'
import { getApiKey, type ChatImage } from './keys'
import { attachedNote } from './chats'

export const MODEL = 'claude-opus-5-5'
export type { ChatItem } from './keys'
import type { ChatItem } from './keys'

type Block = Anthropic.Beta.BetaContentBlockParam

type ToolResultContent = Anthropic.Beta.BetaToolResultBlockParam['content']

/**
 * Run one user turn: loops tool calls until Claude ends its turn.
 * `history` is the API-format transcript kept by the caller across turns.
 */
export async function runAgentTurn(
  history: Anthropic.Beta.BetaMessageParam[],
  userText: string,
  onItem: (item: ChatItem) => void,
  signal?: AbortSignal,
  images: ChatImage[] = [],
): Promise<void> {
  const apiKey = getApiKey()
  if (!apiKey) throw new Error('Add your Anthropic API key in the agent settings first.')
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true })

  const text = userText + kilnContext()
  // text-only turns keep the plain string; with images, the images come first, then the text
  history.push({
    role: 'user',
    content: images.length
      ? [
          ...images.map((img) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: img.mediaType, data: img.data } })),
          { type: 'text' as const, text: text + attachedNote(images) },
        ]
      : text,
  })

  const tools: Anthropic.Beta.BetaTool[] = AGENT_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
  }))

  for (let step = 0; step < 24; step++) {
    if (signal?.aborted) return
    const response = await client.beta.messages.create(
      {
        model: MODEL,
        max_tokens: 16000,
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        tools,
        messages: history,
        output_config: { effort: 'medium' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      },
      { signal },
    )

    // keep the full content (thinking blocks included) for the next request
    history.push({ role: 'assistant', content: response.content as Block[] })

    if (response.stop_reason === 'refusal') {
      onItem({ role: 'error', text: 'Claude declined this request.' })
      return
    }
    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) onItem({ role: 'assistant', text: block.text })
    }
    const calls = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
    if (response.stop_reason !== 'tool_use' || !calls.length) {
      if (response.stop_reason === 'max_tokens') onItem({ role: 'error', text: 'Response was cut off (max tokens).' })
      return
    }

    // run tools sequentially (they mutate shared canvas state), return all results in one message
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = []
    for (const call of calls) {
      // show the step as running before it runs; the result below replaces it (same callId)
      onItem({ role: 'tool', name: call.name, input: call.input, ok: true, summary: '', callId: call.id, running: true })
      let ok = true
      let content: ToolResultContent
      try {
        const out = await runTool(call.name, (call.input ?? {}) as Record<string, unknown>)
        content = out.map((c) =>
          c.type === 'image'
            ? { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: c.data } }
            : { type: 'text' as const, text: c.text },
        )
      } catch (e) {
        ok = false
        content = [{ type: 'text', text: (e as Error).message }]
      }
      const first = Array.isArray(content) ? content[0] : undefined
      const summary = first && first.type === 'text' ? first.text.slice(0, 140) : first?.type === 'image' ? 'screenshot' : ''
      onItem({ role: 'tool', name: call.name, input: call.input, ok, summary, callId: call.id })
      results.push({ type: 'tool_result', tool_use_id: call.id, content, ...(ok ? {} : { is_error: true }) })
    }
    history.push({ role: 'user', content: results })
  }
  onItem({ role: 'error', text: 'Stopped after 24 steps.' })
}
