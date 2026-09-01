import { describe, it, expect, afterEach } from 'vitest'
import {
  isMac,
  isWindows,
  modifierLabel,
  shortcutLabel,
  __setPlatformForTest,
  MAC_TRAFFIC_LIGHT_INSET_PX
} from './platform'

afterEach(() => {
  // The value is memoized on first read, so every test must clear it or the first
  // platform seen would leak into all the others.
  __setPlatformForTest(null)
})

describe('platform detection', () => {
  it('identifies macOS and Windows', () => {
    __setPlatformForTest('darwin')
    expect(isMac()).toBe(true)
    expect(isWindows()).toBe(false)
    __setPlatformForTest('win32')
    expect(isMac()).toBe(false)
    expect(isWindows()).toBe(true)
  })

  it('is neither when the preload bridge is unavailable', () => {
    // Browser dev and tests have no window.api; the UI must fall back to the
    // non-mac layout rather than throwing on a missing bridge.
    __setPlatformForTest('')
    expect(isMac()).toBe(false)
    expect(isWindows()).toBe(false)
  })
})

describe('modifierLabel', () => {
  it('leaves labels alone off macOS', () => {
    __setPlatformForTest('win32')
    expect(modifierLabel('Ctrl')).toBe('Ctrl')
    expect(modifierLabel('Alt')).toBe('Alt')
    expect(modifierLabel('Shift')).toBe('Shift')
  })

  it('maps to the glyphs a Mac keyboard actually has', () => {
    __setPlatformForTest('darwin')
    // Combos are written "Ctrl+N" throughout the codebase and the resolver accepts
    // ctrlKey OR metaKey — so the binding already worked on Mac and only the label lied.
    expect(modifierLabel('Ctrl')).toBe('⌘')
    expect(modifierLabel('Cmd')).toBe('⌘')
    expect(modifierLabel('Alt')).toBe('⌥')
    expect(modifierLabel('Shift')).toBe('⇧')
  })

  it('passes non-modifier keys through unchanged', () => {
    __setPlatformForTest('darwin')
    expect(modifierLabel('N')).toBe('N')
    expect(modifierLabel('`')).toBe('`')
  })
})

describe('shortcutLabel', () => {
  it('is a no-op off macOS', () => {
    __setPlatformForTest('win32')
    expect(shortcutLabel('Ctrl+Shift+G')).toBe('Ctrl+Shift+G')
  })

  it('uses adjacent glyphs, the way macOS writes shortcuts', () => {
    __setPlatformForTest('darwin')
    expect(shortcutLabel('Ctrl+N')).toBe('⌘N')
    expect(shortcutLabel('Ctrl+Shift+G')).toBe('⌘⇧G')
  })
})

describe('MAC_TRAFFIC_LIGHT_INSET_PX', () => {
  it('reserves enough width for the three window buttons', () => {
    // The window is frameless with titleBarStyle:'hidden'. On macOS that still DRAWS
    // close/minimize/zoom in the top-left, so app chrome starting at the edge lands
    // underneath them — the reported Settings back-arrow and sidebar chevron overlap.
    expect(MAC_TRAFFIC_LIGHT_INSET_PX).toBeGreaterThanOrEqual(70)
  })
})
