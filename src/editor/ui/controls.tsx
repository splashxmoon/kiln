import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ChevronRight, Link2 } from 'lucide-react'
import { ColorSwatchButton, type Swatch } from '../../ui/ColorPicker'
import { getEditor } from '../store'

/* ------------------------------------------------------------ NumberField */

function evalExpr(input: string, current: number): number | null {
  const s = input.trim()
  if (!s) return null
  // relative ops like "+10", "*2"
  const rel = /^([+\-*/])\s*(-?\d*\.?\d+)$/.exec(s)
  if (rel && !/^-\d/.test(s)) {
    const v = parseFloat(rel[2])
    switch (rel[1]) {
      case '+':
        return current + v
      case '-':
        return current - v
      case '*':
        return current * v
      case '/':
        return v ? current / v : current
    }
  }
  if (!/^[\d\s+\-*/().]+$/.test(s)) return null
  try {
    // safe-ish: only digits and operators allowed by the regex above
    const v = Function(`"use strict";return (${s})`)() as number
    return Number.isFinite(v) ? v : null
  } catch {
    return null
  }
}

export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  precision = 0,
  suffix,
  title,
  disabled,
  mixed,
  placeholder,
  width,
}: {
  label?: ReactNode
  value: number
  onChange: (v: number, key: string) => void
  min?: number
  max?: number
  step?: number
  precision?: number
  suffix?: string
  title?: string
  disabled?: boolean
  mixed?: boolean
  placeholder?: string
  width?: number | string
}) {
  const fmt = (v: number) => {
    const p = Math.pow(10, precision)
    return String(Math.round(v * p) / p)
  }
  const [text, setText] = useState(mixed ? '' : fmt(value))
  const [focused, setFocused] = useState(false)
  const keyRef = useRef('nf-' + Math.random().toString(36).slice(2))
  useEffect(() => {
    if (!focused) setText(mixed ? '' : fmt(value))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, focused, mixed])

  const clamp = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v))
  const commit = (raw: string) => {
    const v = evalExpr(raw, value)
    if (v == null) {
      setText(fmt(value))
      return
    }
    onChange(clamp(v), keyRef.current + Date.now())
  }

  const onScrub = (e: React.PointerEvent) => {
    if (disabled) return
    e.preventDefault()
    const startX = e.clientX
    const start = value
    let last = start
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    document.body.classList.add('k-scrubbing')
    const key = keyRef.current + '-scrub-' + Date.now()
    const move = (ev: PointerEvent) => {
      const mult = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1
      const v = clamp(start + Math.round((ev.clientX - startX) / 2) * step * mult)
      const r = Math.round(v / (step * (ev.altKey ? 0.1 : 1))) * step * (ev.altKey ? 0.1 : 1)
      if (r !== last) {
        last = r
        onChange(Number(r.toFixed(4)), key)
      }
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      document.body.classList.remove('k-scrubbing')
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  return (
    <label className={'k-num' + (disabled ? ' is-disabled' : '')} title={title} style={width ? { width } : undefined}>
      {label != null && (
        <span className="k-num-label" onPointerDown={onScrub}>
          {label}
        </span>
      )}
      <input
        value={text}
        spellCheck={false}
        autoComplete="off"
        inputMode="decimal"
        placeholder={mixed ? 'Mixed' : placeholder}
        disabled={disabled}
        onFocus={(e) => {
          setFocused(true)
          e.currentTarget.select()
        }}
        onBlur={(e) => {
          setFocused(false)
          commit(e.currentTarget.value)
        }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit((e.target as HTMLInputElement).value)
            ;(e.target as HTMLInputElement).blur()
          } else if (e.key === 'Escape') {
            setText(fmt(value))
            ;(e.target as HTMLInputElement).blur()
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            const d = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1)
            const v = clamp(value + d)
            onChange(v, keyRef.current + '-arrow')
            setText(fmt(v))
          }
        }}
      />
      {suffix && <span className="k-num-suffix">{suffix}</span>}
    </label>
  )
}

/* ------------------------------------------------------------ Color */

