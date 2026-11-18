/**
 * Which models each agent provider can use.
 *
 * - Claude Code and Codex have no listing command, so they get the lists below (each id is what
 *   that CLI accepts after `--model`; Claude Code's aliases follow the newest of each family).
 * - Cursor Agent and OpenCode are asked on the desktop (`cursor-agent models`, `opencode models`).
 * - API providers are asked with one `GET {base}/models` (Anthropic's paging followed).
 *
 * Every list is a starting point: the pickers keep "Custom…" for any id the provider knows.
 * Lists are cached (CLI: per session on the desktop side, here 10 min; API: 60 s), one request
 * is shared by everyone asking, and a failed refresh keeps the last good list.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { providerKey, type ProviderDef, type ProviderSettings } from './providers'
import { isTauri } from '../platform/tauri'
import { listCliModels, type AgentCliId } from '../platform/agents'

export interface ModelChoice {
  id: string
  label: string
  hint?: string
  /** the provider marks it as its current / default model */
  current?: boolean
}

export interface ModelList {
  models: ModelChoice[]
  loading: boolean
  error: string | null
  /** there is something to ask (a CLI that lists models, or an API with its key and address) */
  canFetch: boolean
  refresh: () => void
}

/** Shown before (or instead of) a fetched list. */
export const BUILTIN_MODELS: Record<string, ModelChoice[]> = {
  'cli:claude': [
    { id: 'opus', label: 'Opus', hint: 'complex work' },
    { id: 'fable', label: 'Fable', hint: 'most capable' },
    { id: 'sonnet', label: 'Sonnet', hint: 'balanced' },
    { id: 'haiku', label: 'Haiku', hint: 'quickest' },
    { id: 'claude-opus-5-5', label: 'Opus 5.5', hint: 'claude-opus-5-5' },
    { id: 'claude-fable-5-2', label: 'Fable 5.2', hint: 'claude-fable-5-2' },
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', hint: 'claude-sonnet-5-5' },
    { id: 'claude-haiku-5-5', label: 'Haiku 5.5', hint: 'claude-haiku-5-5' },
  ],
  'cli:codex': [
    { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', hint: 'recommended' },
    { id: 'gpt-6-astra', label: 'GPT-6 Astra', hint: 'most capable' },
    { id: 'gpt-6-luna', label: 'GPT-6 Luna', hint: 'most efficient' },
  ],
  'api:anthropic': [
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
    { id: 'claude-fable-5-2', label: 'Claude Fable 5.2' },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
    { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
  ],
}

/** How many fetched models a picker shows; any other id can still be typed. */
export const MAX_LISTED = 300

const CLI_TTL = 10 * 60_000
const API_TTL = 60_000
const API_TIMEOUT = 8_000
const ANTHROPIC_BASE = 'https://api.anthropic.com/v1'

/* ------------------------------------------------------------------ API listing */

const isLocalHost = (h: string) =>
  h === 'localhost' || h === '[::1]' || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.endsWith('.local')

/** `https://host/v1/` or `…/chat/completions` → `https://host/v1`; throws a readable error for a bad URL. */
export function cleanBaseUrl(raw: string): string {
  const s = raw.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '')
  let u: URL
  try {
    u = new URL(s)
  } catch {
    throw new Error(`“${raw.trim()}” isn't a web address.`)
  }
  if (u.username || u.password || u.search || u.hash) throw new Error('Put the key in the API key field, not in the address.')
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLocalHost(u.hostname))) throw new Error('Use an https:// address (http:// only for this computer or your network).')
  return s
}

/** Ids that are never chat models (embeddings, speech, images, moderation…). */
const NOT_CHAT = /(embed|whisper|tts|dall-e|moderation|transcribe|-audio|realtime|^gpt-image|image-|babbage|davinci|^sora|rerank)/i

interface RawModel {
  id?: string
  name?: string
  display_name?: string
  displayName?: string
}

const redact = (text: string, key: string) => (key && key.length >= 8 ? text.split(key).join('••••') : text)

/** The server's own error message, if it sent one in JSON. */
function serverMessage(body: string): string | null {
  try {
    const j = JSON.parse(body) as { error?: { message?: string } | string; message?: string; detail?: string }
    const m = (typeof j.error === 'object' ? j.error?.message : j.error) ?? j.message ?? j.detail
    return typeof m === 'string' && m.trim() ? m.trim().slice(0, 200) : null
  } catch {
    return null
  }
}

