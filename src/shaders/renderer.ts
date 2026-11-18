import type { ShaderKind, ShaderSpec } from '../editor/types'
import { shaderPreviewCSS } from './defs'
import { VERTEX_SOURCE, getFragmentSource } from './glsl'
import { resolveUniforms, type ResolvedUniforms } from './uniforms'

/**
 * One shared, offscreen WebGL context renders every shader layer.
 *
 * Browsers cap live WebGL contexts (~16), so instead of one context per layer we
 * render each visible layer at its pixel size into the shared GL canvas and blit
 * the result into the layer's own 2D canvas with drawImage. A single rAF loop
 * drives all instances.
 */

const MAX_DPR = 2
const MAX_SIDE = 1600
const EXPORT_MAX_SIDE = 4096
const IDLE_POLL_MS = 300
/** above this per-frame cost (ms) animated layers drop to every other frame */
const THROTTLE_ON_MS = 10
const THROTTLE_OFF_MS = 6

interface ProgramInfo {
  program: WebGLProgram
  time: WebGLUniformLocation | null
  resolution: WebGLUniformLocation | null
  pixelRatio: WebGLUniformLocation | null
  colors: (WebGLUniformLocation | null)[]
  numbers: (WebGLUniformLocation | null)[]
}

interface Instance {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D | null
  spec: ShaderSpec
  uniforms: ResolvedUniforms
  key: string
  time: number
  visible: boolean
  width: number
  height: number
  pixelRatio: number
  dirty: boolean
}

/* ---------------------------------------------------------------- GL state */

let glCanvas: HTMLCanvasElement | null = null
let gl: WebGLRenderingContext | null = null
let glUnavailable = false
let contextLost = false
let quad: WebGLBuffer | null = null
const programs = new Map<ShaderKind, ProgramInfo | null>()

function onContextLost(e: Event) {
  e.preventDefault() // allows the browser to restore the context later
  contextLost = true
  programs.clear()
  quad = null
}

function onContextRestored() {
  contextLost = false
  if (gl) initResources(gl)
  for (const inst of instances) inst.dirty = true
  kick()
}

function initResources(g: WebGLRenderingContext) {
  programs.clear()
  quad = g.createBuffer()
  g.bindBuffer(g.ARRAY_BUFFER, quad)
  // one oversized triangle covering the viewport
  g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), g.STATIC_DRAW)
  g.disable(g.DEPTH_TEST)
  g.disable(g.BLEND)
}

function getGL(): WebGLRenderingContext | null {
  if (glUnavailable || typeof document === 'undefined') return null
  if (!gl) {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const attrs: WebGLContextAttributes = {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    }
    let ctx: WebGLRenderingContext | null = null
    try {
      ctx = canvas.getContext('webgl', attrs) ?? (canvas.getContext('experimental-webgl', attrs) as WebGLRenderingContext | null)
    } catch {
      ctx = null
    }
    if (!ctx) {
      glUnavailable = true
      return null
    }
    canvas.addEventListener('webglcontextlost', onContextLost, false)
    canvas.addEventListener('webglcontextrestored', onContextRestored, false)
    glCanvas = canvas
    gl = ctx
    initResources(ctx)
  }
  if (contextLost || gl.isContextLost()) return null
  return gl
}

function compile(g: WebGLRenderingContext, type: number, source: string, label: string): WebGLShader | null {
  const shader = g.createShader(type)
  if (!shader) return null
  g.shaderSource(shader, source)
  g.compileShader(shader)
  if (!g.getShaderParameter(shader, g.COMPILE_STATUS)) {
    if (!g.isContextLost()) console.warn(`[kiln shaders] ${label} failed to compile:\n${g.getShaderInfoLog(shader) ?? ''}`)
    g.deleteShader(shader)
    return null
  }
  return shader
}

