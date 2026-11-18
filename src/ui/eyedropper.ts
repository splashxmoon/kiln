/** How Kiln samples a colour from the screen (the editor registers its canvas sampler). */
type Eyedropper = () => Promise<string | null>
let eyedropper: Eyedropper | null = null
/** The app registers how to sample a colour from the screen (Kiln samples its own canvas). */
export function registerEyedropper(fn: Eyedropper | null) {
  eyedropper = fn
}
/** Sample a colour: the app's eyedropper, else the browser's own where there is one. */
export async function pickColor(): Promise<string | null> {
  if (eyedropper) return eyedropper()
  const ED = (window as unknown as { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper
  if (!ED) return null
  try {
    return (await new ED().open()).sRGBHex
  } catch {
    return null
  }
}
export const canPickColor = () => !!eyedropper || 'EyeDropper' in window