/** Lists the models an OpenAI-compatible (or Anthropic, or Google) endpoint offers this key. */
export async function fetchApiModels(base: string, key: string, label = base): Promise<ModelChoice[]> {
  const url = cleanBaseUrl(base)
  const host = new URL(url).hostname
  const anthropic = /(^|\.)anthropic\.com$/i.test(host)
  const headers: Record<string, string> = !key
    ? {}
    : anthropic
      ? { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }
      : { Authorization: `Bearer ${key}` }
  const raw: RawModel[] = []
  let after: string | null = null
  // Anthropic pages (has_more / last_id); everyone else answers in one go
  for (let page = 0; page < 10; page++) {
    const q = anthropic ? `?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}` : ''
    let r: Response
    try {
      r = await fetch(`${url}/models${q}`, { headers, redirect: 'error', signal: AbortSignal.timeout(API_TIMEOUT) })
    } catch (e) {
      if (e instanceof DOMException && e.name === 'TimeoutError') throw new Error(`${label} didn't answer within ${API_TIMEOUT / 1000}s.`)
      if (/redirect/i.test(String((e as { cause?: unknown })?.cause ?? ''))) throw new Error(`${url} redirected to another address, so Kiln stopped rather than send your key there.`)
      throw new Error(
        isLocalHost(host)
          ? `Nothing answered at ${url}. Is the model server running?`
          : `Couldn't reach ${url}. Check the address, or the server may not allow requests from Kiln.`,
      )
    }
    const body = await r.text()
    if (!r.ok) {
      const msg = serverMessage(body)
      if (r.status === 401 || r.status === 403) throw new Error(redact(`${label} didn't accept the key${msg ? `: ${msg}` : '.'}`, key))
      throw new Error(redact(`${label} answered ${r.status}${msg ? `: ${msg}` : ''}. You can still type the model's id.`, key))
    }
    let j: { data?: RawModel[]; models?: RawModel[]; has_more?: boolean; last_id?: string | null }
    try {
      j = JSON.parse(body)
    } catch {
      throw new Error(`${label} didn't send a model list. You can still type the model's id.`)
    }
    raw.push(...(j.data ?? []), ...(j.models ?? []))
    if (!anthropic || !j.has_more || !j.last_id) break
    after = j.last_id
  }

  const seen = new Set<string>()
  const out: ModelChoice[] = []
  for (const m of raw) {
    const id = String(m.id ?? m.name ?? '').replace(/^models\//, '')
    if (!id || seen.has(id) || NOT_CHAT.test(id)) continue
    seen.add(id)
    const name = m.display_name ?? m.displayName ?? (m.name && m.name !== m.id && !m.name.startsWith('models/') ? m.name : undefined)
    out.push(name && name !== id ? { id, label: name, hint: id } : { id, label: id })
  }
  // Anthropic lists newest first, which is the useful order; sort the rest by id
  if (!anthropic) out.sort((a, b) => a.id.localeCompare(b.id))
  return out
}

/* ------------------------------------------------------------------ sources */

interface Source {
  /** identifies the list: provider + what it depends on (CLI, endpoint, key) */
  key: string
  ttl: number
  load: (force: boolean) => Promise<ModelChoice[]>
}

/** Where `p`'s list comes from with these settings, or null when there is nothing to ask yet. */
function sourceOf(p: ProviderDef, settings: ProviderSettings): Source | null {
  if (p.kind === 'cli') {
    const cli = p.cli
    if (!isTauri || (cli !== 'cursor-agent' && cli !== 'opencode')) return null
    return {
      key: p.id,
      ttl: CLI_TTL,
      load: async (force) =>
        (await listCliModels(cli as AgentCliId, force)).map((m) => ({ id: m.id, label: m.label, hint: m.current ? 'current default' : m.id !== m.label ? m.id : undefined, current: m.current })),
    }
  }
  const key = providerKey(settings, p.id).trim()
  if (p.needsKey !== false && !key) return null
  const base = p.id === 'api:anthropic' ? ANTHROPIC_BASE : (settings.baseURLs[p.id] || p.baseURL || '').trim()
  if (!base) return null
  return { key: `${p.id}|${base}|${key}`, ttl: API_TTL, load: () => fetchApiModels(base, key, p.label) }
}

/* ------------------------------------------------------------------ shared store */

interface Entry {
  models: ModelChoice[] | null
  at: number
  loading: boolean
  error: string | null
  inflight: Promise<void> | null
}

const entries = new Map<string, Entry>()
/** last good list per provider, kept when its key or endpoint changes and the new ask fails */
const lastGood = new Map<string, ModelChoice[]>()
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

const EMPTY: Entry = { models: null, at: 0, loading: false, error: null, inflight: null }

function ensure(providerId: string, src: Source, force: boolean) {
  const e = entries.get(src.key) ?? { ...EMPTY }
  if (e.inflight) return
  if (!force && e.models && Date.now() - e.at < src.ttl) return
  if (!force && e.error && Date.now() - e.at < src.ttl) return // don't hammer a failing endpoint on every render
  const next: Entry = { ...e, loading: true, error: null }
  next.inflight = src.load(force).then(
    (models) => {
      if (models.length) lastGood.set(providerId, models)
      entries.set(src.key, { models, at: Date.now(), loading: false, error: null, inflight: null })
      emit()
    },
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      entries.set(src.key, { models: e.models, at: Date.now(), loading: false, error: message, inflight: null })
      emit()
    },
  )
  entries.set(src.key, next)
  emit()
}

/**
 * The models to offer for `p`: the built-in list first, replaced by the fetched one when it
 * arrives. API providers ask only once a key is set (or the provider needs none).
 */
export function useModels(p: ProviderDef, settings: ProviderSettings): ModelList {
  const src = sourceOf(p, settings)
  const srcKey = src?.key ?? null
  const entry = useSyncExternalStore(subscribe, () => (srcKey ? entries.get(srcKey) : undefined) ?? EMPTY)

  useEffect(() => {
    if (src) ensure(p.id, src, false)
    // src is rebuilt every render; its key says when what it asks has changed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcKey, p.id])

  const refresh = useCallback(() => {
    if (src) ensure(p.id, src, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcKey, p.id])

  const fetched = entry.models?.length ? entry.models : entry.error ? lastGood.get(p.id) : undefined
  const models = (fetched?.length ? fetched : BUILTIN_MODELS[p.id] ?? []).slice(0, MAX_LISTED)
  return { models, loading: entry.loading, error: entry.error, canFetch: !!src, refresh }
}
