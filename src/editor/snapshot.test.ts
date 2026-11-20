import { describe, expect, it } from 'vitest'
import { imageFileName, uniqueFileNames } from './snapshot'

describe('export file names', () => {
  it('makes a safe name from the layer name, with the scale', () => {
    expect(imageFileName('Hero card', 'png', 2)).toBe('Hero-card@2x.png')
    expect(imageFileName('../../etc/passwd', 'jpg', 1)).toBe('etc-passwd.jpg')
    expect(imageFileName('  ', 'svg', 3)).toBe('layer.svg')
  })

  it('keeps clear of names Windows reserves', () => {
    expect(imageFileName('Con', 'png', 2)).toBe('Con-@2x.png')
    expect(imageFileName('com1', 'png', 1)).toBe('com1-.png')
    expect(imageFileName('Console', 'png', 1)).toBe('Console.png')
  })

  it('numbers repeats so no file overwrites another', () => {
    expect(uniqueFileNames(['Card@2x.png', 'Card@2x.png', 'Card@2x.png'])).toEqual(['Card@2x.png', 'Card-2@2x.png', 'Card-3@2x.png'])
  })

  it('treats names differing only in case as the same file', () => {
    expect(uniqueFileNames(['Card.png', 'card.png'])).toEqual(['Card.png', 'card-2.png'])
  })

  it('skips a number another layer already uses', () => {
    const out = uniqueFileNames(['Card@2x.png', 'Card@2x.png', 'Card-2@2x.png'])
    expect(new Set(out.map((p) => p.toLowerCase())).size).toBe(3)
  })
})
