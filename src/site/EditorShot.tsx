import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { KilnMark } from '../brand/Logo'
import { ShaderTile } from './ShaderTile'
import type { ShaderKind } from './ShaderTile'

/** Design size of the faux editor; it is scaled to fit and cropped by its stage. */
const W = 980
const H = 640

/** The artboard's background layer cycles slowly: the page's one signature move. */
const LOOKS: { kind: ShaderKind; name: string; colours: string[]; tones: string[]; swatches: string[] }[] = [
  { kind: 'aurora', name: 'Aurora', colours: ['#3B2A4A', '#FF5B1F', '#C9A27E', '#8FB8A8'], tones: ['#3B2A4A', '#FF5B1F', '#C9A27E', '#8FB8A8'], swatches: ['#3B2A4A', '#FF5B1F', '#C9A27E', '#8FB8A8'] },
  { kind: 'halftone', name: 'Halftone', colours: ['#1C1B1A', '#C9A27E', '#FF5B1F'], tones: ['#1C1B1A', '#C9A27E', '#FF5B1F'], swatches: ['#1C1B1A', '#C9A27E', '#FF5B1F'] },
  { kind: 'waves', name: 'Waves', colours: ['#3B2A4A', '#8FB8A8', '#EDE7DC'], tones: ['#3B2A4A', '#8FB8A8', '#C9A27E', '#EDE7DC'], swatches: ['#3B2A4A', '#8FB8A8', '#EDE7DC'] },
]

function useLookCycle(count: number, holdMs = 6200) {
  const [i, setI] = useState(0)
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let t = 0
    const tick = () => {
      if (!document.hidden) setI((v) => (v + 1) % count)
    }
    t = window.setInterval(tick, holdMs)
    return () => window.clearInterval(t)
  }, [count, holdMs])
  return i
}

function Icon({ kind }: { kind: 'frame' | 'row' | 'col' | 'text' | 'shader' | 'page' }) {
  const p: Record<typeof kind, ReactNode> = {
    frame: <path d="M4 1v14M12 1v14M1 4h14M1 12h14" />,
    row: <path d="M2 5h5v6H2zM9 5h5v6H9z" />,
    col: <path d="M5 2h6v5H5zM5 9h6v5H5z" />,
    text: <path d="M3 3h10M8 3v10" />,
    shader: <circle cx="8" cy="8" r="5.5" />,
    page: <path d="M4 2h6l3 3v9H4z" />,
  }
  return (
    <svg className="ed-ico" viewBox="0 0 16 16" aria-hidden="true">
      {p[kind]}
    </svg>
  )
}

function Layer({ depth, kind, name, sel, dim }: { depth: number; kind: Parameters<typeof Icon>[0]['kind']; name: string; sel?: boolean; dim?: string }) {
  return (
    <li className={sel ? 'is-sel' : ''} style={{ '--depth': depth } as CSSProperties}>
      <Icon kind={kind} />
      <span>{name}</span>
      {dim ? <em>{dim}</em> : null}
    </li>
  )
}

function Field({ k, v, wide }: { k: string; v: ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? 'ed-f is-wide' : 'ed-f'}>
      <span>{k}</span>
      <b>{v}</b>
    </div>
  )
}

