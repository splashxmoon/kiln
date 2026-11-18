/** Kiln's own dropdown: a trigger button plus a keyboard-driven listbox. */
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { Popover } from './Popover'

export interface SelectOption<T> {
  value: T
  label: string
  hint?: string
  icon?: ReactNode
  /** style applied to the option label (e.g. a font preview) */
  style?: CSSProperties
  disabled?: boolean
}

export function Select<T extends string | number>({
  value,
  options,
  onChange,
  width,
  title,
  placeholder = 'Choose…',
  className = '',
  menuWidth,
  disabled,
  onOpen,
  leading,
}: {
  value: T
  options: SelectOption<T>[]
  onChange: (v: T) => void
  width?: number | string
  title?: string
  placeholder?: string
  className?: string
  menuWidth?: number
  disabled?: boolean
  onOpen?: () => void
  /** an icon shown in the closed button before the value (not in the list), e.g. a blend-mode drop */
  leading?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const btn = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const typed = useRef({ s: '', t: 0 })
  const current = options.find((o) => o.value === value)
  const idx = Math.max(0, options.findIndex((o) => o.value === value))

  useEffect(() => {
    if (!open) return
    onOpen?.()
    setActive(idx)
    requestAnimationFrame(() => list.current?.querySelector<HTMLElement>('[data-i="' + idx + '"]')?.scrollIntoView({ block: 'center' }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>('[data-i="' + active + '"]')?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  const pick = (i: number) => {
    const o = options[i]
    if (!o || o.disabled) return
    setOpen(false)
    btn.current?.focus()
    if (o.value !== value) onChange(o.value)
  }

  const step = (from: number, d: number) => {
    let i = from
    for (let n = 0; n < options.length; n++) {
      i = (i + d + options.length) % options.length
      if (!options[i].disabled) return i
    }
    return from
  }

  const onKey = (e: React.KeyboardEvent) => {
    e.stopPropagation()
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault()
        setOpen(true)
      }
      return
    }
    if (e.key === 'ArrowDown') setActive((a) => step(a, 1))
    else if (e.key === 'ArrowUp') setActive((a) => step(a, -1))
    else if (e.key === 'Home') setActive(step(-1, 1))
    else if (e.key === 'End') setActive(step(options.length, -1))
    else if (e.key === 'Enter' || e.key === ' ') pick(active)
    else if (e.key === 'Tab') setOpen(false)
    else if (e.key.length === 1) {
      const now = Date.now()
      typed.current.s = (now - typed.current.t > 700 ? '' : typed.current.s) + e.key.toLowerCase()
      typed.current.t = now
      const hit = options.findIndex((o) => !o.disabled && o.label.toLowerCase().startsWith(typed.current.s))
      if (hit >= 0) setActive(hit)
      return
    } else return
    e.preventDefault()
  }

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={'k-select' + (open ? ' is-open' : '') + (className ? ' ' + className : '')}
        style={width ? { width, flex: 'none' } : undefined}
        title={title}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={onKey}
      >
        {leading != null && <span className="k-select-lead">{leading}</span>}
        {current?.icon}
        <span className="k-select-value" style={current?.style}>
          {current ? current.label : <span className="k-faint">{placeholder}</span>}
        </span>
        <ChevronDown size={12} className="k-select-chev" />
      </button>
      <Popover anchor={btn.current} open={open} onClose={() => setOpen(false)} matchWidth className="k-listbox" role="listbox" label={title} style={menuWidth ? { width: menuWidth } : undefined}>
        <div ref={list} className="k-listbox-scroll" onKeyDown={onKey}>
          {options.map((o, i) => (
            <div
              key={String(o.value)}
              data-i={i}
              role="option"
              aria-selected={o.value === value}
              aria-disabled={o.disabled}
              className={'k-option' + (i === active ? ' is-active' : '') + (o.value === value ? ' is-selected' : '') + (o.disabled ? ' is-disabled' : '')}
              onPointerMove={() => !o.disabled && active !== i && setActive(i)}
              onClick={() => pick(i)}
            >
              <span className="k-option-check">{o.value === value && <Check size={12} strokeWidth={2.25} />}</span>
              {o.icon}
              <span className="k-option-label" style={o.style}>
                {o.label}
              </span>
              {o.hint && <span className="k-option-hint">{o.hint}</span>}
            </div>
          ))}
        </div>
      </Popover>
    </>
  )
}
