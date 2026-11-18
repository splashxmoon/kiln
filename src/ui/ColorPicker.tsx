/**
 * Kiln's colour picker: saturation/value field, hue and alpha rails, hex +
 * alpha inputs, and the document's own colours (tokens + recently used).
 * Every drag is one history step (a stable key per gesture).
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Check, Copy, Pipette } from 'lucide-react'
import { Popover, type Anchor } from './Popover'
import { canPickColor, pickColor } from './eyedropper'
import { hexToHsv, hslToRgb, hsvToHex, hsvToRgb, oklchToRgb, parseColor, rgbToHex, rgbToHsl, rgbToHsv, rgbToOklch, type HSVA, type RGBA } from './color'


export interface Swatch {
  value: string
  label?: string
}

const RECENT_KEY = 'kiln.recentColors'
function loadRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
  } catch {
    return []
  }
}
export function pushRecentColor(hex: string) {
  const list = [hex, ...loadRecent().filter((x) => x !== hex)].slice(0, 16)
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list))
  } catch {
    /* ignore */
  }
}

let gestureSeq = 0

/** Select a field's text when it is clicked into (WebKit's mouseup would otherwise drop the selection). */
let selectPending: EventTarget | null = null
const selectAll = {
  onFocus: (e: React.FocusEvent<HTMLInputElement>) => {
    e.currentTarget.select()
    selectPending = e.currentTarget
  },
  onMouseUp: (e: React.MouseEvent<HTMLInputElement>) => {
    if (selectPending === e.currentTarget) e.preventDefault()
    selectPending = null
  },
}

function useDrag(onMove: (x: number, y: number, key: string) => void, onEnd?: () => void) {
  return (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const key = 'cp-' + ++gestureSeq
    const at = (ev: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect()
      onMove(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)), key)
    }
    at(e)
    const move = (ev: PointerEvent) => at(ev)
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      onEnd?.()
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }
}

