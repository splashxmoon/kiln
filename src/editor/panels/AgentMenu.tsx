import { useEffect, useState, type ReactNode } from 'react'
import { Check, Copy, ExternalLink, PenLine, Plug, RotateCw, X } from 'lucide-react'
import { PROVIDERS, CLI_EFFORTS, providerById, providerKey, type ProviderSettings, type ProviderDef } from '../../agent/providers'
import { detectAgentClis, connectAgentCli, agentConnectSnippets, type CliInfo } from '../../platform/agents'
import { isTauri, desktopAgentStatus } from '../../platform/tauri'
import { Popover } from '../../ui/Popover'
import { Select, type SelectOption } from '../../ui/Select'
import { Disclosure } from '../../ui/Disclosure'
import { ProviderIcon } from './ProviderIcon'
import { useModels, type ModelList } from '../../agent/models'
import { EffortIcon } from './EffortIcon'
import './agent-menu.css'

const CUSTOM = '__custom__'

type Kind = ProviderDef['kind']
type Tone = 'good' | 'warn' | 'bad' | 'muted'

function copy(text: string) {
  void navigator.clipboard.writeText(text)
}

/**
 * One agent: a radio-style row. The selected row opens in place to show its settings,
 * so picking an agent and setting it up happen in the same spot.
 */
function AgentItem({
  p,
  active,
  usable,
  status,
  tip,
  onPick,
  children,
}: {
  p: ProviderDef
  active: boolean
  usable: boolean
  status?: { text: string; tone: Tone }
  tip?: string
  onPick: () => void
  children?: ReactNode
}) {
  return (
    <div className={'k-am-item' + (active ? ' is-active' : '') + (usable ? '' : ' is-off')}>
      <button type="button" role="radio" aria-checked={active} className="k-am-row" disabled={!usable && !active} onClick={onPick} title={tip}>
        <span className="k-am-mark" aria-hidden="true">
          <ProviderIcon id={p.id} size={17} />
        </span>
        <span className="k-am-row-main">
          <span className="k-am-row-name">{p.label}</span>
          <span className="k-am-row-sub">{p.plan}</span>
        </span>
        {status && <span className={'k-am-pill is-' + status.tone}>{status.text}</span>}
        <span className={'k-am-radio' + (active ? ' is-on' : '')} aria-hidden="true">
          {active && <Check size={11} strokeWidth={3} />}
        </span>
      </button>
      {active && children && <div className="k-am-detail">{children}</div>}
    </div>
  )
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="k-am-field">
      <span className="k-am-label">{label}</span>
      {children}
      {hint && <span className="k-am-hint">{hint}</span>}
    </label>
  )
}

/**
 * Agent settings as a popover anchored to the agent button.
 * Flow: pick Subscriptions or API keys, pick an agent, set it up right under it.
 * How to reach Kiln from outside agents sits collapsed at the bottom.
 */