function buildProgram(g: WebGLRenderingContext, kind: ShaderKind): ProgramInfo | null {
  const vs = compile(g, g.VERTEX_SHADER, VERTEX_SOURCE, 'vertex shader')
  const fs = compile(g, g.FRAGMENT_SHADER, getFragmentSource(kind), `"${kind}" shader`)
  if (!vs || !fs) return null
  const program = g.createProgram()
  if (!program) return null
  g.attachShader(program, vs)
  g.attachShader(program, fs)
  g.bindAttribLocation(program, 0, 'a_position')
  g.linkProgram(program)
  g.deleteShader(vs)
  g.deleteShader(fs)
  if (!g.getProgramParameter(program, g.LINK_STATUS)) {
    if (!g.isContextLost()) console.warn(`[kiln shaders] "${kind}" failed to link:\n${g.getProgramInfoLog(program) ?? ''}`)
    g.deleteProgram(program)
    return null
  }
  const loc = (name: string) => g.getUniformLocation(program, name)
  return {
    program,
    time: loc('u_time'),
    resolution: loc('u_resolution'),
    pixelRatio: loc('u_pixelRatio'),
    colors: [0, 1, 2, 3].map((i) => loc(`u_c${i}`)),
    numbers: [0, 1, 2, 3, 4].map((i) => loc(`u_p${i}`)),
  }
}

/** Compiled program for a kind, cached. A failed compile is cached as null (unless the context was lost). */
function getProgram(g: WebGLRenderingContext, kind: ShaderKind): ProgramInfo | null {
  const cached = programs.get(kind)
  if (cached !== undefined) return cached
  const info = buildProgram(g, kind)
  if (info || !g.isContextLost()) programs.set(kind, info)
  return info
}

function ensureGLSize(w: number, h: number) {
  if (!glCanvas) return
  // grow-only, so alternating layer sizes don't reallocate the drawing buffer every frame
  if (glCanvas.width < w) glCanvas.width = w
  if (glCanvas.height < h) glCanvas.height = h
}

function drawToGL(g: WebGLRenderingContext, info: ProgramInfo, w: number, h: number, u: ResolvedUniforms, time: number, pixelRatio: number) {
  ensureGLSize(w, h)
  g.viewport(0, 0, w, h)
  g.useProgram(info.program)
  g.bindBuffer(g.ARRAY_BUFFER, quad)
  g.enableVertexAttribArray(0)
  g.vertexAttribPointer(0, 2, g.FLOAT, false, 0, 0)
  g.uniform1f(info.time, time)
  g.uniform2f(info.resolution, w, h)
  g.uniform1f(info.pixelRatio, pixelRatio)
  for (let i = 0; i < 4; i++) g.uniform3fv(info.colors[i], u.colors[i])
  for (let i = 0; i < 5; i++) g.uniform1f(info.numbers[i], u.numbers[i])
  g.drawArrays(g.TRIANGLES, 0, 3)
}

/** Copies the bottom-left w×h region of the GL buffer (where the viewport rendered) into a 2D context. */
function blit(ctx: CanvasRenderingContext2D, w: number, h: number, dw = w, dh = h) {
  if (!glCanvas) return
  ctx.drawImage(glCanvas, 0, glCanvas.height - h, w, h, 0, 0, dw, dh)
}

/* ---------------------------------------------------------------- instances & loop */

const instances = new Set<Instance>()
const byCanvas = new WeakMap<Element, Instance>()
let rafId = 0
let idleTimer: ReturnType<typeof setTimeout> | null = null
let lastNow = 0
let reducedMotion = false
let costEMA = 0
let throttled = false
let parity = 0
let listenersInstalled = false
let io: IntersectionObserver | null = null
let ro: ResizeObserver | null = null

function specKey(u: ResolvedUniforms, kind: ShaderKind): string {
  return kind + JSON.stringify(u)
}

function isAnimating(inst: Instance): boolean {
  return !reducedMotion && Number.isFinite(inst.spec.speed) && inst.spec.speed !== 0
}

