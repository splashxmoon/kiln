/**
 * App-wide replacements for browser chrome:
 *  - TooltipHost: every `title` attribute becomes a Kiln tooltip (the native
 *    one never appears; the text moves to data-tip and, for icon-only
 *    controls, to aria-label). A trailing "(⌘K)" or "(Ctrl+K)" renders as a key chip.
 *  - ContextMenuGuard: no native right-click menu anywhere in the app. Text
 *    fields get Kiln's own Cut / Copy / Paste / Select all menu.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { readClipboardText } from '../platform/clipboard'
import { shortcut } from '../platform/keys'

/* ------------------------------------------------------------------ tooltip */

interface Tip {
  text: string
  keys?: string
  x: number
  y: number
  below: boolean
}

/**
 * A trailing key hint: the Mac form "(⌘K)", "(⇧⌘])", "(⌘\)", or the Windows/Linux form that
 * shortcut() makes, "(Ctrl+Shift+K)", "(Ctrl+\)", "(Alt+C)". Words in brackets ("(beta)") are not keys.
 */
const KEYS_RE = /\s*\(([⌘⇧⌥⌃↵⌫?\][\\'A-Za-z0-9+ ]{1,8}|(?:(?:Ctrl|Alt|Shift)\+)+[^\s()]{1,9})\)\s*$/

function adopt(el: Element): string | null {
  const t = el.getAttribute('title')
  if (t != null) {
    el.removeAttribute('title')
    if (t) {
      el.setAttribute('data-tip', t)
      if (!el.getAttribute('aria-label') && !(el.textContent ?? '').trim()) el.setAttribute('aria-label', t.replace(KEYS_RE, ''))
    }
  }
  return el.getAttribute('data-tip')
}

export function TooltipHost() {
  const [tip, setTip] = useState<Tip | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const state = useRef<{ el: Element | null; timer: number; warmUntil: number }>({ el: null, timer: 0, warmUntil: 0 })

  useEffect(() => {
    const s = state.current
    const hide = () => {
      window.clearTimeout(s.timer)
      if (s.el) s.warmUntil = Date.now() + 350
      s.el = null
      setTip(null)
    }
    const show = (el: Element) => {
      const raw = el.getAttribute('data-tip')
      if (!raw || !el.isConnected) return
      const m = KEYS_RE.exec(raw)
      const r = el.getBoundingClientRect()
      const below = r.bottom + 40 < window.innerHeight
      setTip({ text: m ? raw.slice(0, m.index) : raw, keys: m?.[1], x: r.left + r.width / 2, y: below ? r.bottom + 6 : r.top - 6, below })
    }
    const over = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return
      const target = e.target as Element | null
      const el = target?.closest?.('[title], [data-tip]') ?? null
      if (el) adopt(el)
      if (el === s.el) return
      window.clearTimeout(s.timer)
      if (!el || !el.getAttribute('data-tip') || document.body.classList.contains('k-scrubbing')) {
        if (s.el) hide()
        return
      }
      s.el = el
      setTip(null)
      const warm = Date.now() < s.warmUntil
      s.timer = window.setTimeout(() => show(el), warm ? 40 : 520)
    }
    const focus = (e: FocusEvent) => {
      const el = e.target as Element
      if (!(el instanceof HTMLElement) || !el.matches(':focus-visible')) return
      const host = el.closest('[title], [data-tip]')
      if (!host || !adopt(host)) return
      s.el = host
      window.clearTimeout(s.timer)
      s.timer = window.setTimeout(() => show(host), 300)
    }
    // titles set after mount (e.g. a toggled "Hide"/"Show") are adopted on hover;
    // this also catches title changes on the element under the pointer
    const mo = new MutationObserver((list) => {
      for (const m of list) {
        const el = m.target as Element
        if (!el.hasAttribute('title')) continue
        adopt(el)
        if (el === s.el) show(el)
      }
    })
    mo.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['title'] })
    document.addEventListener('pointerover', over, true)
    document.addEventListener('pointerdown', hide, true)
    document.addEventListener('wheel', hide, { capture: true, passive: true })
    document.addEventListener('keydown', hide, true)
    document.addEventListener('focusin', focus, true)
    document.addEventListener('focusout', hide, true)
    window.addEventListener('blur', hide)
    return () => {
      mo.disconnect()
      document.removeEventListener('pointerover', over, true)
      document.removeEventListener('pointerdown', hide, true)
      document.removeEventListener('wheel', hide, true)
      document.removeEventListener('keydown', hide, true)
      document.removeEventListener('focusin', focus, true)
      document.removeEventListener('focusout', hide, true)
      window.removeEventListener('blur', hide)
    }
  }, [])

  // place once measured: centred on the target, kept inside the viewport, and
  // snapped to whole pixels (a translate(-50%) lands on half pixels and blurs the text)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    if (!tip || !ref.current) return setPos(null)
    const r = ref.current.getBoundingClientRect()
    const m = 8
    const left = Math.max(m, Math.min(tip.x - r.width / 2, window.innerWidth - m - r.width))
    setPos({ left: Math.round(left), top: Math.round(tip.below ? tip.y : tip.y - r.height) })
  }, [tip])

  if (!tip) return null
  return createPortal(
    <div
      ref={ref}
      className={'k-tooltip' + (tip.below ? '' : ' is-above')}
      role="tooltip"
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
    >
      {tip.text}
      {tip.keys && <kbd>{tip.keys}</kbd>}
    </div>,
    document.body,
  )
}