export function EditorShot() {
  const outer = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0.7)
  const look = useLookCycle(LOOKS.length)

  useLayoutEffect(() => {
    const el = outer.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      // The stage's CSS decides how wide the window is shown (and how far it overflows to be cropped).
      setScale(entry.contentRect.width / W)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const current = LOOKS[look]

  return (
    <div ref={outer} className="ed-outer" style={{ height: H * scale }}>
      <div
        className="ed"
        data-ui
        role="img"
        aria-label="The Kiln editor: a layers panel, a poster artboard on the canvas with its hero frame selected, the inspector showing flex layout and an aurora shader fill, and an agent reply that has just made a mobile variant."
        style={{ width: W, height: H, transform: `scale(${scale})` }}
      >
        <header className="ed-top">
          <span className="ed-lights" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <KilnMark size={16} body="#141413" />
          <span className="ed-file">
            Open studio poster<em>.kiln</em>
          </span>
          <nav className="ed-pages">
            <span className="is-on">Poster</span>
            <span>Mobile</span>
            <span>Notes</span>
          </nav>
          <span className="ed-sp" />
          <span className="ed-kbd">
            <kbd>⌘</kbd>
            <kbd>K</kbd>
          </span>
          <span className="ed-zoom">28%</span>
          <span className="ed-export">Export</span>
        </header>

        <aside className="ed-left">
          <p className="ed-h">Layers</p>
          <ul className="ed-tree">
            <Layer depth={0} kind="frame" name="Poster" dim="1440" />
            <Layer depth={1} kind="row" name="Header" />
            <Layer depth={2} kind="text" name="Studio name" />
            <Layer depth={2} kind="text" name="Date" />
            <Layer depth={1} kind="col" name="Hero" sel />
            <Layer depth={2} kind="shader" name={current.name} />
            <Layer depth={2} kind="text" name="Title" />
            <Layer depth={2} kind="text" name="Details" />
            <Layer depth={1} kind="row" name="Footer" />
            <Layer depth={0} kind="frame" name="Poster, mobile" dim="390" />
          </ul>
          <p className="ed-h">Pages</p>
          <ul className="ed-tree">
            <Layer depth={0} kind="page" name="Poster" sel={false} />
            <Layer depth={0} kind="page" name="Mobile" />
            <Layer depth={0} kind="page" name="Notes" />
          </ul>
        </aside>

        <main className="ed-canvas">
          <p className="ed-label" style={{ left: 32, top: 30 }}>
            Poster <span>1440 × Hug</span>
          </p>
          <div className="ed-board">
            <div className="ed-b-head">
              <span>Saltmarsh Ceramics</span>
              <span>Sat 14 Dec, 10–4</span>
            </div>
            <div className="ed-b-hero">
              {LOOKS.map((l, i) => (
                <div key={l.kind} className={i === look ? 'ed-look is-on' : 'ed-look'}>
                  <ShaderTile kind={l.kind} colours={l.colours} tones={l.tones} speed={0.35} />
                </div>
              ))}
              <p className="ed-b-title">
                Open studio,
                <br />
                kiln unloading
              </p>
              <p className="ed-b-sub">Seconds sale, glaze tests and tea in the yard.</p>
              <span className="ed-sel" aria-hidden="true">
                <i className="h tl" />
                <i className="h tr" />
                <i className="h bl" />
                <i className="h br" />
                <b className="ed-sel-tag">Hero · Fill × Hug</b>
              </span>
            </div>
            <div className="ed-b-foot">
              <span>12 Quay Lane</span>
              <span>Free entry</span>
            </div>
          </div>

          <p className="ed-label" style={{ left: 452, top: 30 }}>
            Mobile <span>390</span>
          </p>
          <div className="ed-board is-mobile">
            <div className="ed-b-head">
              <span>Saltmarsh</span>
            </div>
            <div className="ed-b-hero">
              {LOOKS.map((l, i) => (
                <div key={l.kind} className={i === look ? 'ed-look is-on' : 'ed-look'}>
                  <ShaderTile kind={l.kind} colours={l.colours} tones={l.tones} speed={0.35} />
                </div>
              ))}
              <p className="ed-b-title">
                Open studio,
                <br />
                kiln unloading
              </p>
            </div>
          </div>

          <div className="ed-chat">
            <p className="ed-chat-you">Make a 390 wide variant and tidy the spacing.</p>
            <div className="ed-chat-agent">
              <KilnMark size={14} body="#141413" />
              <div>
                <p>Added “Poster, mobile” with Hero set to fill. Gap 32 to 24 across 4 frames, title 96 to 44.</p>
                <p className="ed-chat-trace">create frame · set styles ×9 · write text</p>
              </div>
            </div>
          </div>
        </main>

        <aside className="ed-right">
          <p className="ed-h">
            Hero <em>Frame</em>
          </p>
          <div className="ed-sec">
            <p className="ed-sh">Layout</p>
            <div className="ed-seg">
              <span>Row</span>
              <span className="is-on">Column</span>
            </div>
            <div className="ed-grid">
              <Field k="W" v="Fill" />
              <Field k="H" v="Hug" />
              <Field k="Gap" v="24" />
              <Field k="Pad" v="64 48" />
            </div>
          </div>
          <div className="ed-sec">
            <p className="ed-sh">Fill</p>
            <div className="ed-shader">
              <span className="ed-shader-name">
                <Icon kind="shader" />
                {current.name}
              </span>
              <span className="ed-sw">
                {current.swatches.map((c) => (
                  <i key={c} style={{ background: c }} />
                ))}
              </span>
            </div>
            <div className="ed-grid">
              <Field k="Speed" v="0.35" />
              <Field k="Scale" v="1.2" />
            </div>
          </div>
          <div className="ed-sec">
            <p className="ed-sh">Text</p>
            <Field wide k="Font" v="Instrument Serif" />
            <div className="ed-grid">
              <Field k="Size" v="96" />
              <Field k="Line" v="0.95" />
            </div>
          </div>
          <div className="ed-sec">
            <p className="ed-sh">Export</p>
            <Field wide k="As" v="React + Tailwind v4" />
          </div>
        </aside>
      </div>
    </div>
  )
}