function installListeners() {
  if (listenersInstalled || typeof window === 'undefined') return
  listenersInstalled = true
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopLoop()
    else kick()
  })
  if (typeof window.matchMedia === 'function') {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    reducedMotion = mq.matches
    mq.addEventListener?.('change', () => {
      reducedMotion = mq.matches
      for (const inst of instances) inst.dirty = true
      kick()
    })
  }
  if (typeof IntersectionObserver !== 'undefined') {
    io = new IntersectionObserver(
      (entries) => {
        let becameVisible = false
        for (const e of entries) {
          const inst = byCanvas.get(e.target)
          if (!inst) continue
          inst.visible = e.isIntersecting
          if (inst.visible) becameVisible = true
        }
        if (becameVisible) kick()
      },
      { rootMargin: '64px' },
    )
  }
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => kick())
  }
}

function stopLoop() {
  if (rafId) cancelAnimationFrame(rafId)
  rafId = 0
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  lastNow = 0
}

function kick() {
  if (rafId || typeof window === 'undefined' || document.hidden || instances.size === 0) return
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  rafId = requestAnimationFrame(frame)
}

/**
 * Measures the on-screen pixel size. clientWidth/Height give the layout size (keeps
 * the aspect ratio right); getBoundingClientRect adds any CSS transform zoom of the
 * editor canvas so layers stay sharp when zoomed in and cheap when zoomed out.
 */
function measure(inst: Instance) {
  const c = inst.canvas
  const cw = c.clientWidth
  const ch = c.clientHeight
  if (!c.isConnected || cw <= 0 || ch <= 0) {
    inst.width = 0
    inst.height = 0
    return
  }
  const rect = c.getBoundingClientRect()
  let zoom = Math.min(rect.width / cw, rect.height / ch)
  if (!Number.isFinite(zoom) || zoom <= 0) zoom = 1
  zoom = Math.min(Math.max(zoom, 0.02), 16)
  let scale = zoom * Math.min(window.devicePixelRatio || 1, MAX_DPR)
  const longest = Math.max(cw, ch) * scale
  if (longest > MAX_SIDE) scale *= MAX_SIDE / longest
  const w = Math.max(1, Math.round(cw * scale))
  const h = Math.max(1, Math.round(ch * scale))
  if (w !== inst.width || h !== inst.height) {
    inst.width = w
    inst.height = h
    inst.pixelRatio = w / cw
    inst.dirty = true
  }
}

function applyFallback(inst: Instance) {
  // no WebGL: show the CSS approximation behind the (empty) canvas
  if (!inst.canvas.style.background) inst.canvas.style.background = shaderPreviewCSS(inst.spec)
}

function render(inst: Instance) {
  inst.dirty = false
  const g = getGL()
  if (!g) {
    if (glUnavailable) applyFallback(inst)
    // context lost: keep showing the last frame; restore marks everything dirty
    return
  }
  const info = getProgram(g, inst.spec.kind)
  if (!info) {
    applyFallback(inst)
    return
  }
  const { canvas } = inst
  if (canvas.width !== inst.width) canvas.width = inst.width
  if (canvas.height !== inst.height) canvas.height = inst.height
  if (!inst.ctx) inst.ctx = canvas.getContext('2d')
  if (!inst.ctx) return
  drawToGL(g, info, inst.width, inst.height, inst.uniforms, inst.time, inst.pixelRatio)
  blit(inst.ctx, inst.width, inst.height)
}

function frame(now: number) {
  rafId = 0
  if (document.hidden) {
    lastNow = 0
    return
  }
  const dt = lastNow ? Math.min(Math.max((now - lastNow) / 1000, 0), 0.1) : 0
  lastNow = now
  parity ^= 1
  const start = performance.now()
  let anyAnimating = false
  let rendered = false

  for (const inst of instances) {
    if (!inst.visible) continue
    measure(inst)
    if (inst.width === 0) continue
    if (isAnimating(inst)) {
      anyAnimating = true
      inst.time += dt * inst.spec.speed
      if (!throttled || parity === 0) inst.dirty = true
    }
    if (inst.dirty) {
      render(inst)
      rendered = true
    }
  }

  if (rendered) {
    costEMA = costEMA * 0.85 + (performance.now() - start) * 0.15
    if (!throttled && costEMA > THROTTLE_ON_MS) throttled = true
    else if (throttled && costEMA < THROTTLE_OFF_MS) throttled = false
  }

  if (anyAnimating) {
    rafId = requestAnimationFrame(frame)
  } else {
    // static layers: poll occasionally for zoom/size changes that observers can't see (CSS transforms)
    lastNow = 0
    if (instances.size > 0 && !idleTimer) {
      idleTimer = setTimeout(() => {
        idleTimer = null
        kick()
      }, IDLE_POLL_MS)
    }
  }
}

