/** Kiln's own range slider and checkbox / switch. */
import { useRef } from 'react'
import type { ReactNode } from 'react'
import { Check } from 'lucide-react'

let seq = 0

export function Slider({
  value,
  min = 0,
  max = 1,
  step = 0.01,
  onChange,
  label,
}: {
  value: number
  min?: number
  max?: number
  step?: number
  onChange: (v: number, key: string) => void
  label?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const t = max > min ? (Math.min(max, Math.max(min, value)) - min) / (max - min) : 0
  const snap = (v: number) => {
    const s = Math.round((v - min) / step) * step + min
    return Number(Math.min(max, Math.max(min, s)).toFixed(6))
  }
  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const el = e.currentTarget
    el.focus()
    el.setPointerCapture(e.pointerId)
    const key = 'slider-' + ++seq
    el.classList.add('is-dragging')
    const at = (x: number) => {
      const r = el.getBoundingClientRect()
      const v = snap(min + Math.min(1, Math.max(0, (x - r.left) / r.width)) * (max - min))
      if (v !== value) onChange(v, key)
    }
    at(e.clientX)
    const move = (ev: PointerEvent) => at(ev.clientX)
    const up = () => {
      el.classList.remove('is-dragging')
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }
  return (
    <div
      ref={ref}
      className="k-slider"
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      style={{ ['--t' as string]: t }}
      onPointerDown={down}
      onKeyDown={(e) => {
        const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0
        if (e.key === 'Home') onChange(min, 'slider-key')
        else if (e.key === 'End') onChange(max, 'slider-key')
        else if (d) onChange(snap(value + d * step * (e.shiftKey ? 10 : 1)), 'slider-key')
        else return
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <div className="k-slider-track">
        <div className="k-slider-fill" />
      </div>
      <div className="k-slider-thumb" />
    </div>
  )
}

export function Checkbox({ checked, onChange, children, title }: { checked: boolean; onChange: (v: boolean) => void; children?: ReactNode; title?: string }) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} className={'k-check' + (checked ? ' is-on' : '')} title={title} onClick={() => onChange(!checked)}>
      <span className="k-check-box">{checked && <Check size={10} strokeWidth={3} />}</span>
      {children}
    </button>
  )
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={'k-switch' + (checked ? ' is-on' : '')} onClick={() => onChange(!checked)}>
      <span />
    </button>
  )
}