export function AgentMenu({
  open,
  anchor,
  settings,
  onChange,
  onClose,
}: {
  open: boolean
  anchor: HTMLElement | null
  settings: ProviderSettings
  onChange: (s: ProviderSettings) => void
  onClose: () => void
}) {
  const [clis, setClis] = useState<CliInfo[] | null>(null)
  const [snippets, setSnippets] = useState<{ cli: string; title: string; command: string }[]>([])
  const [mcpUrl, setMcpUrl] = useState('http://127.0.0.1:7457/mcp')
  const [connectMsg, setConnectMsg] = useState<Record<string, string>>({})
  // the "Custom…" model option, per provider, so a typed id stays visible while it is being edited
  const [customFor, setCustomFor] = useState<string | null>(null)
  const active = providerById(settings.active)
  // open on the tab that holds the current agent
  const [tab, setTab] = useState<Kind>(active?.kind ?? 'cli')
  // each time the menu opens (not on every pick), jump to the current agent's tab
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setTab(active?.kind ?? 'cli')
  }

  useEffect(() => {
    if (!open || !isTauri) return
    detectAgentClis().then(setClis).catch(() => setClis([]))
    agentConnectSnippets().then(setSnippets).catch(() => {})
    desktopAgentStatus().then((s) => setMcpUrl(s.url)).catch(() => {})
  }, [open])

  const upd = (patch: (s: ProviderSettings) => void) => {
    const next: ProviderSettings = JSON.parse(JSON.stringify({ ...settings, keys: { ...settings.keys, 'api:anthropic': providerKey(settings, 'api:anthropic') } }))
    patch(next)
    onChange(next)
  }
  const pick = (p: ProviderDef) => upd((s) => void (s.active = p.id))

  const cliInfo = (p: ProviderDef) => clis?.find((c) => c.id === p.cli)
  const usable = (p: ProviderDef) => {
    if (p.kind === 'api') return true
    const info = cliInfo(p)
    return isTauri && !!info?.installed && !info.error
  }
  /** A pill only when the agent needs something; a ready agent stays quiet. */
  const statusFor = (p: ProviderDef): { text: string; tone: Tone } | undefined => {
    if (p.kind === 'api') {
      if (p.needsKey === false) return { text: 'Local', tone: 'muted' }
      return providerKey(settings, p.id) ? { text: 'Key set', tone: 'good' } : { text: 'Needs key', tone: 'warn' }
    }
    // in the browser the group heading already says why
    if (!isTauri) return undefined
    if (!clis) return { text: 'Checking…', tone: 'muted' }
    const info = cliInfo(p)
    if (!info?.installed) return { text: 'Not installed', tone: 'muted' }
    if (info.error) return { text: 'Needs repair', tone: 'bad' }
    return undefined
  }
  const tipFor = (p: ProviderDef) => {
    const v = cliInfo(p)?.version
    return v ? `${p.label} ${v.replace(/\s*\(.*\)$/, '')}` : undefined
  }

  const list = PROVIDERS.filter((p) => p.kind === tab)
  // ready agents (and the current one) first; the rest gather in a quiet group below
  const ready = list.filter((p) => usable(p) || p.id === settings.active)
  const unavailable = list.filter((p) => !ready.includes(p))

  const detail = (p: ProviderDef) =>
    p.kind === 'cli' ? (
      <CliOptions
        p={p}
        settings={settings}
        customOn={customFor === p.id}
        onCustom={() => setCustomFor(p.id)}
        onSettled={() => setCustomFor(null)}
        upd={upd}
        info={cliInfo(p)}
        usable={usable(p)}
        connectMsg={connectMsg[p.id]}
        onConnect={async () => {
          setConnectMsg((m) => ({ ...m, [p.id]: 'Connecting…' }))
          try {
            const out = await connectAgentCli(p.cli!)
            setConnectMsg((m) => ({ ...m, [p.id]: out.trim().split('\n').slice(-1)[0] || 'Connected' }))
          } catch (e) {
            setConnectMsg((m) => ({ ...m, [p.id]: String((e as Error).message ?? e) }))
          }
        }}
      />
    ) : (
      <ApiOptions
        p={p}
        settings={settings}
        upd={upd}
        customOn={customFor === p.id}
        onCustom={() => setCustomFor(p.id)}
        onSettled={() => setCustomFor(null)}
      />
    )

  const item = (p: ProviderDef) => (
    <AgentItem key={p.id} p={p} active={settings.active === p.id} usable={usable(p)} status={statusFor(p)} tip={tipFor(p)} onPick={() => pick(p)}>
      {detail(p)}
    </AgentItem>
  )

  return (
    <Popover anchor={anchor} open={open} onClose={onClose} placement="bottom-start" offset={8} className="k-am" label="Agent settings">
      <div className="k-am-inner" onKeyDown={(e) => e.stopPropagation()}>
        <div className="k-am-top">
          <header className="k-am-head">
            <div className="k-am-head-text">
              <div className="k-am-title">Agent</div>
              <p className="k-am-sub">Uses the plans and keys you already pay for.</p>
            </div>
            <button type="button" className="k-icon-btn k-sm" onClick={onClose} aria-label="Close">
              <X size={14} />
            </button>
          </header>
          <div className="k-am-tabs" role="tablist" aria-label="Agent type">
            {(
              [
                ['cli', 'Subscriptions'],
                ['api', 'API keys'],
              ] as const
            ).map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'is-on' : ''} onClick={() => setTab(k)}>
                {label}
                {active?.kind === k && <span className="k-am-tab-dot" aria-label="current agent" />}
              </button>
            ))}
          </div>
        </div>

        <section className="k-am-body" role="radiogroup" aria-label={tab === 'cli' ? 'Subscription agent' : 'API agent'}>
          {tab === 'cli' && !isTauri && (
            <p className="k-am-callout">Subscriptions run through each vendor’s official CLI on your computer. Open the Kiln desktop app to use them.</p>
          )}
          {tab === 'cli' && isTauri && clis && !clis.some((c) => c.installed) && (
            <p className="k-am-callout">
              No agent CLIs found. Install one, e.g. <code>npm i -g @anthropic-ai/claude-code</code>, sign in once in your terminal, then reopen this menu.
            </p>
          )}
          {tab === 'api' && <p className="k-am-hintline">Keys stay on this device and go only to the provider you pick.</p>}

          <div className="k-am-list">{ready.map(item)}</div>

          {unavailable.length > 0 && (
            <>
              <div className="k-am-group">{isTauri ? 'Not installed' : 'Desktop app only'}</div>
              <div className="k-am-list">{unavailable.map(item)}</div>
            </>
          )}
        </section>

        <footer className="k-am-foot">
          <Disclosure className="k-am-more" title="Use Kiln from any agent">
            {isTauri ? (
              <div className="k-am-more-body">
                <span className="k-am-label">MCP server</span>
                <div className="k-am-copy">
                  <code>{mcpUrl}</code>
                  <button type="button" className="k-icon-btn k-sm" onClick={() => copy(mcpUrl)} title="Copy MCP URL" aria-label="Copy MCP URL">
                    <Copy size={12} />
                  </button>
                </div>
                {snippets.map((s) => (
                  <Disclosure key={s.cli + s.title} className="k-snippet" title={s.title}>
                    <div className="k-am-copy">
                      <pre>{s.command}</pre>
                      <button type="button" className="k-icon-btn k-sm" onClick={() => copy(s.command)} title="Copy" aria-label="Copy command">
                        <Copy size={12} />
                      </button>
                    </div>
                  </Disclosure>
                ))}
              </div>
            ) : (
              <p className="k-am-note">
                In the browser, agents that can drive a web page can call <code>window.kiln.call(tool, args)</code>. Run <code>kiln.help()</code> in the console. The desktop app adds a local MCP server for Claude Code, Codex, Cursor, VS Code and Zed.
              </p>
            )}
          </Disclosure>
        </footer>
      </div>
    </Popover>
  )
}