export function ColorPicker({
  value,
  onChange,
  alpha,
  onAlpha,
  swatches = [],
  footer,
}: {
  /** any css colour; #RRGGBB(AA) preferred */
  value: string
  /** emits #RRGGBB (or #RRGGBBAA when the picker owns alpha) */
  onChange: (hex: string, key: string) => void
  /** separate opacity (0..1) owned by the caller, e.g. a fill's opacity */
  alpha?: number
  onAlpha?: (a: number, key: string) => void
  swatches?: Swatch[]
  footer?: ReactNode
}) {
  const ownsAlpha = !onAlpha
  const [hsv, setHsv] = useState<HSVA>(() => {
    const c = hexToHsv(value) ?? { h: 0, s: 0, v: 0, a: 1 }
    return { ...c, a: alpha ?? c.a }
  })
  const lastOut = useRef<string>('')
  const [hex, setHex] = useState('')
  const [recent] = useState(loadRecent)
  // the colour when the picker opened: shown beside the new one, click it to go back
  const [previous] = useState(() => {
    const c = parseColor(value) ?? { r: 0, g: 0, b: 0, a: 1 }
    return { ...c, a: alpha ?? c.a }
  })

  // follow external changes (undo, another field) without losing hue on greys
  useEffect(() => {
    const c = parseColor(value)
    if (!c) return
    const outHex = rgbToHex(c, ownsAlpha)
    if (outHex === lastOut.current) return
    const next = hexToHsv(value)!
    setHsv((p) => ({ h: next.s === 0 || next.v === 0 ? p.h : next.h, s: next.v === 0 ? p.s : next.s, v: next.v, a: ownsAlpha ? next.a : (alpha ?? 1) }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])
  useEffect(() => {
    if (!ownsAlpha && alpha != null) setHsv((p) => (p.a === alpha ? p : { ...p, a: alpha }))
  }, [alpha, ownsAlpha])
  useEffect(() => setHex(hsvToHex(hsv).slice(1)), [hsv])

  const emit = (next: HSVA, key: string, alphaChanged = false) => {
    setHsv(next)
    if (alphaChanged && onAlpha) {
      onAlpha(Math.round(next.a * 100) / 100, key)
      return
    }
    const out = hsvToHex(next, ownsAlpha)
    lastOut.current = out
    onChange(out, key)
  }
  const commitRecent = () => pushRecentColor(hsvToHex(hsv, ownsAlpha))

  const sv = useDrag((x, y, key) => emit({ ...hsvRef.current, s: x, v: 1 - y }, key), commitRecent)
  const hue = useDrag((x, _y, key) => emit({ ...hsvRef.current, h: Math.min(359.9, x * 360) }, key), commitRecent)
  const alp = useDrag((x, _y, key) => emit({ ...hsvRef.current, a: Math.round(x * 100) / 100 }, key, true))
  const hsvRef = useRef(hsv)
  hsvRef.current = hsv

  const nudge = (e: React.KeyboardEvent, field: 'sv' | 'h' | 'a') => {
    const k = e.key
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(k)) return
    e.preventDefault()
    e.stopPropagation()
    const big = e.shiftKey ? 10 : 1
    const dx = k === 'ArrowRight' ? 1 : k === 'ArrowLeft' ? -1 : 0
    const dy = k === 'ArrowUp' ? 1 : k === 'ArrowDown' ? -1 : 0
    const c = hsvRef.current
    const key = 'cp-key-' + field
    if (field === 'sv') emit({ ...c, s: Math.min(1, Math.max(0, c.s + (dx * big) / 100)), v: Math.min(1, Math.max(0, c.v + (dy * big) / 100)) }, key)
    if (field === 'h') emit({ ...c, h: (c.h + (dx || dy) * big + 360) % 360 }, key)
    if (field === 'a') emit({ ...c, a: Math.min(1, Math.max(0, Math.round((c.a + ((dx || dy) * big) / 100) * 100) / 100)) }, key, true)
  }

  /** set from a full colour (channel fields, previous, eyedropper); keeps hue on greys */
  const setRgb = (c: RGBA, key: string) => {
    const next = rgbToHsv(c)
    const cur = hsvRef.current
    const merged = { h: next.s === 0 || next.v === 0 ? cur.h : next.h, s: next.v === 0 ? cur.s : next.s, v: next.v, a: c.a }
    const alphaChanged = merged.a !== cur.a
    emit(merged, key)
    if (alphaChanged && onAlpha) onAlpha(merged.a, key + '-a')
    commitRecent()
  }
  const sample = async () => {
    const hex = await pickColor()
    const c = hex && parseColor(hex)
    if (c) setRgb({ ...c, a: hsvRef.current.a }, 'cp-pick-' + ++gestureSeq)
  }

  const pure = hsvToHex({ h: hsv.h, s: 1, v: 1, a: 1 })
  const solid = hsvToHex({ ...hsv, a: 1 })
  const rgb = hsvToRgb(hsv)
  const hsl = rgbToHsl(rgb)
  const lch = rgbToOklch(rgb)
  // greys have no hue of their own: show the one the picker is holding
  if (hsl.s === 0) hsl.h = hsv.h
  const r1 = (n: number) => Math.round(n * 10) / 10
  const prevCss = `rgba(${previous.r},${previous.g},${previous.b},${previous.a})`
  const newCss = `rgba(${rgb.r},${rgb.g},${rgb.b},${hsv.a})`
  const docSwatches = swatches.filter((s, i, a) => a.findIndex((x) => x.value === s.value) === i)
  const recentShown = recent.filter((r) => !docSwatches.some((s) => s.value === r)).slice(0, 16 - Math.min(8, docSwatches.length))

  return (
    <div className="k-cp" onKeyDown={(e) => e.stopPropagation()}>
      <div
        className="k-cp-sv"
        style={{ background: pure }}
        onPointerDown={sv}
        tabIndex={0}
        role="slider"
        aria-label="Saturation and brightness"
        aria-valuetext={`${Math.round(hsv.s * 100)}% saturation, ${Math.round(hsv.v * 100)}% brightness`}
        onKeyDown={(e) => nudge(e, 'sv')}
      >
        <div className="k-cp-sv-white" />
        <div className="k-cp-sv-black" />
        <div className="k-cp-thumb" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: solid }} />
      </div>
      <div className="k-cp-rails">
        {canPickColor() && (
          <button type="button" className="k-cp-pick" title="Pick a colour from the canvas" aria-label="Eyedropper" onClick={sample}>
            <Pipette size={14} />
          </button>
        )}
        <div className="k-cp-rail-stack">
          <div className="k-cp-rail k-cp-hue" onPointerDown={hue} tabIndex={0} role="slider" aria-label="Hue" aria-valuenow={Math.round(hsv.h)} aria-valuemin={0} aria-valuemax={360} onKeyDown={(e) => nudge(e, 'h')}>
            <div className="k-cp-rail-thumb" style={{ left: `${(hsv.h / 360) * 100}%`, background: pure }} />
          </div>
          <div className="k-cp-rail k-cp-alpha" onPointerDown={alp} tabIndex={0} role="slider" aria-label="Opacity" aria-valuenow={Math.round(hsv.a * 100)} aria-valuemin={0} aria-valuemax={100} onKeyDown={(e) => nudge(e, 'a')}>
            <div className="k-cp-alpha-fill" style={{ background: `linear-gradient(90deg, transparent, ${solid})` }} />
            <div className="k-cp-rail-thumb" style={{ left: `${hsv.a * 100}%` }}>
              <span style={{ background: newCss }} />
            </div>
          </div>
        </div>
      </div>
      <div className="k-cp-compare">
        <button type="button" className="k-cp-compare-swatch" title="Back to the previous colour" aria-label="Previous colour" onClick={() => setRgb(previous, 'cp-prev-' + ++gestureSeq)}>
          <span style={{ background: prevCss }} />
        </button>
        <span className="k-cp-compare-swatch is-new" aria-hidden>
          <span style={{ background: newCss }} />
        </span>
        <span className="k-cp-compare-label">Previous</span>
        <span className="k-cp-compare-label">New</span>
      </div>
      <ChannelRow
        labels={['L', 'C', 'H']}
        values={[r1(lch.l), Math.round(lch.c * 1000) / 1000, r1(lch.h)]}
        steps={[1, 0.01, 1]}
        limits={[[0, 100], [0, 0.4], [0, 360]]}
        copy={`oklch(${r1(lch.l)}% ${Math.round(lch.c * 1000) / 1000} ${r1(lch.h)}${hsv.a < 1 ? ` / ${Math.round(hsv.a * 100)}%` : ''})`}
        onCommit={(i, v, key) => {
          const next = { ...lch, [(['l', 'c', 'h'] as const)[i]]: v }
          setRgb(oklchToRgb(next, hsv.a), key)
        }}
      />
      <ChannelRow
        labels={['H', 'S', 'L']}
        values={[r1(hsl.h), r1(hsl.s), r1(hsl.l)]}
        steps={[1, 1, 1]}
        limits={[[0, 360], [0, 100], [0, 100]]}
        copy={`hsl(${r1(hsl.h)} ${r1(hsl.s)}% ${r1(hsl.l)}%${hsv.a < 1 ? ` / ${Math.round(hsv.a * 100)}%` : ''})`}
        onCommit={(i, v, key) => {
          const next = { ...hsl, [(['h', 's', 'l'] as const)[i]]: v }
          setRgb(hslToRgb(next, hsv.a), key)
        }}
      />
      <ChannelRow
        labels={['R', 'G', 'B']}
        values={[rgb.r, rgb.g, rgb.b]}
        steps={[1, 1, 1]}
        limits={[[0, 255], [0, 255], [0, 255]]}
        copy={`rgb(${rgb.r} ${rgb.g} ${rgb.b}${hsv.a < 1 ? ` / ${Math.round(hsv.a * 100)}%` : ''})`}
        onCommit={(i, v, key) => {
          const next = { ...rgb, [(['r', 'g', 'b'] as const)[i]]: Math.round(v) }
          setRgb({ ...next, a: hsv.a }, key)
        }}
      />
      <div className="k-cp-fields">
        <label className="k-cp-hex">
          <span>#</span>
          <input
            value={hex}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setHex(e.target.value.replace(/[^0-9a-f]/gi, '').slice(0, 8).toUpperCase())}
            {...selectAll}
            onBlur={() => {
              const c = parseColor('#' + hex)
              if (!c) return setHex(hsvToHex(hsv).slice(1))
              const next = hexToHsv(rgbToHex(c, true))!
              const merged = { ...next, a: hex.length === 8 || hex.length === 4 ? next.a : hsv.a }
              emit(merged, 'cp-hex-' + ++gestureSeq)
              if (merged.a !== hsv.a && onAlpha) onAlpha(merged.a, 'cp-hexa-' + gestureSeq)
              commitRecent()
            }}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') e.currentTarget.blur()
            }}
          />
        </label>
        <label className="k-cp-a">
          <input
            value={Math.round(hsv.a * 100)}
            inputMode="numeric"
            spellCheck={false}
            autoComplete="off"
            {...selectAll}
            onChange={(e) => {
              const n = Number(e.target.value.replace(/[^\d]/g, ''))
              if (Number.isFinite(n)) emit({ ...hsv, a: Math.min(100, Math.max(0, n)) / 100 }, 'cp-a-input', true)
            }}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault()
                const d = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1)
                emit({ ...hsv, a: Math.min(100, Math.max(0, Math.round(hsv.a * 100) + d)) / 100 }, 'cp-a-arrow', true)
              }
            }}
          />
          <span>%</span>
        </label>
      </div>
      {(docSwatches.length > 0 || recentShown.length > 0) && (
        <div className="k-cp-swatches">
          {docSwatches.length > 0 && <div className="k-cp-swatch-title">In this file</div>}
          <div className="k-cp-swatch-grid">
            {docSwatches.slice(0, 24).map((s) => (
              <SwatchButton key={'d' + s.value} s={s} onPick={(v) => pickSwatch(v)} />
            ))}
          </div>
          {recentShown.length > 0 && <div className="k-cp-swatch-title">Recent</div>}
          <div className="k-cp-swatch-grid">
            {recentShown.map((v) => (
              <SwatchButton key={'r' + v} s={{ value: v }} onPick={(x) => pickSwatch(x)} />
            ))}
          </div>
        </div>
      )}
      {footer}
    </div>
  )

  function pickSwatch(v: string) {
    const next = hexToHsv(v)
    if (!next) return
    const key = 'cp-sw-' + ++gestureSeq
    const merged = ownsAlpha ? next : { ...next, a: hsv.a }
    emit(merged, key)
  }
}

