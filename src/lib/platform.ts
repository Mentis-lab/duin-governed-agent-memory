// platform — what OS is this renderer painting for, and what does that change.
//
// The preload has exposed `window.api.app.platform` for a long time and NOTHING in the
// renderer ever read it, which is why the UI was Windows-shaped everywhere: the window
// controls were drawn by the app (correct on Windows, duplicated by the traffic lights on
// macOS), the chrome started at 12px from the left (correct on Windows, directly underneath
// the traffic lights on macOS), and every shortcut hint said "Ctrl" (correct on Windows,
// wrong on every Mac keyboard).
//
// Read it ONCE. `process.platform` cannot change while the app runs, so re-reading it per
// render is pure overhead, and a memoized value keeps this usable inside render bodies.

let cached: string | null = null

/** The host platform, or '' when the bridge is unavailable (browser dev / tests). */
export function platform(): string {
  if (cached !== null) return cached
  try {
    cached = (window as unknown as { api?: { app?: { platform?: string } } })?.api?.app?.platform ?? ''
  } catch {
    cached = ''
  }
  return cached
}

export function isMac(): boolean {
  return platform() === 'darwin'
}

export function isWindows(): boolean {
  return platform() === 'win32'
}

/** Test seam — the value is memoized, so a test must be able to clear it. */
export function __setPlatformForTest(value: string | null): void {
  cached = value
}

/**
 * Width reserved at the top-LEFT of the window for the macOS traffic lights.
 *
 * The window is created with `frame: false, titleBarStyle: 'hidden'` (main.ts). On Windows
 * that means no system buttons at all, so app chrome can start at the very edge. On macOS
 * `titleBarStyle: 'hidden'` still DRAWS the close/minimize/zoom buttons — hiding the title
 * bar is not hiding the controls — so anything the app paints in that corner ends up
 * underneath them. That is the Settings back-arrow and the sidebar chevron in the reported
 * screenshots.
 *
 * 78px clears the three buttons plus their inset at the default position.
 */
export const MAC_TRAFFIC_LIGHT_INSET_PX = 78

/**
 * Stamp `data-platform` on <html> so CSS can adapt without every component importing this.
 * Mirrors how apply-theme stamps data-theme-mode.
 */
export function applyPlatformAttribute(): void {
  if (typeof document === 'undefined') return
  const p = platform()
  if (p) document.documentElement.dataset.platform = p
  document.documentElement.style.setProperty(
    '--titlebar-inset-left',
    `${p === 'darwin' ? MAC_TRAFFIC_LIGHT_INSET_PX : 0}px`
  )
}

/**
 * Render a shortcut modifier for THIS platform.
 *
 * The keybindings themselves already work on macOS — shortcut-resolver treats
 * `ctrlKey || metaKey` as one "mod" — so this is purely what the user is TOLD. A Mac user
 * reading "Ctrl+N" either tries the Control key (nothing happens, because the resolver is
 * looking at either modifier but the OS menu is bound to Command) or has to guess.
 */
export function modifierLabel(token: string): string {
  const t = token.toLowerCase()
  if (!isMac()) return token
  switch (t) {
    case 'ctrl':
    case 'control':
    case 'cmd':
    case 'command':
    case 'mod':
      return '⌘'
    case 'alt':
    case 'option':
      return '⌥'
    case 'shift':
      return '⇧'
    default:
      return token
  }
}

/** Rewrite a whole combo string ("Ctrl+Shift+G") for display on this platform. */
export function shortcutLabel(combo: string): string {
  if (!isMac()) return combo
  const parts = combo
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
    .map(modifierLabel)
  // Mac convention omits the separator between modifier glyphs: ⌘⇧G, not ⌘+⇧+G.
  return parts.join('')
}
