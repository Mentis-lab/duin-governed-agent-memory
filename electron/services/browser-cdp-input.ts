/**
 * Compositor-level browser input via CDP (`Input.*`).
 *
 * DUIN's existing `browser_click`/`browser_type` inject synthetic DOM events through
 * `executeJavaScript` — selector-based, and blind to canvas, cross-origin iframes and
 * shadow DOM. These tools dispatch input at the Chromium **browser/compositor** process
 * (`Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` / `Input.insertText`), so hit-
 * testing passes through iframes/shadow DOM by coordinate — the browser-harness pattern.
 *
 * Everything here is pure over an injected {@link CdpInputSession} so it unit-tests with a
 * fake session (no Electron). The real session (webContents.debugger) is built in the pack.
 */

export interface CdpInputSession {
  /** Send a CDP command. Rejects on transport/attach failure. */
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
  /** Logical viewport size (CSS px) for bounds validation, or null if unknown. */
  viewport(): { width: number; height: number } | null
}

export type MouseButton = 'left' | 'right' | 'middle'
export type KeyModifier = 'alt' | 'ctrl' | 'meta' | 'shift'

export interface BrowserClickXyArgs {
  x: number
  y: number
  button?: MouseButton
  click_count?: number
  tab_id?: string
}
export interface BrowserMoveXyArgs {
  x: number
  y: number
  tab_id?: string
}
export interface BrowserScrollXyArgs {
  x: number
  y: number
  delta_x?: number
  delta_y?: number
  tab_id?: string
}
export interface BrowserKeyArgs {
  /** Literal text to insert (typed as a unit via Input.insertText). */
  text?: string
  /** A named special key (Enter, Tab, Escape, ArrowDown, …) dispatched as keyDown/keyUp. */
  key?: string
  /** Modifiers applied to a `key` press (e.g. ['ctrl'] for Ctrl+A). Ignored for `text`. */
  modifiers?: KeyModifier[]
  tab_id?: string
}

const BUTTON_MASK: Record<MouseButton, number> = { left: 1, right: 2, middle: 4 }
const MODIFIER_MASK: Record<KeyModifier, number> = { alt: 1, ctrl: 2, meta: 4, shift: 8 }

/** windowsVirtualKeyCode + DOM key/code for the special keys we support. */
const KEY_MAP: Record<string, { code: string; vk: number }> = {
  Enter: { code: 'Enter', vk: 13 },
  Tab: { code: 'Tab', vk: 9 },
  Escape: { code: 'Escape', vk: 27 },
  Backspace: { code: 'Backspace', vk: 8 },
  Delete: { code: 'Delete', vk: 46 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  Home: { code: 'Home', vk: 36 },
  End: { code: 'End', vk: 35 },
  PageUp: { code: 'PageUp', vk: 33 },
  PageDown: { code: 'PageDown', vk: 34 },
  Space: { code: 'Space', vk: 32 }
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** Validate a coordinate pair against the viewport (when known). Returns an error string or null. */
function validateXy(x: unknown, y: unknown, session: CdpInputSession): string | null {
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) return 'Error: x and y must be finite numbers'
  if (x < 0 || y < 0) return `Error: coordinates (${x},${y}) must be non-negative`
  const vp = session.viewport()
  if (vp && (x > vp.width || y > vp.height)) {
    return `Error: coordinates (${x},${y}) outside viewport ${vp.width}x${vp.height}`
  }
  return null
}

function modifierBits(mods?: KeyModifier[]): number {
  if (!mods || mods.length === 0) return 0
  return mods.reduce((acc, m) => acc | (MODIFIER_MASK[m] ?? 0), 0)
}

export async function executeBrowserClickXy(
  args: BrowserClickXyArgs,
  session: CdpInputSession
): Promise<string> {
  const bad = validateXy(args.x, args.y, session)
  if (bad) return bad
  const button: MouseButton = args.button ?? 'left'
  if (!(button in BUTTON_MASK)) return `Error: invalid button '${button}'`
  const clickCount = isFiniteNumber(args.click_count) ? Math.max(1, Math.trunc(args.click_count)) : 1
  const { x, y } = args
  try {
    await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
    await session.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button, buttons: BUTTON_MASK[button], clickCount
    })
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button, buttons: 0, clickCount
    })
    return `clicked ${button} at (${x},${y})${clickCount > 1 ? ` x${clickCount}` : ''}`
  } catch (err) {
    return `Error: CDP click failed — ${(err as Error)?.message ?? 'unknown'}`
  }
}

export async function executeBrowserMoveXy(
  args: BrowserMoveXyArgs,
  session: CdpInputSession
): Promise<string> {
  const bad = validateXy(args.x, args.y, session)
  if (bad) return bad
  try {
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: args.x, y: args.y, button: 'none', buttons: 0
    })
    return `moved to (${args.x},${args.y})`
  } catch (err) {
    return `Error: CDP move failed — ${(err as Error)?.message ?? 'unknown'}`
  }
}

export async function executeBrowserScrollXy(
  args: BrowserScrollXyArgs,
  session: CdpInputSession
): Promise<string> {
  const bad = validateXy(args.x, args.y, session)
  if (bad) return bad
  const deltaX = isFiniteNumber(args.delta_x) ? args.delta_x : 0
  const deltaY = isFiniteNumber(args.delta_y) ? args.delta_y : 0
  if (deltaX === 0 && deltaY === 0) return 'Error: provide a non-zero delta_x or delta_y'
  try {
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: args.x, y: args.y, deltaX, deltaY
    })
    return `scrolled (${deltaX},${deltaY}) at (${args.x},${args.y})`
  } catch (err) {
    return `Error: CDP scroll failed — ${(err as Error)?.message ?? 'unknown'}`
  }
}

export async function executeBrowserKey(
  args: BrowserKeyArgs,
  session: CdpInputSession
): Promise<string> {
  const hasText = typeof args.text === 'string' && args.text.length > 0
  const hasKey = typeof args.key === 'string' && args.key.length > 0
  if (hasText === hasKey) {
    return "Error: provide exactly one of 'text' (to type a string) or 'key' (a named special key)"
  }

  if (hasText) {
    try {
      await session.send('Input.insertText', { text: args.text })
      return `typed ${JSON.stringify(args.text)}`
    } catch (err) {
      return `Error: CDP insertText failed — ${(err as Error)?.message ?? 'unknown'}`
    }
  }

  const spec = KEY_MAP[args.key as string]
  if (!spec) {
    return `Error: unknown key '${args.key}'. Supported: ${Object.keys(KEY_MAP).join(', ')}`
  }
  const modifiers = modifierBits(args.modifiers)
  try {
    await session.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      modifiers,
      key: args.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.vk,
      nativeVirtualKeyCode: spec.vk
    })
    await session.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      modifiers,
      key: args.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.vk,
      nativeVirtualKeyCode: spec.vk
    })
    const prefix = args.modifiers && args.modifiers.length ? `${args.modifiers.join('+')}+` : ''
    return `pressed ${prefix}${args.key}`
  } catch (err) {
    return `Error: CDP key failed — ${(err as Error)?.message ?? 'unknown'}`
  }
}

export const __testing = { KEY_MAP, BUTTON_MASK, MODIFIER_MASK, validateXy, modifierBits }
