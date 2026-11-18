import { Component, useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentType, CSSProperties, ReactNode } from 'react'

/**
 * A live shader layer with a CSS fallback underneath.
 *
 * The real renderer (`src/shaders/ShaderCanvas.tsx`) is being written by a teammate. It is
 * loaded through `import.meta.glob`, which resolves to an empty map when the file does not
 * exist yet, so the page builds and looks finished either way. The fallback paints first and
 * stays underneath; the canvas covers it once it mounts.
 */

export type ShaderKind = 'aurora' | 'grain' | 'halftone' | 'dither' | 'ripple' | 'voronoi' | 'waves'
type Spec = { kind: ShaderKind; params: Record<string, number | string>; speed: number }
type CanvasProps = { spec: Spec; className?: string; style?: CSSProperties }

type CanvasModule = { ShaderCanvas?: ComponentType<CanvasProps>; default?: ComponentType<CanvasProps> }
type DefsModule = { defaultShaderSpec?: (kind: ShaderKind) => Spec }

const canvasLoaders = import.meta.glob<CanvasModule>('../shaders/ShaderCanvas.tsx')
const defsLoaders = import.meta.glob<DefsModule>('../shaders/defs.ts')

type Loaded = { Canvas: ComponentType<CanvasProps>; defaults?: (kind: ShaderKind) => Spec }
let loading: Promise<Loaded | null> | null = null

function loadRenderer(): Promise<Loaded | null> {
  if (loading) return loading
  const canvasLoad = Object.values(canvasLoaders)[0]
  if (!canvasLoad) return (loading = Promise.resolve(null))
  const defsLoad = Object.values(defsLoaders)[0]
  loading = Promise.all([canvasLoad(), defsLoad ? defsLoad() : Promise.resolve<DefsModule>({})])
    .then(([c, d]) => {
      const Canvas = c.ShaderCanvas ?? c.default
      return Canvas ? { Canvas, defaults: d.defaultShaderSpec } : null
    })
    .catch(() => null)
  return loading
}

function hasWebGL(): boolean {
  try {
    const c = document.createElement('canvas')
    return !!(c.getContext('webgl2') || c.getContext('webgl'))
  } catch {
    return false
  }
}

/** Write our colours into the renderer's colour params, in the order the renderer declares them. */
function tint(spec: Spec, tones?: string[]): Spec {
  if (!tones?.length) return spec
  const params: Record<string, number | string> = { ...spec.params }
  const keys = Object.keys(params).filter((k) => typeof params[k] === 'string' && /^#/.test(String(params[k])))
  keys.forEach((k, i) => {
    if (tones[i]) params[k] = tones[i]
  })
  return { ...spec, params }
}

class Quiet extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

export function ShaderTile({
  kind,
  colours,
  tones,
  speed = 0.6,
  className = '',
  label,
}: {
  kind: ShaderKind
  /** Colours for the CSS fallback: the first is the ground, the rest are inks. */
  colours: string[]
  /** Colour params for the live shader, in the renderer's own order. Defaults to the renderer's. */
  tones?: string[]
  speed?: number
  className?: string
  label?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [seen, setSeen] = useState(false)
  const [renderer, setRenderer] = useState<Loaded | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true)
          io.disconnect()
        }
      },
      { rootMargin: '200px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    if (!seen || !hasWebGL()) return
    let live = true
    loadRenderer().then((r) => live && setRenderer(r))
    return () => {
      live = false
    }
  }, [seen])

  const style = {
    '--c0': colours[0],
    '--c1': colours[1] ?? colours[0],
    '--c2': colours[2] ?? colours[1] ?? colours[0],
    '--c3': colours[3] ?? colours[2] ?? colours[0],
  } as CSSProperties

  const toneKey = tones?.join(',') ?? ''
  const spec = useMemo<Spec | null>(() => {
    if (!renderer) return null
    const base: Spec = renderer.defaults ? renderer.defaults(kind) : { kind, params: {}, speed }
    return { ...tint(base, toneKey ? toneKey.split(',') : undefined), kind, speed: reducedMotion() ? 0 : speed }
  }, [renderer, kind, toneKey, speed])

  let canvas: ReactNode = null
  if (renderer && spec) {
    const { Canvas } = renderer
    canvas = (
      <Quiet>
        <Canvas spec={spec} className="sh-canvas" />
      </Quiet>
    )
  }

  return (
    <div
      ref={ref}
      className={`sh sh--${kind} ${className}`}
      style={style}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <div className="sh-fb" />
      {canvas}
    </div>
  )
}
