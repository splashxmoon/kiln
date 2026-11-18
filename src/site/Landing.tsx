import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent, RefObject } from 'react'
import { KilnLogo, KilnMark } from '../brand/Logo'
import { CodeDemo } from './CodeDemo'
import { EditorShot } from './EditorShot'
import { ShaderTile } from './ShaderTile'
import type { ShaderKind } from './ShaderTile'
import './landing.css'
import { os } from '../platform/os'

/** The download link names the visitor's own OS. */
const DOWNLOAD_LABEL = `Download for ${os === 'windows' ? 'Windows' : os === 'linux' ? 'Linux' : 'Mac'}`

const MCP_COMMAND = 'claude mcp add --transport http kiln http://127.0.0.1:7457/mcp'

const SHADERS: { kind: ShaderKind; name: string; fact: string; colours: string[]; tones?: string[] }[] = [
  { kind: 'aurora', name: 'Aurora', fact: 'Four colour anchors that drift and melt.', colours: ['#3B2A4A', '#FF5B1F', '#C9A27E', '#8FB8A8'] },
  { kind: 'grain', name: 'Grain', fact: 'A soft glow dissolved in film grain.', colours: ['#1C1B1A', '#C9A27E', '#EDE7DC'], tones: ['#FF5B1F', '#C9A27E', '#1C1B1A', '#8FB8A8'] },
  { kind: 'halftone', name: 'Halftone', fact: 'A dot screen that drifts like ink.', colours: ['#141413', '#EDE7DC', '#C9A27E'], tones: ['#141413', '#EDE7DC', '#FF5B1F'] },
  { kind: 'dither', name: 'Dither', fact: 'Moving noise in four ordered tones.', colours: ['#3B2A4A', '#8FB8A8', '#EDE7DC'] },
  { kind: 'ripple', name: 'Ripple', fact: 'Light through a slow liquid surface.', colours: ['#141413', '#8FB8A8', '#EDE7DC'], tones: ['#141413', '#8FB8A8', '#EDE7DC'] },
  { kind: 'voronoi', name: 'Voronoi', fact: 'Soft cells with glowing seams.', colours: ['#1C1B1A', '#8FB8A8', '#C9A27E'] },
  { kind: 'waves', name: 'Waves', fact: 'Bands of colour like layered hills.', colours: ['#3B2A4A', '#EDE7DC', '#FF5B1F'] },
]

const VERBS: { verb: string; detail: string }[] = [
  { verb: 'create frames', detail: 'rows, columns, any nesting' },
  { verb: 'set styles', detail: 'layout, fills, type, effects' },
  { verb: 'write text', detail: 'headings, labels, real copy' },
  { verb: 'read the tree', detail: 'every layer, as structured data' },
  { verb: 'export code', detail: 'in any of the four formats' },
]

const QUICK = ['Responsive variant', 'Tidy spacing', 'Consistency lint', 'Replace placeholder copy']

const d = (n: number) => ({ '--d': n }) as CSSProperties

/** In-page links scroll without touching the hash, which the app uses for routing. */
function jump(e: MouseEvent<HTMLAnchorElement>) {
  const id = e.currentTarget.getAttribute('href')?.slice(1)
  const el = id ? document.getElementById(id) : null
  if (!el) return
  e.preventDefault()
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
  el.focus({ preventScroll: true })
}

function useReveal(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = root.current
    if (!el) return
    const items = Array.from(el.querySelectorAll<HTMLElement>('[data-reveal]'))
    if (!('IntersectionObserver' in window)) return
    el.classList.add('is-armed')
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('is-in')
            io.unobserve(e.target)
          }
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.01 },
    )
    items.forEach((i) => io.observe(i))
    return () => io.disconnect()
  }, [root])
}

function CopyCommand() {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(MCP_COMMAND)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setCopied(false)
    }
  }
  return (
    <div className="term" data-ui>
      <p className="term-bar">
        <span>Terminal</span>
        <button type="button" onClick={copy} aria-live="polite">
          {copied ? 'Copied' : 'Copy command'}
        </button>
      </p>
      <pre>
        <code>
          <span className="tk-k">$</span> {MCP_COMMAND}
        </code>
      </pre>
    </div>
  )
}

