import { useId, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'

type Sizing = 'hug' | 'fill' | 'fixed'
type Format = 'html' | 'module' | 'tailwind' | 'vue'

const FORMATS: { id: Format; label: string; file: string }[] = [
  { id: 'html', label: 'HTML + CSS', file: 'buy-row.html' },
  { id: 'module', label: 'React + CSS Modules', file: 'BuyRow.tsx' },
  { id: 'tailwind', label: 'React + Tailwind v4', file: 'BuyRow.tsx' },
  { id: 'vue', label: 'Vue', file: 'BuyRow.vue' },
]

const SIZING_CSS: Record<Sizing, string> = {
  hug: 'flex: none;',
  fill: 'flex: 1 1 0;',
  fixed: 'flex: none; width: 168px;',
}
const SIZING_TW: Record<Sizing, string> = { hug: 'flex-none', fill: 'flex-1', fixed: 'w-42 flex-none' }

/** Each export as lines; a line wrapped in «» is the one the sizing control changes. */
function source(format: Format, s: Sizing): string[] {
  const css = SIZING_CSS[s]
  switch (format) {
    case 'html':
      return [
        '<div class="buy-row">',
        '  <span class="price">£32</span>',
        '  <a class="button" href="/cart">Add to bag</a>',
        '</div>',
        '',
        '.buy-row {',
        '  display: flex;',
        '  align-items: center;',
        '  gap: 16px;',
        '}',
        '.button {',
        `«  ${css}»`,
        '  padding: 12px 20px;',
        '  border-radius: 999px;',
        '  background: var(--clay-900);',
        '}',
      ]
    case 'module':
      return [
        "import s from './BuyRow.module.css'",
        '',
        'export function BuyRow() {',
        '  return (',
        '    <div className={s.buyRow}>',
        '      <span className={s.price}>£32</span>',
        '      <a className={s.button} href="/cart">',
        '        Add to bag',
        '      </a>',
        '    </div>',
        '  )',
        '}',
        '',
        '/* BuyRow.module.css */',
        '.buyRow { display: flex; align-items: center; gap: 16px; }',
        `«.button { ${css} padding: 12px 20px; }»`,
      ]
    case 'tailwind':
      return [
        'export function BuyRow() {',
        '  return (',
        '    <div className="flex items-center gap-4">',
        '      <span className="text-lg font-medium">£32</span>',
        '      <a',
        '        href="/cart"',
        `«        className="${SIZING_TW[s]} rounded-full bg-clay-900 px-5 py-3"»`,
        '      >',
        '        Add to bag',
        '      </a>',
        '    </div>',
        '  )',
        '}',
      ]
    case 'vue':
      return [
        '<template>',
        '  <div class="buy-row">',
        '    <span class="price">£32</span>',
        '    <a class="button" href="/cart">Add to bag</a>',
        '  </div>',
        '</template>',
        '',
        '<style scoped>',
        '.buy-row { display: flex; align-items: center; gap: 16px; }',
        `«.button { ${css} padding: 12px 20px; }»`,
        '</style>',
      ]
  }
}

const TOKEN = /(\/\*.*?\*\/)|("[^"]*"|'[^']*')|(<\/?[A-Za-z][\w.-]*|\/?>)|([a-z-]+)(?=\s*:)|(\b\d+(?:px)?\b|£\d+)|(\b(?:import|from|export|function|return)\b)/g

function highlight(line: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  for (const m of line.matchAll(TOKEN)) {
    const i = m.index ?? 0
    if (i > last) out.push(line.slice(last, i))
    const cls = m[1] ? 'tk-c' : m[2] ? 'tk-s' : m[3] ? 'tk-t' : m[4] ? 'tk-p' : m[5] ? 'tk-n' : 'tk-k'
    out.push(
      <span key={i} className={cls}>
        {m[0]}
      </span>,
    )
    last = i + m[0].length
  }
  if (last < line.length) out.push(line.slice(last))
  return out
}

export function CodeDemo() {
  const [format, setFormat] = useState<Format>('html')
  const [sizing, setSizing] = useState<Sizing>('fill')
  const id = useId()
  const lines = source(format, sizing)
  const current = FORMATS.find((f) => f.id === format)!

  return (
    <div className="cd">
      <figure className="cd-stage" data-reveal>
        <div className="cd-arch">
          <div className="cd-card" data-ui aria-label="A product card designed on the Kiln canvas">
            <div className="cd-art" aria-hidden="true">
              <svg viewBox="0 0 120 100">
                <path d="M88 38h8a14 14 0 0 1 0 28h-8" fill="none" stroke="#8FB8A8" strokeWidth="7" />
                <path d="M18 22h72v50a18 18 0 0 1-18 18H36a18 18 0 0 1-18-18Z" fill="#8FB8A8" />
                <path d="M18 34h72" stroke="#7aa595" strokeWidth="3" />
                <ellipse cx="54" cy="94" rx="40" ry="3" fill="#2a1e36" />
              </svg>
            </div>
            <p className="cd-title">Celadon mug</p>
            <p className="cd-text">Wood-fired stoneware, 340 ml.</p>
            <div className={`cd-row is-${sizing}`}>
              <span className="cd-price">£32</span>
              <span className="cd-button">
                Add to bag
                <i className="cd-sel" aria-hidden="true">
                  <b className="cd-badge">
                    Button · {sizing === 'fixed' ? '168' : sizing === 'fill' ? 'Fill' : 'Hug'} × Hug
                  </b>
                </i>
              </span>
            </div>
          </div>
        </div>
        <figcaption className="cd-control" data-ui>
          <span id={`${id}-w`}>Width</span>
          <div role="radiogroup" aria-labelledby={`${id}-w`} className="seg">
            {(['hug', 'fill', 'fixed'] as Sizing[]).map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={sizing === v}
                className={sizing === v ? 'is-on' : ''}
                onClick={() => setSizing(v)}
              >
                {v === 'hug' ? 'Hug' : v === 'fill' ? 'Fill' : 'Fixed'}
              </button>
            ))}
          </div>
        </figcaption>
      </figure>

      <div className="cd-copy">
        <h2 className="h2" data-reveal>
          The canvas is the code.
        </h2>
        <p className="lead" data-reveal style={{ '--d': 1 } as CSSProperties}>
          Every frame in Kiln is a DOM element laid out with real flexbox: hug, fill or fixed sizing, gap and padding,
          real fonts, real CSS effects. Nothing is translated on the way out, so the export is exact.
        </p>

        <div className="cd-code" data-reveal style={{ '--d': 2 } as CSSProperties}>
          <div className="cd-tabs" role="tablist" aria-label="Export format">
            {FORMATS.map((f) => (
              <button
                key={f.id}
                type="button"
                role="tab"
                id={`${id}-tab-${f.id}`}
                aria-selected={format === f.id}
                aria-controls={`${id}-panel`}
                tabIndex={format === f.id ? 0 : -1}
                className={format === f.id ? 'is-on' : ''}
                onClick={() => setFormat(f.id)}
                onKeyDown={(e) => {
                  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
                  const i = FORMATS.findIndex((x) => x.id === format)
                  const next = FORMATS[(i + (e.key === 'ArrowRight' ? 1 : FORMATS.length - 1)) % FORMATS.length]
                  setFormat(next.id)
                  document.getElementById(`${id}-tab-${next.id}`)?.focus()
                }}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div
            className="cd-panel"
            role="tabpanel"
            id={`${id}-panel`}
            aria-labelledby={`${id}-tab-${format}`}
            tabIndex={0}
          >
            <p className="cd-file">
              <span>{current.file}</span>
              <span>Buy row · exported</span>
            </p>
            <pre>
              <code key={format}>
                {lines.map((raw, i) => {
                  const hot = raw.startsWith('«')
                  const text = raw.replace(/[«»]/g, '')
                  return (
                    <span key={i} className={hot ? 'ln is-hot' : 'ln'}>
                      {text ? highlight(text) : ' '}
                      {'\n'}
                    </span>
                  )
                })}
              </code>
            </pre>
          </div>
        </div>
        <p className="note" data-reveal style={{ '--d': 3 } as CSSProperties}>
          Colour variables come along as CSS custom properties, or as a Tailwind <code>@theme</code> block.
        </p>
      </div>
    </div>
  )
}
