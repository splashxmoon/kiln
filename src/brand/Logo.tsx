/** Kiln brand mark: an arched kiln mouth with a glowing ember. */
export function KilnMark({ size = 20, ember = '#FF5B1F', body = 'currentColor' }: { size?: number; ember?: string; body?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path fill={body} fillRule="evenodd" d="M4 22V11.5a8 8 0 0 1 16 0V22Zm4.6 0V13.4a3.4 3.4 0 0 1 6.8 0V22Z" />
      <circle cx="12" cy="18.6" r="2.1" fill={ember} />
    </svg>
  )
}

export function KilnLogo({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <span className={className} style={{ display: 'inline-flex', alignItems: 'center', gap: size * 0.4, fontWeight: 600, letterSpacing: '-0.02em', fontSize: size * 0.9 }}>
      <KilnMark size={size} />
      <span>kiln</span>
    </span>
  )
}
