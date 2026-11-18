import { useEffect, useRef } from 'react'
import type { CSSProperties } from 'react'
import type { ShaderSpec } from '../editor/types'
import { shaderPreviewCSS } from './defs'
import { registerShaderCanvas } from './renderer'

type ShaderHandle = ReturnType<typeof registerShaderCanvas>

/**
 * A <canvas> that fills its parent and renders a shader layer through the shared
 * renderer. Size is tracked by the renderer's ResizeObserver (plus zoom polling);
 * spec changes only update uniforms, the compiled program is reused.
 */
export function ShaderCanvas({ spec, className, style }: { spec: ShaderSpec; className?: string; style?: CSSProperties }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const handleRef = useRef<ShaderHandle | null>(null)
  const specRef = useRef(spec)

  useEffect(() => {
    specRef.current = spec
    handleRef.current?.update(spec)
  }, [spec])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const handle = registerShaderCanvas(canvas, specRef.current)
    handleRef.current = handle
    return () => {
      handle.destroy()
      handleRef.current = null
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className={className}
      aria-hidden="true"
      style={{
        display: 'block',
        width: '100%',
        height: '100%',
        // shown until the first frame lands, and as the fallback without WebGL
        background: shaderPreviewCSS(spec),
        ...style,
      }}
    />
  )
}