/* ------------------------------------------------------------- context menu */

type Editable = HTMLInputElement | HTMLTextAreaElement | HTMLElement

function isEditable(el: Element | null): el is Editable {
  if (!el) return false
  if (el instanceof HTMLTextAreaElement) return true
  if (el instanceof HTMLInputElement) return !['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit'].includes(el.type)
  return (el as HTMLElement).isContentEditable
}

function selectedText(el: Editable | null): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0)
  return window.getSelection()?.toString() ?? ''
}

interface MenuState {
  x: number
  y: number
  el: Editable | null
  hasSel: boolean
  readOnly: boolean
}

export function ContextMenuGuard() {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onMenu = (e: MouseEvent) => {
      if (e.defaultPrevented) return // a Kiln surface already handled it (canvas, layers…)
      const target = e.target as Element
      if (target.closest?.('.site')) return // the marketing site keeps normal browser behaviour
      e.preventDefault()
      const el = target.closest?.('input, textarea, [contenteditable]') ?? null
      const editable = isEditable(el) ? el : null
      const sel = editable ? selectedText(editable) : (window.getSelection()?.toString() ?? '')
      if (!editable && !sel) return setMenu(null)
      const ro = !!editable && ((editable as HTMLInputElement).readOnly || (editable as HTMLInputElement).disabled)
      if (editable && document.activeElement !== editable) (editable as HTMLElement).focus()
      setMenu({ x: e.clientX, y: e.clientY, el: editable, hasSel: !!sel, readOnly: ro })
    }
    document.addEventListener('contextmenu', onMenu)
    return () => document.removeEventListener('contextmenu', onMenu)
  }, [])

  useEffect(() => {
    if (!menu) return
    const close = (e: Event) => {
      if (e instanceof PointerEvent && ref.current?.contains(e.target as Node)) return
      setMenu(null)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setMenu(null)
      }
    }
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
    }
  }, [menu])

  if (!menu) return null
  const run = async (what: 'cut' | 'copy' | 'paste' | 'selectAll') => {
    const el = menu.el
    setMenu(null)
    if (el) el.focus()
    if (what === 'paste') {
      const text = await readClipboardText()
      if (text != null && el) {
        el.focus()
        document.execCommand('insertText', false, text)
      }
      return
    }
    if (what === 'selectAll') {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.select()
      else if (el) {
        const r = document.createRange()
        r.selectNodeContents(el)
        const s = window.getSelection()
        s?.removeAllRanges()
        s?.addRange(r)
      }
      return
    }
    const text = el ? selectedText(el) : (window.getSelection()?.toString() ?? '')
    if (!document.execCommand(what)) {
      await navigator.clipboard?.writeText(text).catch(() => {})
      if (what === 'cut' && el) document.execCommand('delete')
    }
  }
  const W = 200
  const H = menu.el ? 150 : 40
  const left = Math.min(menu.x, window.innerWidth - W - 8)
  const top = menu.y + H > window.innerHeight - 8 ? Math.max(8, menu.y - H) : menu.y
  const item = (label: string, keys: string, what: 'cut' | 'copy' | 'paste' | 'selectAll', disabled = false) => (
    <button key={what} disabled={disabled} onPointerDown={(e) => e.preventDefault()} onClick={() => void run(what)}>
      <span>{label}</span>
      <kbd>{shortcut(keys)}</kbd>
    </button>
  )
  return createPortal(
    <div ref={ref} className="k-menu k-ctx k-text-menu" style={{ left, top, width: W }} role="menu" onContextMenu={(e) => e.preventDefault()}>
      {menu.el ? (
        <>
          {item('Cut', '⌘X', 'cut', !menu.hasSel || menu.readOnly)}
          {item('Copy', '⌘C', 'copy', !menu.hasSel)}
          {item('Paste', '⌘V', 'paste', menu.readOnly)}
          <div className="k-menu-sep" />
          {item('Select all', '⌘A', 'selectAll')}
        </>
      ) : (
        item('Copy', '⌘C', 'copy')
      )}
    </div>,
    document.body,
  )
}