/* ---------------------------------------------------------------- public API */

export function registerShaderCanvas(canvas: HTMLCanvasElement, spec: ShaderSpec): { update(spec: ShaderSpec): void; destroy(): void } {
  installListeners()
  const uniforms = resolveUniforms(spec)
  const inst: Instance = {
    canvas,
    ctx: null,
    spec,
    uniforms,
    key: specKey(uniforms, spec.kind),
    time: 0,
    visible: true, // until the IntersectionObserver reports otherwise
    width: 0,
    height: 0,
    pixelRatio: 1,
    dirty: true,
  }
  instances.add(inst)
  byCanvas.set(canvas, inst)
  io?.observe(canvas)
  ro?.observe(canvas)
  kick()

  return {
    update(next: ShaderSpec) {
      if (!instances.has(inst)) return
      const u = resolveUniforms(next)
      const key = specKey(u, next.kind)
      inst.spec = next
      if (key !== inst.key) {
        inst.key = key
        inst.uniforms = u
        inst.dirty = true
      }
      kick()
    },
    destroy() {
      if (!instances.has(inst)) return
      instances.delete(inst)
      byCanvas.delete(canvas)
      io?.unobserve(canvas)
      ro?.unobserve(canvas)
      if (instances.size === 0) stopLoop()
    },
  }
}

/**
 * Renders one frame synchronously and returns a PNG data URL. `width`/`height` are
 * output pixels (also treated as CSS px for px-sized params). Without WebGL, returns
 * a flat fill of the first colour.
 */
export function renderShaderToDataURL(spec: ShaderSpec, width: number, height: number, time = 0): string {
  if (typeof document === 'undefined') return ''
  const w = Math.max(1, Math.round(Number.isFinite(width) ? width : 1))
  const h = Math.max(1, Math.round(Number.isFinite(height) ? height : 1))
  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const ctx = out.getContext('2d')
  if (!ctx) return ''
  const u = resolveUniforms(spec)
  const g = getGL()
  const info = g ? getProgram(g, spec.kind) : null

  if (!g || !info || !glCanvas) {
    const [r, gr, b] = u.colors[0]
    ctx.fillStyle = `rgb(${Math.round(r * 255)}, ${Math.round(gr * 255)}, ${Math.round(b * 255)})`
    ctx.fillRect(0, 0, w, h)
    return out.toDataURL('image/png')
  }

  // render at most EXPORT_MAX_SIDE / the GPU viewport limit, then scale into the output
  const dims = g.getParameter(g.MAX_VIEWPORT_DIMS) as Int32Array | null
  const limit = Math.min(EXPORT_MAX_SIDE, dims ? Math.min(dims[0], dims[1]) : EXPORT_MAX_SIDE)
  const fit = Math.min(1, limit / Math.max(w, h))
  const rw = Math.max(1, Math.round(w * fit))
  const rh = Math.max(1, Math.round(h * fit))

  const prevW = glCanvas.width
  const prevH = glCanvas.height
  drawToGL(g, info, rw, rh, u, Number.isFinite(time) ? time : 0, fit)
  blit(ctx, rw, rh, w, h)
  // don't keep a huge export-sized buffer alive
  if (glCanvas.width > MAX_SIDE || glCanvas.height > MAX_SIDE) {
    glCanvas.width = Math.min(glCanvas.width, Math.max(prevW, 1))
    glCanvas.height = Math.min(glCanvas.height, Math.max(prevH, 1))
  }
  return out.toDataURL('image/png')
}
