/**
 * In-app replacements for window.prompt / window.confirm.
 *   const name = await askText({ title: 'Rename file', value })
 *   if (await askConfirm({ title: 'Delete file?', danger: true })) …
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

type Req =
  | { kind: 'text'; title: string; body?: ReactNode; value?: string; placeholder?: string; confirmLabel?: string; resolve: (v: string | null) => void }
  | { kind: 'confirm'; title: string; body?: ReactNode; confirmLabel?: string; danger?: boolean; resolve: (v: boolean) => void }

let push: ((r: Req) => void) | null = null
const queue: Req[] = []

export function askText(o: { title: string; body?: ReactNode; value?: string; placeholder?: string; confirmLabel?: string }): Promise<string | null> {
  return new Promise((resolve) => {
    const r: Req = { kind: 'text', ...o, resolve }
    if (push) push(r)
    else queue.push(r)
  })
}

export function askConfirm(o: { title: string; body?: ReactNode; confirmLabel?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    const r: Req = { kind: 'confirm', ...o, resolve }
    if (push) push(r)
    else queue.push(r)
  })
}

export function DialogHost() {
  const [reqs, setReqs] = useState<Req[]>([])
  useEffect(() => {
    push = (r) => setReqs((q) => [...q, r])
    if (queue.length) setReqs(queue.splice(0))
    return () => {
      push = null
    }
  }, [])
  const top = reqs[0]
  if (!top) return null
  const done = (v: unknown) => {
    ;(top.resolve as (x: unknown) => void)(v)
    setReqs((q) => q.slice(1))
  }
  return createPortal(<Dialog key={reqs.length + top.title} req={top} done={done} />, document.body)
}

function Dialog({ req, done }: { req: Req; done: (v: unknown) => void }) {
  const [text, setText] = useState(req.kind === 'text' ? (req.value ?? '') : '')
  const input = useRef<HTMLInputElement>(null)
  const ok = useRef<HTMLButtonElement>(null)
  const cancel = () => done(req.kind === 'text' ? null : false)
  const confirm = () => {
    if (req.kind === 'text') {
      if (!text.trim()) return
      done(text.trim())
    } else done(true)
  }
  useEffect(() => {
    if (req.kind === 'text') {
      input.current?.focus()
      input.current?.select()
    } else ok.current?.focus()
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        e.preventDefault()
        cancel()
      }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div className="k-dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && cancel()}>
      <form
        className="k-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={req.title}
        onKeyDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          confirm()
        }}
      >
        <h2>{req.title}</h2>
        {req.body && <div className="k-dialog-body">{req.body}</div>}
        {req.kind === 'text' && (
          <input ref={input} className="k-dialog-input" value={text} placeholder={req.placeholder} spellCheck={false} autoComplete="off" onChange={(e) => setText(e.target.value)} />
        )}
        <div className="k-dialog-actions">
          <button type="button" className="k-btn-ghost" onClick={cancel}>
            Cancel
          </button>
          <button ref={ok} type="submit" className={req.kind === 'confirm' && req.danger ? 'k-btn-danger' : 'k-btn-primary'} disabled={req.kind === 'text' && !text.trim()}>
            {req.confirmLabel ?? (req.kind === 'text' ? 'Save' : 'OK')}
          </button>
        </div>
      </form>
    </div>
  )
}