/** Three numeric channels (with their letters under them) and a copy button. */
function ChannelRow({
  labels,
  values,
  steps,
  limits,
  copy,
  onCommit,
}: {
  labels: [string, string, string]
  values: number[]
  steps: number[]
  limits: [number, number][]
  copy: string
  onCommit: (index: number, value: number, key: string) => void
}) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="k-cp-channels">
      {values.map((v, i) => (
        <ChannelInput key={labels[i] + i} label={labels[i]} value={v} step={steps[i]} min={limits[i][0]} max={limits[i][1]} onCommit={(n, key) => onCommit(i, n, key)} />
      ))}
      <button
        type="button"
        className="k-cp-copy"
        title={'Copy ' + copy}
        aria-label={'Copy ' + labels.join('')}
        onClick={() => {
          void navigator.clipboard?.writeText(copy).catch(() => {})
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1200)
        }}
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </div>
  )
}

function ChannelInput({ label, value, step, min, max, onCommit }: { label: string; value: number; step: number; min: number; max: number; onCommit: (v: number, key: string) => void }) {
  const [text, setText] = useState(String(value))
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (!editing) setText(String(value))
  }, [value, editing])
  const commit = (raw: string) => {
    const n = parseFloat(raw)
    if (!Number.isFinite(n)) return setText(String(value))
    const v = Math.min(max, Math.max(min, n))
    if (v !== value) onCommit(v, 'cp-ch-' + label + '-' + ++gestureSeq)
  }
  return (
    <label className="k-cp-channel">
      <input
        value={text}
        inputMode="decimal"
        spellCheck={false}
        autoComplete="off"
        aria-label={label}
        onFocus={(e) => {
          setEditing(true)
          selectAll.onFocus(e)
        }}
        onMouseUp={selectAll.onMouseUp}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => {
          setEditing(false)
          commit(e.currentTarget.value)
        }}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            setText(String(value))
            setEditing(false)
          }
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            const d = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1)
            const v = Math.min(max, Math.max(min, Math.round(((parseFloat(text) || 0) + d) * 1000) / 1000))
            setText(String(v))
            onCommit(v, 'cp-ch-arrow-' + label)
          }
        }}
      />
      <span>{label}</span>
    </label>
  )
}

