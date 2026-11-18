import { useEffect, useRef, useState, type DragEvent } from 'react'
import { ArrowUp, Check, ChevronDown, ChevronLeft, ChevronRight, History, ImagePlus, MessageSquare, Plus, Settings2, Square, Trash2, X, AlertTriangle } from 'lucide-react'
import { formatElapsed, toolLabel } from '../../agent/humanize'
import { agentChat, agentRun, agentSession as session, useNow } from './agentSession'
import { MAX_IMAGES, chatImageUrl, fileToChatImage, imageFiles, pickImageFiles } from '../../agent/attachments'
import { deleteChat, loadChats, newChatId, saveChat, timeAgo, type SavedChat } from '../../agent/chats'
import { KilnMark } from '../../brand/Logo'
import { AgentMenu } from './AgentMenu'
import { AgentText } from './AgentText'
import { ProviderIcon } from './ProviderIcon'
import { pickSuggestions } from './suggestions'
import './agent-chat.css'
import { useEditor } from '../store'
import { loadProviderSettings, saveProviderSettings, providerById, type ProviderSettings } from '../../agent/providers'
import type { ChatImage, ChatItem } from '../../agent/keys'

/** The chat on screen. Kept at module level so switching right-panel tabs doesn't lose it; replaced when the design changes. */
let live: { docId: string; id: string; items: ChatItem[] } | null = null

/** The live chat for this design, starting a fresh one if the design changed. */
function currentChat(docId: string) {
  if (live?.docId !== docId) {
    live = { docId, id: newChatId(), items: [] }
    session.reset()
  }
  return live
}


/** A transcript row: a single message, or a run of consecutive tool calls grouped into steps. */
type Row = { kind: 'item'; item: ChatItem; index: number } | { kind: 'steps'; start: number; steps: Step[] }

type Step = { name: string; input: Record<string, unknown> | undefined; ok: boolean; summary: string; running?: boolean }

/** Tool input as an object: the OpenAI-style providers hand it over as a JSON string. */
function toolInput(v: unknown): Record<string, unknown> | undefined {
  if (v && typeof v === 'object') return v as Record<string, unknown>
  if (typeof v !== 'string') return undefined
  try {
    const o = JSON.parse(v)
    return o && typeof o === 'object' ? o : undefined
  } catch {
    return undefined
  }
}

function toRows(items: ChatItem[]): Row[] {
  const rows: Row[] = []
  items.forEach((item, index) => {
    if (item.role === 'tool') {
      const last = rows[rows.length - 1]
      const running = item.running
      const step: Step = { name: item.name, input: toolInput(item.input), ok: item.ok, summary: item.summary, running }
      if (last?.kind === 'steps') last.steps.push(step)
      else rows.push({ kind: 'steps', start: index, steps: [step] })
    } else rows.push({ kind: 'item', item, index })
  })
  return rows
}

/** A short one-line detail for a finished step, from the tool's summary. */
function stepDetail(s: Step): string {
  const t = s.summary.replace(/\s+/g, ' ').trim()
  if (!t || t.startsWith('{') || t.startsWith('[')) return ''
  return t.length > 90 ? t.slice(0, 89) + '…' : t
}

/**
 * A turn's tool calls as a timeline: one node per step on a rail, with the tool's icon
 * and plain wording ("Styled 3 layers"). The step in progress turns a ring around its
 * node; the header says what is happening now and for how long. Once the turn ends it
 * folds into "Used 6 steps · 14s" with the tools' icons in a row.
 */
