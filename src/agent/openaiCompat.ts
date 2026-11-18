/**
 * OpenAI-compatible provider (OpenAI, OpenRouter, Ollama, LM Studio, Groq …)
 * using the user's own key / local server. Chat Completions + function tools.
 */
import OpenAI from 'openai'
import { AGENT_TOOLS, runTool } from './tools'
import { AGENT_SYSTEM_PROMPT, kilnContext } from './prompt'
import type { ChatImage, ChatItem } from './keys'
import { attachedNote } from './chats'

export interface CompatConfig {
  baseURL: string
  apiKey: string
  model: string
}

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam

export async function runCompatTurn(
  cfg: CompatConfig,
  history: Msg[],
  userText: string,
  onItem: (i: ChatItem) => void,
  signal?: AbortSignal,
  images: ChatImage[] = [],
) {
  if (!cfg.model) throw new Error('Choose a model for this provider in agent settings.')
  const client = new OpenAI({ apiKey: cfg.apiKey || 'not-needed', baseURL: cfg.baseURL || undefined, dangerouslyAllowBrowser: true })
  if (!history.length) history.push({ role: 'system', content: AGENT_SYSTEM_PROMPT })
  const text = userText + kilnContext()
  // text-only turns keep the plain string; with images, the images come first, then the text
  history.push({
    role: 'user',
    content: images.length
      ? [
          ...images.map((img) => ({ type: 'image_url' as const, image_url: { url: `data:${img.mediaType};base64,${img.data}` } })),
          { type: 'text' as const, text: text + attachedNote(images) },
        ]
      : text,
  })
  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = AGENT_TOOLS.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema as Record<string, unknown> },
  }))

  for (let step = 0; step < 24; step++) {
    if (signal?.aborted) return
    const res = await client.chat.completions.create({ model: cfg.model, messages: history, tools }, { signal })
    const msg = res.choices[0]?.message
    if (!msg) return
    history.push(msg as Msg)
    if (msg.content) onItem({ role: 'assistant', text: msg.content })
    const calls = (msg.tool_calls ?? []).filter((c) => c.type === 'function')
    if (!calls.length) return
    const images: string[] = []
    for (const call of calls) {
      if (call.type !== 'function') continue
      // show the step as running before it runs; the result below replaces it (same callId)
      onItem({ role: 'tool', name: call.function.name, input: call.function.arguments, ok: true, summary: '', callId: call.id, running: true })
      let ok = true
      let textOut = ''
      try {
        const args = call.function.arguments ? JSON.parse(call.function.arguments) : {}
        const out = await runTool(call.function.name, args)
        textOut = out.map((c) => (c.type === 'text' ? c.text : '[image attached below]')).join('\n')
        for (const c of out) if (c.type === 'image') images.push(`data:${c.mimeType};base64,${c.data}`)
      } catch (e) {
        ok = false
        textOut = 'Error: ' + (e as Error).message
      }
      onItem({ role: 'tool', name: call.function.name, input: call.function.arguments, ok, summary: textOut.slice(0, 140), callId: call.id })
      history.push({ role: 'tool', tool_call_id: call.id, content: textOut })
    }
    if (images.length) {
      history.push({ role: 'user', content: [{ type: 'text', text: 'Screenshot result:' }, ...images.map((url) => ({ type: 'image_url' as const, image_url: { url } }))] })
    }
  }
  onItem({ role: 'error', text: 'Stopped after 24 steps.' })
}