export function normalizeHex(v: string): string | null {
  let s = v.trim().replace(/^#/, '')
  if (/^[0-9a-f]{3}$/i.test(s)) s = s.split('').map((c) => c + c).join('')
  if (/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(s)) return '#' + s.toUpperCase()
  return null
}

/** colours already used in the open document: tokens first, then solid fills / text */
function documentSwatches(): Swatch[] {
  const doc = getEditor().doc
  const out: Swatch[] = doc.tokens.map((t) => ({ value: t.value, label: t.name }))
  const seen = new Set(out.map((s) => s.value.toUpperCase()))
  const add = (c?: string) => {
    if (!c || !c.startsWith('#')) return
    const k = c.toUpperCase()
    if (seen.has(k) || out.length >= 24) return
    seen.add(k)
    out.push({ value: k })
  }
  for (const n of Object.values(doc.nodes)) {
    for (const f of n.fills) if (f.type === 'solid' && !f.tokenId) add(f.color)
    if (n.text && !n.text.tokenId) add(n.text.color)
  }
  return out
}

/** best-effort conversion of any css colour to #RRGGBB */
export function toHex6(color: string): string {
  const n = normalizeHex(color)
  if (n) return n.slice(0, 7)
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(color)
  if (m) return '#' + [m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('').toUpperCase()
  return '#000000'
}

export function ColorField({
  value,
  onChange,
  opacity,
  onOpacity,
  tokenName,
  onDetachToken,
  onPickToken,
}: {
  value: string
  onChange: (hex: string, key: string) => void
  opacity?: number
  onOpacity?: (v: number, key: string) => void
  tokenName?: string
  onDetachToken?: () => void
  onPickToken?: () => void
}) {
  const [text, setText] = useState(value)
  const keyRef = useRef('cf-' + Math.random().toString(36).slice(2))
  useEffect(() => setText(value.replace(/^#/, '').toUpperCase()), [value])
  return (
    <div className="k-color">
      <ColorSwatchButton
        value={value}
        onChange={(hex, k) => onChange(hex, keyRef.current + k)}
        alpha={opacity}
        onAlpha={onOpacity ? (a, k) => onOpacity(a, keyRef.current + k) : undefined}
        swatches={documentSwatches}
      />
      {tokenName ? (
        <button className="k-token-chip" onClick={onDetachToken} title="Detach token">
          {tokenName}
        </button>
      ) : (
        <input
          className="k-color-hex"
          value={text}
          spellCheck={false}
          autoComplete="off"
          aria-label="Hex colour"
          onChange={(e) => setText(e.target.value)}
          onBlur={(e) => {
            const h = normalizeHex(e.currentTarget.value)
            if (h) onChange(h, keyRef.current + Date.now())
            else setText(value.replace(/^#/, ''))
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      )}
      {onOpacity && opacity != null && (
        <NumberField value={Math.round(opacity * 100)} onChange={(v, k) => onOpacity(v / 100, k)} min={0} max={100} suffix="%" width={58} />
      )}
      {onPickToken && !tokenName && (
        <button className="k-icon-btn k-sm" title="Use a token" onClick={onPickToken}>
          <Link2 size={12} />
        </button>
      )}
    </div>
  )
}

/* ------------------------------------------------------------ Segmented / Select */

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = 'md',
}: {
  value: T | null
  options: { value: T; label: ReactNode; title?: string }[]
  onChange: (v: T) => void
  size?: 'sm' | 'md'
}) {
  return (
    <div className={'k-seg k-seg-' + size} role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          className={value === o.value ? 'is-on' : ''}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export { Select } from '../../ui/Select'

/* ------------------------------------------------------------ Section */

export function Section({ title, actions, children, collapsible, defaultOpen = true }: { title: ReactNode; actions?: ReactNode; children?: ReactNode; collapsible?: boolean; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="k-section">
      <header className="k-section-head">
        <button className="k-section-title" onClick={() => collapsible && setOpen(!open)} disabled={!collapsible} aria-expanded={collapsible ? open : undefined}>
          {title}
          {collapsible && <ChevronRight size={12} className={'k-section-chev' + (open ? ' is-open' : '')} />}
        </button>
        <div className="k-section-actions">{actions}</div>
      </header>
      {open && children && <div className="k-section-body">{children}</div>}
    </section>
  )
}

export function Row({ children, gap = 6 }: { children: ReactNode; gap?: number }) {
  return (
    <div className="k-row" style={{ gap }}>
      {children}
    </div>
  )
}
