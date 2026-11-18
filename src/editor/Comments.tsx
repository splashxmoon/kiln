import { useState } from 'react'
import { X } from 'lucide-react'
import type { Comment } from './types'
import { getEditor } from './store'
import { uid } from './factory'

function ago(t: number) {
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

export function CommentThread({ comment }: { comment: Comment }) {
  const [draft, setDraft] = useState('')
  const composing = !comment.body
  const submit = () => {
    const text = draft.trim()
    if (!text) return
    getEditor().update((d) => {
      const c = d.comments.find((c) => c.id === comment.id)
      if (!c) return
      if (!c.body) c.body = text
      else c.replies.push({ id: uid(6), author: 'You', body: text, createdAt: Date.now() })
    })
    setDraft('')
  }
  const close = () => {
    const s = getEditor()
    if (!comment.body) {
      s.update((d) => {
        d.comments = d.comments.filter((c) => c.id !== comment.id)
      })
    }
    s.set({ activeCommentId: null })
  }
  return (
    <div className="k-thread" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      {!composing && (
        <div className="k-thread-head">
          <span>Thread</span>
          <div className="k-row" style={{ gap: 4 }}>
            <button
              className="k-btn-ghost"
              title="Resolve"
              onClick={() => {
                getEditor().update((d) => {
                  const c = d.comments.find((c) => c.id === comment.id)
                  if (c) c.resolved = true
                })
                getEditor().set({ activeCommentId: null })
              }}
            >
              Resolve
            </button>
            <button className="k-icon-btn" title="Close" onClick={close}>
              <X size={14} />
            </button>
          </div>
        </div>
      )}
      {!composing && (
        <div className="k-thread-list">
          {[{ id: comment.id, author: comment.author, body: comment.body, createdAt: comment.createdAt }, ...comment.replies].map((r) => (
            <div key={r.id} className="k-thread-item">
              <div className="k-avatar" data-agent={r.author === 'Kiln Agent' || undefined}>
                {r.author[0]}
              </div>
              <div>
                <div className="k-thread-meta">
                  <b>{r.author}</b> <span>{ago(r.createdAt)}</span>
                </div>
                <div className="k-thread-body">{r.body}</div>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="k-thread-compose">
        <textarea
          autoFocus
          rows={composing ? 3 : 2}
          placeholder={composing ? 'Leave a comment…' : 'Reply…'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
            if (e.key === 'Escape') close()
          }}
        />
        <div className="k-row" style={{ justifyContent: 'space-between' }}>
          <span className="k-hint">⏎ to send</span>
          <div className="k-row" style={{ gap: 6 }}>
            {composing && (
              <button className="k-btn-ghost k-sm" onClick={close}>
                Cancel
              </button>
            )}
            <button className="k-btn-primary k-btn-sm" onClick={submit} disabled={!draft.trim()}>
              {composing ? 'Comment' : 'Reply'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