/** Key, endpoint and model for an API provider. */
function ApiOptions({
  p,
  settings,
  upd,
  customOn,
  onCustom,
  onSettled,
}: {
  p: ProviderDef
  settings: ProviderSettings
  upd: (patch: (s: ProviderSettings) => void) => void
  customOn: boolean
  onCustom: () => void
  onSettled: () => void
}) {
  const list = useModels(p, settings)
  const model = modelPick(p, settings, list, customOn)
  const hasKey = p.needsKey === false || !!providerKey(settings, p.id)
  return (
    <div className="k-am-fields" key={p.id}>
      {p.needsKey !== false && (
        <Field label="API key">
          <input
            className="k-text-input k-mono"
            type="password"
            placeholder="Paste your key"
            defaultValue={providerKey(settings, p.id)}
            onBlur={(e) => upd((s) => void (s.keys[p.id] = e.target.value.trim()))}
          />
        </Field>
      )}
      {p.id !== 'api:anthropic' && (
        <Field label="Base URL">
          <input className="k-text-input k-mono" placeholder="https://…" defaultValue={settings.baseURLs[p.id] ?? p.baseURL ?? ''} onBlur={(e) => upd((s) => void (s.baseURLs[p.id] = e.target.value.trim()))} />
        </Field>
      )}
      <ModelField p={p} list={list} pick={model} onCustom={onCustom} onSettled={onSettled} upd={upd} />
      {model.showCustom && <CustomModelInput p={p} settings={settings} autoFocus={customOn && !model.current} upd={upd} />}
      {!hasKey && <p className="k-am-note">Add your key to list the models it can use.</p>}
      {list.error && <p className="k-am-err">{list.error}</p>}
      {p.keyUrl && (
        <a className="k-am-link" href={p.keyUrl} target="_blank" rel="noreferrer">
          Get an API key <ExternalLink size={11} />
        </a>
      )}
    </div>
  )
}

const CUSTOM_ICON = <PenLine size={14} className="k-am-opt-icon" aria-hidden="true" />

/** What the model picker shows: the saved id when it's listed, else "Custom…" (or "Default" when empty). */
function modelPick(p: ProviderDef, settings: ProviderSettings, list: ModelList, customOn: boolean) {
  const current = settings.models[p.id] ?? ''
  const listed = list.models.some((m) => m.id === current)
  const showCustom = customOn || (!!current && !listed)
  return { current, showCustom, value: showCustom ? CUSTOM : listed ? current : '' }
}

