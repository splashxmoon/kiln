/** Kiln's own expand/collapse (replaces <details>/<summary>). */
import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

export function Disclosure({ title, children, defaultOpen = false, className = '' }: { title: ReactNode; children: ReactNode; defaultOpen?: boolean; className?: string }) {
  const [open, setOpen] = useState(defaultOpen)
  const id = useId()
  return (
    <div className={'k-disclosure' + (open ? ' is-open' : '') + (className ? ' ' + className : '')}>
      <button type="button" className="k-disclosure-head" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <ChevronRight size={12} />
        {title}
      </button>
      {open && <div id={id}>{children}</div>}
    </div>
  )
}
