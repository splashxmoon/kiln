/** Curated Google Fonts available in the font picker. Loaded on demand. */
export const FONT_FAMILIES: { family: string; category: 'sans' | 'serif' | 'mono' | 'display' }[] = [
  { family: 'Geist', category: 'sans' },
  { family: 'Inter', category: 'sans' },
  { family: 'DM Sans', category: 'sans' },
  { family: 'Manrope', category: 'sans' },
  { family: 'Space Grotesk', category: 'sans' },
  { family: 'IBM Plex Sans', category: 'sans' },
  { family: 'Bricolage Grotesque', category: 'display' },
  { family: 'Syne', category: 'display' },
  { family: 'Instrument Serif', category: 'serif' },
  { family: 'Fraunces', category: 'serif' },
  { family: 'Newsreader', category: 'serif' },
  { family: 'Playfair Display', category: 'serif' },
  { family: 'Geist Mono', category: 'mono' },
  { family: 'JetBrains Mono', category: 'mono' },
  { family: 'IBM Plex Mono', category: 'mono' },
]

export const FONT_WEIGHTS = [
  { value: 300, label: 'Light' },
  { value: 400, label: 'Regular' },
  { value: 500, label: 'Medium' },
  { value: 600, label: 'Semibold' },
  { value: 700, label: 'Bold' },
  { value: 800, label: 'Extrabold' },
]

const loaded = new Set<string>(['Geist', 'Geist Mono', 'Instrument Serif'])

export function ensureFont(family: string) {
  if (!family || loaded.has(family)) return
  loaded.add(family)
  if (!FONT_FAMILIES.some((f) => f.family === family)) return
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  const fam = family.replace(/ /g, '+')
  link.href = `https://fonts.googleapis.com/css2?family=${fam}${axisSpec(family)}&display=swap`
  document.head.appendChild(link)
}

function axisSpec(family: string) {
  return family === 'Instrument Serif' ? ':ital@0;1' : ':wght@400;500;600;700'
}

export function googleFontsHref(families: string[]) {
  const uniq = [...new Set(families)].filter((f) => FONT_FAMILIES.some((x) => x.family === f))
  if (!uniq.length) return null
  return 'https://fonts.googleapis.com/css2?' + uniq.map((f) => `family=${f.replace(/ /g, '+')}${axisSpec(f)}`).join('&') + '&display=swap'
}
