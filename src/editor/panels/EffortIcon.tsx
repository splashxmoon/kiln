/**
 * A reasoning level drawn as rising signal bars: `level` of `of` bars are lit,
 * the rest are faint, so Low through Max read as a scale at a glance.
 */
export function EffortIcon({ level, of, size = 14 }: { level: number; of: number; size?: number }) {
  const gap = 1.25
  const w = (14 - gap * (of - 1)) / of
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" className="k-effort-icon" aria-hidden="true">
      {Array.from({ length: of }, (_, i) => {
        const h = 4 + (10 * i) / Math.max(1, of - 1)
        return (
          <rect
            key={i}
            x={i * (w + gap)}
            y={14 - h}
            width={w}
            height={h}
            rx={Math.min(1, w / 2)}
            fill="currentColor"
            opacity={i < level ? 1 : 0.22}
          />
        )
      })}
    </svg>
  )
}
