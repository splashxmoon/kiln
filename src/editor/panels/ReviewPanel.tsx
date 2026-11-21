/**
 * Design review panel: the issues `runReview` finds on the page (or every page), grouped by
 * rule. Click an issue to select the layer and zoom to it; Fix applies one fix, Fix all the
 * rule's fixes as one undo step. Re-runs shortly after the document changes.
 */
import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, CircleCheck, Wand2 } from 'lucide-react'
import { useEditor, getEditor } from '../store'
import { zoomToFit } from '../Canvas'
import { measureSize } from '../geometry'
import { RULES, runReview, type Issue, type ReviewRule } from '../review'
import { Segmented } from '../ui/controls'
import type { KDoc } from '../types'
import './review.css'

type Scope = 'page' | 'all'
const DEBOUNCE_MS = 300

/** Review the open document now; sizes come from the canvas where the layer is on screen. */
function review(scope: Scope): { issues: Issue[]; doc: KDoc } {
  const s = getEditor()
  return { issues: runReview(s.doc, scope === 'page' ? s.pageId : undefined, { size: measureSize }), doc: s.doc }
}

/** The review, re-run DEBOUNCE_MS after the document, page or scope last changed. */
function useReview(scope: Scope): { issues: Issue[]; doc: KDoc } {
  const doc = useEditor((s) => s.doc)
  const pageId = useEditor((s) => s.pageId)
  const measureTick = useEditor((s) => s.measureTick)
  const [result, setResult] = useState(() => review(scope))
  useEffect(() => {
    const t = setTimeout(() => setResult(review(scope)), DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [doc, pageId, scope, measureTick])
  return result
}

/** Select the layer (switching page if needed) and bring it into view. */
function reveal(nodeId: string) {
  const s = getEditor()
  const n = s.doc.nodes[nodeId]
  if (!n) return
  if (n.pageId !== s.pageId) s.setPage(n.pageId)
  s.select([nodeId])
  requestAnimationFrame(() => zoomToFit([nodeId]))
}

/** Apply fixes from a fresh run of the review, so each fix sees the document (and sizes) as they are now. */
function applyFixes(scope: Scope, issues: Issue[]) {
  const ids = new Set(issues.map((i) => i.id))
  const fixes = review(scope).issues.filter((i) => ids.has(i.id) && i.fix)
  if (!fixes.length) return
  getEditor().update((d) => {
    for (const i of fixes) i.fix!(d)
  })
  getEditor().notify(fixes.length === 1 ? 'Fixed 1 issue' : `Fixed ${fixes.length} issues`)
}

export function ReviewPanel() {
  const [scope, setScope] = useState<Scope>('page')
  const { issues, doc } = useReview(scope)
  const selection = useEditor((s) => s.selection)
  const [closed, setClosed] = useState<Partial<Record<ReviewRule, boolean>>>({})

  const groups = useMemo(
    () => RULES.map((r) => ({ ...r, issues: issues.filter((i) => i.rule === r.rule && doc.nodes[i.nodeId]) })).filter((g) => g.issues.length),
    [issues, doc],
  )
  const errors = issues.filter((i) => i.severity === 'error').length
  const warnings = issues.length - errors

  return (
    <div className="k-review">
      <div className="k-review-top">
        <Segmented
          size="sm"
          value={scope}
          onChange={setScope}
          options={[
            { value: 'page', label: 'This page' },
            { value: 'all', label: 'All pages' },
          ]}
        />
        {issues.length > 0 && (
          <span className="k-review-tally">
            {errors > 0 && <span className="is-error">{errors} {errors === 1 ? 'error' : 'errors'}</span>}
            {warnings > 0 && <span className="is-warning">{warnings} {warnings === 1 ? 'warning' : 'warnings'}</span>}
          </span>
        )}
      </div>

      {groups.length === 0 ? (
        <div className="k-review-empty">
          <CircleCheck size={18} />
          <p>No issues {scope === 'page' ? 'on this page' : 'in this file'}.</p>
          <p className="k-review-empty-sub">Checks contrast, tap targets, tokens, names, alt text, text overflow and hidden or empty frames.</p>
        </div>
      ) : (
        groups.map((g) => {
          const open = !closed[g.rule]
          const fixable = g.issues.filter((i) => i.fix)
          return (
            <section key={g.rule} className="k-section k-review-group">
              <div className="k-section-head">
                <button type="button" className="k-section-title" aria-expanded={open} title={g.hint} onClick={() => setClosed((c) => ({ ...c, [g.rule]: open }))}>
                  <ChevronRight size={12} className={'k-section-chev' + (open ? ' is-open' : '')} />
                  {g.title}
                  <span className="k-review-count">{g.issues.length}</span>
                </button>
                {fixable.length > 1 && (
                  <div className="k-section-actions">
                    <button type="button" className="k-btn-ghost k-sm" onClick={() => applyFixes(scope, fixable)} title={`Apply ${fixable.length} fixes as one undo step`}>
                      <Wand2 size={11} /> Fix all
                    </button>
                  </div>
                )}
              </div>
              {open && (
                <ul className="k-review-list">
                  {g.issues.map((i) => (
                    <li key={i.id} className={'k-review-item' + (selection.includes(i.nodeId) ? ' is-selected' : '')}>
                      <button type="button" className="k-review-main" onClick={() => reveal(i.nodeId)}>
                        <span className={'k-review-dot is-' + i.severity} aria-label={i.severity} />
                        <span className="k-review-text">
                          <span className="k-review-name">{doc.nodes[i.nodeId]?.name}</span>
                          <span className="k-review-msg">{i.message}</span>
                        </span>
                      </button>
                      {i.fix && (
                        <button type="button" className="k-btn-ghost k-sm k-review-fix" onClick={() => applyFixes(scope, [i])}>
                          Fix
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )
        })
      )}
    </div>
  )
}
