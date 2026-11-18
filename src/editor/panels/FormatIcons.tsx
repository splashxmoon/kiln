/** Small marks for the export formats. Inline SVG, no icon package needed. */
import { Palette } from 'lucide-react'

export type FormatKind = 'tailwind' | 'react' | 'html' | 'vue' | 'css' | 'tokens'

/** Shield badge with a letter, used for HTML and CSS. */
function Shield({ size, color, letter }: { size: number; color: string; letter: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="k-format-icon">
      <path fill={color} d="M3.5 2.5h17l-1.6 17.2L12 22l-6.9-2.3L3.5 2.5Z" />
      <text x="12" y="15.6" textAnchor="middle" fontSize="11" fontWeight="700" fontFamily="system-ui, sans-serif" fill="#fff">
        {letter}
      </text>
    </svg>
  )
}

export function FormatIcon({ kind, size = 14 }: { kind: FormatKind; size?: number }) {
  switch (kind) {
    case 'tailwind':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="k-format-icon">
          <path
            fill="#38bdf8"
            d="M12 6.5c-2.4 0-3.9 1.2-4.5 3.6.9-1.2 1.95-1.6 3.15-1.3.68.17 1.17.66 1.7 1.2.88.9 1.9 1.95 4.15 1.95 2.4 0 3.9-1.2 4.5-3.6-.9 1.2-1.95 1.6-3.15 1.3-.68-.17-1.17-.66-1.7-1.2-.88-.9-1.9-1.95-4.15-1.95ZM7.5 12c-2.4 0-3.9 1.2-4.5 3.6.9-1.2 1.95-1.6 3.15-1.3.68.17 1.17.66 1.7 1.2.88.9 1.9 1.95 4.15 1.95 2.4 0 3.9-1.2 4.5-3.6-.9 1.2-1.95 1.6-3.15 1.3-.68-.17-1.17-.66-1.7-1.2-.88-.9-1.9-1.95-4.15-1.95Z"
          />
        </svg>
      )
    case 'react':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="k-format-icon" fill="none" stroke="#61dafb" strokeWidth="1.2">
          <ellipse cx="12" cy="12" rx="10" ry="4.2" />
          <ellipse cx="12" cy="12" rx="10" ry="4.2" transform="rotate(60 12 12)" />
          <ellipse cx="12" cy="12" rx="10" ry="4.2" transform="rotate(120 12 12)" />
          <circle cx="12" cy="12" r="1.8" fill="#61dafb" stroke="none" />
        </svg>
      )
    case 'vue':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="k-format-icon">
          <path fill="#42b883" fillRule="evenodd" d="M2 3h4.2L12 13.6 17.8 3H22L12 21 2 3Z" />
          <path fill="#35495e" fillRule="evenodd" d="M6.2 3h3.3L12 7.6 14.5 3h3.3L12 10.9 6.2 3Z" />
        </svg>
      )
    case 'html':
      return <Shield size={size} color="#e44d26" letter="5" />
    case 'css':
      return <Shield size={size} color="#2965f1" letter="3" />
    case 'tokens':
      return <Palette size={size} className="k-format-icon" aria-hidden="true" />
  }
}