function StepsBlock({
  steps,
  live,
  open,
  onToggle,
  startedAt,
  tookMs,
}: {
  steps: Step[]
  live: boolean
  open: boolean
  onToggle: () => void
  startedAt: number | null
  tookMs: number | undefined
}) {
  const now = useNow(live)
  const n = steps.length
  const count = `${n} step${n === 1 ? '' : 's'}`
  const labels = steps.map((s) => toolLabel(s.name, s.input))
  // the running step: the one marked running, else (CLI agents) the last one while live
  const markedRunning = steps.some((s) => s.running)
  const isRunning = (i: number) => live && (markedRunning ? !!steps[i].running : i === n - 1)
  const current = labels[steps.findIndex((_, i) => isRunning(i))] ?? labels[n - 1]
  const time = live && startedAt ? formatElapsed(now - startedAt) : tookMs !== undefined ? formatElapsed(tookMs) : ''
  // distinct icons of the tools used, for the folded header
  const icons = [...new Set(labels.map((l) => l.icon))].slice(0, 5)
  const errors = steps.filter((s) => !s.ok && !s.running).length

  return (
    <div className={'k-ac-steps' + (live ? ' is-live' : '') + (open ? ' is-open' : '')}>
      <button type="button" className="k-ac-steps-head" aria-expanded={open} onClick={onToggle}>
        <span className="k-ac-steps-state" aria-hidden="true">
          {live ? <i className="k-ac-ring" /> : errors ? <AlertTriangle size={11} /> : <Check size={11} strokeWidth={2.75} />}
        </span>
        <span className="k-ac-steps-title">
          {live ? (
            <span key={current.verb} className="k-ac-steps-now k-ac-shimmer">
              {current.verb}
            </span>
          ) : (
            <span className="k-ac-done">Used {count}</span>
          )}
        </span>
        {!live && !open && (
          <span className="k-ac-steps-icons" aria-hidden="true">
            {icons.map((Icon, i) => (
              <Icon key={i} size={11} />
            ))}
          </span>
        )}
        <span className="k-ac-steps-meta">{[live ? count : '', time].filter(Boolean).join(' · ')}</span>
        <ChevronRight size={12} className={'k-ac-chev' + (open ? ' is-open' : '')} />
      </button>
      {open && (
        <ol className="k-ac-tl">
          {steps.map((s, i) => {
            const L = labels[i]
            const running = isRunning(i)
            const Icon = L.icon
            const detail = running ? '' : stepDetail(s)
            return (
              <li key={i} className={'k-ac-tl-step' + (running ? ' is-running' : !s.ok ? ' is-err' : '') + (' is-' + L.kind)}>
                <span className="k-ac-tl-node" aria-hidden="true">
                  {s.ok || running ? <Icon size={11} /> : <AlertTriangle size={11} />}
                </span>
                <span className="k-ac-tl-body">
                  <span className={'k-ac-tl-label' + (running ? ' k-ac-shimmer' : '')}>{running ? L.verb : s.ok ? L.done : `${L.verb} failed`}</span>
                  {detail && <span className="k-ac-tl-sub">{detail}</span>}
                </span>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ panel */

/** Today / Yesterday / Previous 7 days / Older, by the chat's last activity. */
function chatGroup(ts: number, now = new Date()): string {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const day = 86_400_000
  if (ts >= today) return 'Today'
  if (ts >= today - day) return 'Yesterday'
  if (ts >= today - 7 * day) return 'Previous 7 days'
  return 'Older'
}

/** The agent's last reply on one line, as a preview under the title. */
function chatPreview(c: SavedChat): string {
  for (let i = c.items.length - 1; i >= 0; i--) {
    const it = c.items[i]
    if (it.role === 'assistant' && it.text.trim()) return it.text.replace(/\s+/g, ' ').trim()
  }
  const steps = c.items.filter((i) => i.role === 'tool').length
  return steps ? `${steps} ${steps === 1 ? 'step' : 'steps'}, no reply yet` : 'No reply yet'
}

/** Past chats for this design, newest first. Opening one restores its agent context too. */
function ChatHistory({
  chats,
  activeId,
  busy,
  onOpen,
  onDelete,
  onBack,
}: {
  chats: SavedChat[]
  activeId: string
  busy: boolean
  onOpen: (c: SavedChat) => void
  onDelete: (id: string) => void
  onBack: () => void
}) {
  const groups: { label: string; chats: SavedChat[] }[] = []
  for (const c of chats) {
    const label = chatGroup(c.updatedAt)
    const g = groups[groups.length - 1]
    if (g?.label === label) g.chats.push(c)
    else groups.push({ label, chats: [c] })
  }
  return (
    <div className="k-ah">
      <div className="k-ah-head">
        <button type="button" className="k-icon-btn k-sm" onClick={onBack} aria-label="Back to chat" title="Back to chat">
          <ChevronLeft size={14} />
        </button>
        <span className="k-ah-title">Past chats</span>
        {chats.length > 0 && <span className="k-ah-count">{chats.length}</span>}
      </div>
      {chats.length === 0 ? (
        <div className="k-ah-empty">
          <div className="k-ah-empty-art" aria-hidden="true">
            <span className="k-ah-empty-card is-back" />
            <span className="k-ah-empty-card is-mid" />
            <span className="k-ah-empty-card is-front">
              <MessageSquare size={16} />
              <i />
              <i />
            </span>
          </div>
          <h3>No past chats yet</h3>
          <p>Every conversation about this design is saved here, so you can pick one up where you left off.</p>
          <button type="button" className="k-btn-primary" onClick={onBack}>
            <Plus size={13} />
            Start a chat
          </button>
        </div>
      ) : (
        <div className="k-ah-groups">
          {groups.map((g) => (
            <section key={g.label} className="k-ah-group" aria-label={g.label}>
              <h4 className="k-ah-label">{g.label}</h4>
              <ul className="k-ah-list">
                {g.chats.map((c) => {
                  const active = c.id === activeId
                  return (
                    <li key={c.id} className={'k-ah-row' + (active ? ' is-active' : '')}>
                      <button type="button" className="k-ah-open" onClick={() => onOpen(c)} disabled={busy && !active} title={c.title} aria-current={active || undefined}>
                        <span className="k-ah-line">
                          <span className="k-ah-name">{c.title}</span>
                          <span className="k-ah-time">{active ? 'Open' : timeAgo(c.updatedAt)}</span>
                        </span>
                        <span className="k-ah-preview">{chatPreview(c)}</span>
                      </button>
                      <button type="button" className="k-ah-del" onClick={() => onDelete(c.id)} disabled={busy && active} aria-label={`Delete “${c.title}”`} title="Delete chat">
                        <Trash2 size={13} />
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

export function AgentPanel() {
  const [settings, setSettings] = useState<ProviderSettings>(loadProviderSettings)
  const docId = useEditor((s) => s.doc.id)
  // the panel is keyed by design in Editor, so these start from this design's live chat
  const [chatId, setChatId] = useState(() => currentChat(docId).id)
  const [items, setItems] = useState<ChatItem[]>(() => currentChat(docId).items)
  const [chats, setChats] = useState<SavedChat[]>(() => loadChats(docId))
  const [view, setView] = useState<'chat' | 'history'>('chat')
  // a fresh set of starter prompts each time the panel opens
  const [starters] = useState(() => pickSuggestions(3))
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [sheet, setSheet] = useState(false)
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null)
  // a press on the trigger first closes the popover (outside press), then the click fires: remember what was open at press time
  const menuWasOpen = useRef(false)
  const toggleMenu = () => setSheet(!menuWasOpen.current)
  const selection = useEditor((s) => s.selection)
  const listRef = useRef<HTMLDivElement>(null)
  const provider = providerById(settings.active)
  const rows = toRows(items)
  // steps are open while the turn runs and folded away once it ends, unless the user opened them
  const [stepOpen, setStepOpen] = useState<Record<number, boolean>>({})
  const lastRow = rows[rows.length - 1]
  const liveStart = busy && lastRow?.kind === 'steps' ? lastRow.start : null
  // when the current turn started, and how long finished turns took (keyed by their last steps block)
  const [turnStart, setTurnStart] = useState<number | null>(null)
  const [took, setTook] = useState<Record<number, number>>({})
  const turnNow = useNow(busy && liveStart === null)

  /** Show the chat and save it. `withSession` is set once a turn has ended, so the agent context saved with it is complete. */
  const commit = (next: ChatItem[], withSession = false) => {
    live = { docId, id: chatId, items: next }
    setItems(next)
    // the dev demo's items show here but are never saved (saveChat skips a list left empty)
    const kept = next.filter((i) => !('demo' in i && i.demo))
    setChats(saveChat(docId, chatId, kept, withSession ? session.snapshot() : undefined))
  }
  const push = (i: ChatItem) => {
    const items = live?.items ?? []
    // a tool step reported again under the same callId (running -> done) replaces itself
    const callId = i.role === 'tool' ? i.callId : undefined
    const at = callId ? items.findLastIndex((x) => x.role === 'tool' && x.callId === callId) : -1
    commit(at >= 0 ? items.map((x, k) => (k === at ? i : x)) : [...items, i])
  }
  // the dev demo writes into the open chat through this
  useEffect(() => {
    agentChat.push = push
    return () => void (agentChat.push = null)
  })

  const newChat = () => {
    if (busy) return
    session.reset()
    const id = newChatId()
    live = { docId, id, items: [] }
    setChatId(id)
    setItems([])
    setTook({})
    setView('chat')
  }
  const openChat = (c: SavedChat) => {
    if (busy) return
    session.restore(c.session)
    live = { docId, id: c.id, items: c.items }
    setChatId(c.id)
    setItems(c.items)
    setTook({})
    setView('chat')
  }
  const removeChat = (id: string) => {
    setChats(deleteChat(docId, id))
    if (id === chatId) newChat()
  }
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [items])

  const changeSettings = (s: ProviderSettings) => {
    setSettings(s)
    saveProviderSettings(s)
  }

  const [attachments, setAttachments] = useState<ChatImage[]>([])
  const [attachError, setAttachError] = useState('')
  const [dropping, setDropping] = useState(false)
  const dragDepth = useRef(0)
  const attach = async (files: File[]) => {
    if (!files.length) return
    setAttachError('')
    const room = MAX_IMAGES - attachments.length
    if (room <= 0) return setAttachError(`Up to ${MAX_IMAGES} images per message.`)
    const read = await Promise.allSettled(files.slice(0, room).map(fileToChatImage))
    const ok = read.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
    const failed = read.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    setAttachments((a) => [...a, ...ok].slice(0, MAX_IMAGES))
    if (failed) setAttachError((failed.reason as Error)?.message || "Couldn't read that image.")
    else if (files.length > room) setAttachError(`Up to ${MAX_IMAGES} images per message.`)
    document.querySelector<HTMLTextAreaElement>('.k-composer textarea')?.focus()
  }
  const dropHandlers = {
    onDragEnter: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      dragDepth.current++
      setDropping(true)
    },
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    },
    onDragLeave: () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (!dragDepth.current) setDropping(false)
    },
    onDrop: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      dragDepth.current = 0
      setDropping(false)
      void attach(imageFiles(e.dataTransfer.files))
    },
  }

  const send = async (text = input) => {
    const t = text.trim()
    const imgs = attachments
    if ((!t && !imgs.length) || busy) return
    setInput('')
    setAttachments([])
    setAttachError('')
    push(imgs.length ? { role: 'user', text: t, images: imgs } : { role: 'user', text: t })
    setBusy(true)
    const started = Date.now()
    setTurnStart(started)
    agentRun.active = true
    try {
      const prompt = t || (imgs.length > 1 ? 'Take a look at the attached images.' : 'Take a look at the attached image.')
      await session.send(settings, prompt, push, imgs)
    } catch (e) {
      push({ role: 'error', text: (e as Error).message || String(e) })
    } finally {
      agentRun.active = false
      setBusy(false)
      const final = live?.items ?? []
      const lastSteps = toRows(final).findLast((r) => r.kind === 'steps')
      if (lastSteps?.kind === 'steps') setTook((t) => ({ ...t, [lastSteps.start]: Date.now() - started }))
      commit(final, true)
    }
  }

  return (
    <div className="k-agent">
      <div className="k-agent-head">
        <button
          ref={setTrigger}
          className={'k-agent-provider' + (sheet ? ' is-on' : '')}
          onPointerDown={() => (menuWasOpen.current = sheet)}
          onClick={toggleMenu}
          title="Choose agent"
          aria-haspopup="dialog"
          aria-expanded={sheet}
        >
          <span className={'k-dot ' + (busy ? 'is-busy' : 'is-ready')} />
          <ProviderIcon id={provider?.id} />
          <span className="k-agent-provider-name">{provider?.label ?? 'Choose an agent'}</span>
          <ChevronDown size={12} />
        </button>
        <div className="k-row" style={{ gap: 2 }}>
          <button className="k-icon-btn" onClick={newChat} disabled={busy || !items.length} title="New chat" aria-label="New chat">
            <Plus size={14} />
          </button>
          <button
            className={'k-icon-btn' + (view === 'history' ? ' is-on' : '')}
            onClick={() => {
              setSheet(false)
              setView(view === 'history' ? 'chat' : 'history')
            }}
            title="Past chats"
            aria-pressed={view === 'history'}
          >
            <History size={14} />
          </button>
          <button
            className={'k-icon-btn' + (sheet ? ' is-on' : '')}
            onPointerDown={() => (menuWasOpen.current = sheet)}
            onClick={toggleMenu}
            title="Agent settings"
            aria-pressed={sheet}
          >
            <Settings2 size={14} />
          </button>
        </div>
      </div>

      <AgentMenu open={sheet} anchor={trigger} settings={settings} onChange={changeSettings} onClose={() => setSheet(false)} />

      {view === 'history' ? (
        <ChatHistory
          chats={chats}
          activeId={chatId}
          busy={busy}
          onOpen={openChat}
          onDelete={removeChat}
          onBack={() => {
            setView('chat')
            requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.k-composer textarea')?.focus())
          }}
        />
      ) : (
        <>
          <div className="k-agent-list" ref={listRef}>
            {!items.length && (
              <div className="k-ac-empty">
                <div className="k-ac-empty-mark" aria-hidden="true">
                  <KilnMark size={26} />
                </div>
                <h3>What should we make?</h3>
                <p>Describe a layout, ask for real copy, or request a responsive variant. The agent edits this canvas live, and every change is undoable.</p>
                <div className="k-ac-suggest">
                  {starters.map((s) => (
                    <button key={s} onClick={() => setInput(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {rows.map((row) => {
              if (row.kind === 'steps') {
                const live = liveStart === row.start
                return (
                  <StepsBlock
                    key={row.start}
                    steps={row.steps}
                    live={live}
                    startedAt={live ? turnStart : null}
                    tookMs={took[row.start]}
                    open={stepOpen[row.start] ?? live}
                    onToggle={() => setStepOpen((o) => ({ ...o, [row.start]: !(o[row.start] ?? live) }))}
                  />
                )
              }
              const it = row.item
              const i = row.index
              if (it.role === 'user')
                return it.images?.length ? (
                  <div key={i} className="k-msg-user-group">
                    <div className={'k-msg-images' + (it.images.length === 1 ? ' is-single' : '')}>
                      {it.images.map((img) => (
                        <img key={img.id} src={chatImageUrl(img)} alt={img.name} title={img.name} draggable={false} />
                      ))}
                    </div>
                    {it.text && <div className="k-msg k-msg-user">{it.text}</div>}
                  </div>
                ) : (
                  <div key={i} className="k-msg k-msg-user">
                    {it.text}
                  </div>
                )
              if (it.role === 'assistant') return <div key={i} className="k-msg k-msg-agent k-msg-md"><AgentText text={it.text} /></div>
              return (
                <div key={i} className="k-msg k-msg-err">
                  <AlertTriangle size={12} /> {it.role === 'error' ? it.text : ''}
                </div>
              )
            })}
            {busy && liveStart === null && (
              <div className="k-ac-working" role="status">
                <span className="k-ac-steps-state" aria-hidden="true">
                  <i className="k-ac-ring" />
                </span>
                <span className="k-ac-shimmer">Thinking</span>
                {turnStart && <span className="k-ac-steps-meta">{formatElapsed(turnNow - turnStart)}</span>}
              </div>
            )}
          </div>

          <form
            className={'k-composer k-composer-box' + (dropping ? ' is-dropping' : '')}
            onSubmit={(e) => {
              e.preventDefault()
              void send()
            }}
            {...dropHandlers}
          >
            {attachments.length > 0 && (
              <ul className="k-attach-list" aria-label="Attached images">
                {attachments.map((a) => (
                  <li key={a.id} className="k-attach" title={`${a.name} · ${a.width}×${a.height}`}>
                    <img src={chatImageUrl(a)} alt={a.name} draggable={false} />
                    <button type="button" className="k-attach-x" onClick={() => setAttachments((l) => l.filter((x) => x.id !== a.id))} aria-label={`Remove ${a.name}`} title="Remove">
                      <X size={10} strokeWidth={2.5} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <textarea
              rows={2}
              value={input}
              placeholder={
                attachments.length
                  ? 'Say what to do with the image…'
                  : selection.length
                    ? `Ask about ${selection.length} selected layer${selection.length > 1 ? 's' : ''}…`
                    : 'Ask the agent to design or edit…'
              }
              onChange={(e) => setInput(e.target.value)}
              onPaste={(e) => {
                const files = imageFiles(e.clipboardData.files)
                if (!files.length) return
                e.preventDefault()
                void attach(files)
              }}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
            />
            <div className="k-composer-foot">
              <button
                type="button"
                className="k-icon-btn k-composer-attach"
                onClick={() => pickImageFiles((f) => void attach(imageFiles(f)))}
                disabled={attachments.length >= MAX_IMAGES}
                title="Attach images (or paste / drop them here)"
                aria-label="Attach images"
              >
                <ImagePlus size={15} />
              </button>
              {attachError && (
                <span className="k-attach-err" role="status">
                  {attachError}
                </span>
              )}
              {busy ? (
                <button type="button" className="k-send is-stop" onClick={() => session.cancel()} title="Stop">
                  <Square size={12} />
                </button>
              ) : (
                <button type="submit" className="k-send" disabled={!input.trim() && !attachments.length} title="Send">
                  <ArrowUp size={14} />
                </button>
              )}
            </div>
            {dropping && (
              <div className="k-composer-drop" aria-hidden="true">
                <ImagePlus size={16} />
                Drop images to attach
              </div>
            )}
          </form>
        </>
      )}
    </div>
  )
}