/** The model picker: the fetched (or built-in) list, "Custom…" for any other id, and a refresh button. */
function ModelField({
  p,
  list,
  pick,
  onCustom,
  onSettled,
  upd,
}: {
  p: ProviderDef
  list: ModelList
  pick: ReturnType<typeof modelPick>
  onCustom: () => void
  onSettled: () => void
  upd: (patch: (s: ProviderSettings) => void) => void
}) {
  // every model the provider runs carries its mark
  const mark = <ProviderIcon id={p.id} size={14} />
  const options: SelectOption<string>[] = [
    { value: '', label: p.defaultModel ? `Default · ${p.defaultModel}` : 'Default', icon: mark },
    ...list.models.map((m) => ({ value: m.id, label: m.label, hint: m.hint, icon: mark })),
    { value: CUSTOM, label: 'Custom…', hint: 'type a model id', icon: CUSTOM_ICON },
  ]
  return (
    <div className="k-am-field">
      <span className="k-am-label-row">
        <span className="k-am-label">Model</span>
        {list.canFetch && (
          <button
            type="button"
            className={'k-am-refresh' + (list.loading ? ' is-busy' : '')}
            title={list.loading ? 'Fetching models…' : 'Refresh models'}
            aria-label={list.loading ? 'Fetching models' : 'Refresh models'}
            disabled={list.loading}
            onClick={list.refresh}
          >
            <RotateCw size={11} strokeWidth={2.25} />
          </button>
        )}
      </span>
      <Select<string>
        value={pick.value}
        options={options}
        title="Model"
        width="100%"
        menuWidth={280}
        onChange={(v) => {
          if (v === CUSTOM) return onCustom()
          onSettled()
          upd((s) => void (s.models[p.id] = v))
        }}
      />
    </div>
  )
}

function CustomModelInput({ p, settings, autoFocus, upd }: { p: ProviderDef; settings: ProviderSettings; autoFocus: boolean; upd: (patch: (s: ProviderSettings) => void) => void }) {
  return (
    <input
      className="k-text-input k-mono"
      autoFocus={autoFocus}
      aria-label="Model id"
      placeholder={p.modelHint ? `e.g. ${p.modelHint}` : 'Model id'}
      defaultValue={settings.models[p.id] ?? ''}
      onBlur={(e) => upd((s) => void (s.models[p.id] = e.target.value.trim()))}
    />
  )
}

/** Model and reasoning pickers for a CLI provider, plus its connect action. */
function CliOptions({
  p,
  settings,
  customOn,
  onCustom,
  onSettled,
  upd,
  info,
  usable,
  connectMsg,
  onConnect,
}: {
  p: ProviderDef
  settings: ProviderSettings
  customOn: boolean
  onCustom: () => void
  onSettled: () => void
  upd: (patch: (s: ProviderSettings) => void) => void
  info: CliInfo | undefined
  usable: boolean
  connectMsg?: string
  onConnect: () => void
}) {
  const cli = p.cli!
  const efforts = CLI_EFFORTS[cli] ?? []
  const list = useModels(p, settings)
  const model = modelPick(p, settings, list, customOn)

  // "Default" for reasoning is the CLI's own choice, so it carries the CLI's mark too
  const mark = <ProviderIcon id={p.id} size={14} />
  const effortOptions: SelectOption<string>[] = [
    { value: '', label: 'Default', icon: mark },
    ...efforts.map((e, i) => ({ value: e.value, label: e.label, icon: <EffortIcon level={i + 1} of={efforts.length} /> })),
  ]

  return (
    <div className="k-am-fields" key={p.id}>
      <div className={efforts.length ? 'k-am-pair' : 'k-am-fields'}>
        <ModelField p={p} list={list} pick={model} onCustom={onCustom} onSettled={onSettled} upd={upd} />
        {efforts.length > 0 && (
          <div className="k-am-field">
            <span className="k-am-label">Reasoning</span>
            <Select<string>
              value={settings.efforts?.[p.id] ?? ''}
              options={effortOptions}
              title="Reasoning level"
              width="100%"
              menuWidth={200}
              onChange={(v) => upd((s) => void ((s.efforts ??= {})[p.id] = v))}
            />
          </div>
        )}
      </div>

      {model.showCustom && <CustomModelInput p={p} settings={settings} autoFocus={customOn && !model.current} upd={upd} />}
      {list.error && usable && <p className="k-am-err">{list.error}</p>}

      {p.caution && usable && <p className="k-am-warn">{p.caution}</p>}
      {info?.error && <p className="k-am-err">{info.error}</p>}
      {!usable && isTauri && info && !info.installed && <p className="k-am-note">Install {p.label} and sign in once in your terminal to use it here.</p>}

      <div className="k-am-connect">
        <button type="button" className="k-am-connect-btn" disabled={!usable} onClick={onConnect}>
          <Plug size={13} />
          <span className="k-am-connect-text">
            <span className="k-am-connect-title">Connect in terminal</span>
            <span className="k-am-connect-sub">{connectMsg ?? 'Let your own terminal sessions use Kiln too'}</span>
          </span>
        </button>
      </div>
    </div>
  )
}