function NewFileDialog() {
  const [name, setName] = useState('Spring menu')
  const [start, setStart] = useState<'desktop' | 'mobile'>('desktop')
  return (
    <form
      className="nf"
      data-ui
      aria-label="New file"
      onSubmit={(e) => {
        e.preventDefault()
        try {
          sessionStorage.setItem('kiln:new-file', JSON.stringify({ name, start }))
        } catch {
          /* storage can be unavailable; the route still opens */
        }
        window.location.hash = '#/new'
      }}
    >
      <p className="nf-title">New file</p>
      <label className="nf-field">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
      </label>
      <fieldset className="nf-field">
        <legend>First frame</legend>
        <div className="seg">
          <button type="button" aria-pressed={start === 'desktop'} className={start === 'desktop' ? 'is-on' : ''} onClick={() => setStart('desktop')}>
            Desktop, 1440
          </button>
          <button type="button" aria-pressed={start === 'mobile'} className={start === 'mobile' ? 'is-on' : ''} onClick={() => setStart('mobile')}>
            Mobile, 390
          </button>
        </div>
      </fieldset>
      <div className="nf-foot">
        <a href="#/files">Open existing</a>
        <button type="submit" className="nf-go">
          Create file
        </button>
      </div>
    </form>
  )
}

export default function Landing() {
  const root = useRef<HTMLDivElement>(null)
  useReveal(root)

  return (
    <div className="site" ref={root} id="top">
      <a className="skip" href="#main" onClick={jump}>
        Skip to content
      </a>

      <header className="nav">
        <a href="#top" onClick={jump} className="nav-logo" aria-label="Kiln, back to top">
          <KilnLogo size={26} />
        </a>
        <nav aria-label="Sections">
          <a href="#canvas" onClick={jump}>Canvas</a>
          <a href="#shaders" onClick={jump}>Shaders</a>
          <a href="#agents" onClick={jump}>Agents</a>
          <a href="#download" onClick={jump}>Download</a>
        </nav>
        <a className="btn btn--sm" href="#/files">
          Open in browser
        </a>
      </header>

      <main id="main" tabIndex={-1}>
        {/* Hero: the editor sits inside the kiln's mouth, being fired. */}
        <section className="hero" aria-labelledby="hero-h">
          <div className="hero-copy">
            <h1 id="hero-h" className="display" data-reveal>
              Design in the material you ship.
            </h1>
            <p className="lead" data-reveal style={d(1)}>
              Kiln is a design tool whose canvas is real HTML and CSS. What you shape exports as the same code, and your
              coding agent can work on the file with you.
            </p>
            <div className="hero-actions" data-reveal style={d(2)}>
              <a className="btn" href="#/files">
                Open in browser
              </a>
              <a className="link" href="#/download">
                {DOWNLOAD_LABEL}
              </a>
              <a className="link" href="#/new">
                New file
              </a>
            </div>
            <p className="hero-meta" data-reveal style={d(3)}>
              Desktop app for macOS, Windows and Linux. Web app in any modern browser.
            </p>
          </div>
          <div className="hero-kiln" data-reveal style={d(1)}>
            <div className="kiln-wall">
              <div className="kiln-mouth">
                <ShaderTile
                  kind="aurora"
                  colours={['#141413', '#FF5B1F', '#3B2A4A', '#C9A27E']}
                  tones={['#141413', '#FF5B1F', '#3B2A4A', '#C9A27E']}
                  speed={0.25}
                  className="kiln-fire"
                />
                <EditorShot />
              </div>
            </div>
          </div>
        </section>

        {/* Canvas is code */}
        <section className="sec canvas" id="canvas" tabIndex={-1} aria-label="The canvas is the code">
          <CodeDemo />
        </section>

        {/* Shape, fire, ship */}
        <section className="sec flow" aria-labelledby="flow-h">
          <h2 id="flow-h" className="h2" data-reveal>
            Shape it, fire it, ship it.
          </h2>
          <ol className="flow-bar" data-ui>
            <li className="fl fl--shape" data-reveal style={d(1)}>
              <p className="fl-word">Shape</p>
              <p className="fl-say">
                First, lay out frames on the canvas: hug, fill and fixed sizing, gap, padding, real fonts, CSS effects and
                shader layers, with colour variables for your palette.
              </p>
            </li>
            <li className="fl fl--fire" data-reveal style={d(2)}>
              <p className="fl-word">Fire</p>
              <p className="fl-say">
                Then export: HTML and CSS, React with CSS Modules, React with Tailwind v4, or Vue. Tokens come as CSS
                variables or a Tailwind <code>@theme</code>.
              </p>
            </li>
            <li className="fl fl--ship" data-reveal style={d(3)}>
              <p className="fl-word">Ship</p>
              <p className="fl-say">
                Last, drop it into your repo, or let the agent already working there pull the code over MCP.
              </p>
            </li>
          </ol>
        </section>

        {/* Shaders: the dark section, where the light is made. */}
        <section className="sec shaders" id="shaders" tabIndex={-1} aria-labelledby="shaders-h">
          <div className="shaders-head">
            <h2 id="shaders-h" className="h2" data-reveal>
              Light, fired on the GPU.
            </h2>
            <p className="body" data-reveal style={d(1)}>
              Seven live shader layers sit on the canvas like any other layer. Tweak their colours and motion, then export
              them as dependency-free WebGL.
            </p>
            <div className="shader-panel" data-ui data-reveal style={d(2)} aria-hidden="true">
              <p className="sp-row">
                <span>Shader</span>
                <b>Aurora</b>
              </p>
              <p className="sp-row">
                <span>Colours</span>
                <span className="ed-sw">
                  {SHADERS[0].colours.map((c) => (
                    <i key={c} style={{ background: c }} />
                  ))}
                </span>
              </p>
              <p className="sp-row">
                <span>Speed</span>
                <span className="sp-track">
                  <i style={{ width: '32%' }} />
                </span>
              </p>
              <p className="sp-row">
                <span>Export</span>
                <b>WebGL, no dependencies</b>
              </p>
            </div>
          </div>
          <ul className="tiles">
            {SHADERS.map((s, i) => (
              <li key={s.kind} className={i === 0 ? 'tile is-wide' : 'tile'} data-reveal style={d(i % 4)}>
                <ShaderTile kind={s.kind} colours={s.colours} tones={s.tones} speed={0.5} className="tile-art" label={`${s.name} shader preview`} />
                <p className="tile-name">{s.name}</p>
                <p className="tile-fact">{s.fact}</p>
              </li>
            ))}
          </ul>
        </section>

        {/* Agents and MCP */}
        <section className="sec agents" id="agents" tabIndex={-1} aria-labelledby="agents-h">
          <div className="agents-intro">
            <h2 id="agents-h" className="h2" data-reveal>
              Your agent gets the canvas too.
            </h2>
            <div className="agents-text">
              <p className="body" data-reveal style={d(1)}>
                Kiln doesn’t sell AI. Bring the subscription you already pay for: the desktop app runs Claude Code,
                Codex, Gemini CLI, Cursor Agent or OpenCode under your own login, through a local MCP server that can
                read and edit the file you have open. Or connect your terminal session with one command:
              </p>
              <div data-reveal style={d(2)}>
                <CopyCommand />
              </div>
            </div>
          </div>

          <ul className="verbs" aria-label="What an agent can do on the canvas">
            {VERBS.map((v, i) => (
              <li key={v.verb} data-reveal style={d(i)}>
                <span className="verb">{v.verb}</span>
                <span className="verb-detail">{v.detail}</span>
              </li>
            ))}
          </ul>

          <div className="agents-panel">
            <div className="ap" data-ui data-reveal aria-label="The built-in agent panel with four quick actions">
              <p className="ap-head">
                <KilnMark size={16} body="#EDE7DC" />
                <span>Agent</span>
                <em>Your subscription</em>
              </p>
              <p className="ap-sh">Quick actions on “Poster”</p>
              <ul className="ap-quick">
                {QUICK.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
              <p className="ap-input">Ask for a change to the selection…</p>
            </div>
            <div className="ap-copy">
              <h3 className="h3" data-reveal>
                Or ask from inside Kiln.
              </h3>
              <p className="body" data-reveal style={d(1)}>
                The built-in agent panel talks to whichever agent you pick: a CLI on your own plan, or an API key for
                Anthropic, OpenAI, OpenRouter or a local Ollama model. Quick actions for a responsive variant, tidy
                spacing, a consistency lint and placeholder copy work with no account at all.
              </p>
              <p className="body" data-reveal style={d(2)}>
                In the browser, the same tool API is available on <code>window.kiln</code>, for scripts and browser
                agents.
              </p>
            </div>
          </div>
        </section>

        {/* Download: the first step, already open. */}
        <section className="sec download" id="download" tabIndex={-1} aria-labelledby="download-h">
          <div className="dl-copy">
            <h2 id="download-h" className="display" data-reveal>
              Fire up a file.
            </h2>
            <p className="lead" data-reveal style={d(1)}>
              Start in the browser right now, or get the desktop app to keep <code>.kiln</code> files on disk and let
              your agents in.
            </p>
            <div className="dl-actions" data-reveal style={d(2)}>
              <a className="btn" href="#/download">
                {DOWNLOAD_LABEL}
              </a>
              <a className="link" href="#/files">
                Open in browser
              </a>
            </div>
            <div className="dl-facts" data-reveal style={d(3)}>
              <div>
                <h3 className="h4">Desktop</h3>
                <ul>
                  <li>macOS, Windows and Linux</li>
                  <li>Native shell built in Rust with Tauri</li>
                  <li>Files saved as .kiln on your disk</li>
                  <li>Local MCP server for your agents</li>
                  <li>Runs your Claude, ChatGPT or Gemini plan</li>
                </ul>
              </div>
              <div>
                <h3 className="h4">Browser</h3>
                <ul>
                  <li>Nothing to install</li>
                  <li>Files kept in your browser</li>
                  <li>
                    Tool API on <code>window.kiln</code>
                  </li>
                </ul>
              </div>
              <div>
                <h3 className="h4">In both</h3>
                <ul>
                  <li>Pages, layers and comments</li>
                  <li>Undo and redo</li>
                  <li>A command palette</li>
                  <li>Keyboard-first editing</li>
                </ul>
              </div>
            </div>
          </div>
          <div className="dl-dialog" data-reveal style={d(2)}>
            <NewFileDialog />
          </div>
        </section>
      </main>

      <footer className="foot">
        <div className="foot-mark" aria-hidden="true">
          <KilnMark size={400} body="#EDE7DC" />
          <span className="foot-word">kiln</span>
        </div>
        <div className="foot-cols">
          <nav aria-label="Product">
            <h2 className="h4">Kiln</h2>
            <a href="#/files">Open in browser</a>
            <a href="#/new">New file</a>
            <a href="#/download">{DOWNLOAD_LABEL}</a>
          </nav>
          <nav aria-label="On this page">
            <h2 className="h4">On this page</h2>
            <a href="#canvas" onClick={jump}>Canvas and code</a>
            <a href="#shaders" onClick={jump}>Shader layers</a>
            <a href="#agents" onClick={jump}>Agents and MCP</a>
          </nav>
          <div>
            <h2 className="h4">Exports</h2>
            <p>HTML + CSS</p>
            <p>React + CSS Modules</p>
            <p>React + Tailwind v4</p>
            <p>Vue</p>
          </div>
          <p className="foot-line">Shape it, fire it, ship it.</p>
        </div>
        <div className="foot-last">
          <p>© 2026 Kiln</p>
          <a className="btn btn--sm btn--light" href="#top" onClick={jump}>
            Back to top
          </a>
        </div>
      </footer>
    </div>
  )
}
