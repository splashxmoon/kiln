import { afterEach, describe, expect, it, vi } from 'vitest'

/** Load keys.ts as if running on the given OS. */
async function keysOn(os: 'mac' | 'windows' | 'linux') {
  vi.resetModules()
  vi.doMock('./os', () => ({ isMac: os === 'mac', isWindows: os === 'windows', isLinux: os === 'linux', os }))
  return import('./keys')
}

afterEach(() => vi.doUnmock('./os'))

describe('shortcut labels', () => {
  it('keeps Mac glyphs on the Mac', async () => {
    const { shortcut, modKey } = await keysOn('mac')
    expect(shortcut('⇧⌘Z')).toBe('⇧⌘Z')
    expect(modKey).toBe('⌘')
  })

  it('spells modifiers out on Windows, in Ctrl, Alt, Shift order', async () => {
    const { shortcut, modKey } = await keysOn('windows')
    expect(shortcut('⌘K')).toBe('Ctrl+K')
    expect(shortcut('⇧⌘Z')).toBe('Ctrl+Shift+Z')
    expect(shortcut('⌥⌘G')).toBe('Ctrl+Alt+G')
    expect(shortcut('⌥⇧H')).toBe('Alt+Shift+H')
    expect(shortcut('⌘↵')).toBe('Ctrl+Enter')
    expect(modKey).toBe('Ctrl')
  })

  it('passes plain labels through', async () => {
    const { shortcut } = await keysOn('linux')
    expect(shortcut('V')).toBe('V')
    expect(shortcut('Space')).toBe('Space')
  })

  it('uses Ctrl as the main modifier off the Mac and ⌘ on it', async () => {
    const win = await keysOn('windows')
    expect(win.isMod({ metaKey: false, ctrlKey: true })).toBe(true)
    expect(win.isMod({ metaKey: true, ctrlKey: false })).toBe(false)
    const mac = await keysOn('mac')
    expect(mac.isMod({ metaKey: true, ctrlKey: false })).toBe(true)
  })
})