function SwatchButton({ s, onPick }: { s: Swatch; onPick: (v: string) => void }) {
  return (
    <button type="button" className="k-cp-swatch" style={{ ['--sw' as string]: s.value }} title={s.label ? `${s.label} · ${s.value}` : s.value} onClick={() => onPick(s.value)} />
  )
}

/** A swatch button that opens the picker in a popover. */
export function ColorSwatchButton({
  value,
  onChange,
  alpha,
  onAlpha,
  swatches,
  label = 'Pick colour',
  className = 'k-swatch',
  placement = 'left-start',
}: {
  value: string
  onChange: (hex: string, key: string) => void
  alpha?: number
  onAlpha?: (a: number, key: string) => void
  swatches?: Swatch[] | (() => Swatch[])
  label?: string
  className?: string
  placement?: 'left-start' | 'bottom-start' | 'right-start'
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  const [anchor, setAnchor] = useState<Anchor>(null)
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={className + (open ? ' is-open' : '')}
        style={{ ['--sw' as string]: value }}
        aria-label={label}
        aria-expanded={open}
        onClick={() => {
          // anchor the picker to the whole field row when there is one
          setAnchor((ref.current?.closest('.k-color, .k-token-row') as HTMLElement) ?? ref.current)
          setOpen(!open)
        }}
      />
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement={placement} offset={10} className="k-cp-pop" label={label}>
        <ColorPicker value={value} onChange={onChange} alpha={alpha} onAlpha={onAlpha} swatches={typeof swatches === 'function' ? swatches() : swatches} />
      </Popover>
    </>
  )
}
