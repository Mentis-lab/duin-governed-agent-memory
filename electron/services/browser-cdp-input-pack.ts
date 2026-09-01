/**
 * Registers the compositor-level CDP browser-input tools (Phase 0 of computer-use).
 * Pure side-effect module: it only calls `registerNative`. Wired via `tool-packs.ts`.
 *
 * Gating: `browser_click_xy` and `browser_key` actuate the page → `requiresApproval:true`
 * + `destructive` risk (gated interactively, CAP-floored unattended). `browser_move_xy` /
 * `browser_scroll_xy` are reversible (`write` only) → ungated, pass the unattended floor.
 */
import { toolRegistry } from './tool-registry'
import { getActiveTab, getTab, type BrowserTabHandle } from './browser-manager'
import {
  executeBrowserClickXy,
  executeBrowserMoveXy,
  executeBrowserScrollXy,
  executeBrowserKey,
  type CdpInputSession,
  type BrowserClickXyArgs,
  type BrowserMoveXyArgs,
  type BrowserScrollXyArgs,
  type BrowserKeyArgs
} from './browser-cdp-input'

const NO_TAB = 'No active browser tab. Open one with browser_open first.'

function resolveTab(tabId?: string): BrowserTabHandle | null {
  return tabId ? getTab(tabId) : getActiveTab()
}

/** Build a real CDP session over the tab's webContents.debugger (attach is lazy + guarded). */
function makeSession(tab: BrowserTabHandle): CdpInputSession {
  const dbg = tab.view.webContents.debugger
  return {
    async send(method, params) {
      if (!dbg.isAttached()) dbg.attach('1.3')
      return dbg.sendCommand(method, params ?? {})
    },
    viewport() {
      try {
        const b = tab.view.getBounds()
        if (b && b.width > 0 && b.height > 0) return { width: b.width, height: b.height }
      } catch {
        /* getBounds unavailable — skip bounds check */
      }
      return null
    }
  }
}

const XY = {
  x: { type: 'number', description: 'X coordinate in CSS px, relative to the browser viewport top-left.' },
  y: { type: 'number', description: 'Y coordinate in CSS px, relative to the browser viewport top-left.' },
  tab_id: { type: 'string', description: 'Target tab id. Defaults to the active tab.' }
}

toolRegistry.registerNative(
  {
    id: 'browser_click_xy',
    name: 'browser_click_xy',
    title: 'Browser: Click at coordinate',
    description:
      'Click at a pixel coordinate in the in-app browser via the compositor (CDP Input). ' +
      'Unlike browser_click (CSS-selector, DOM-event), this passes through iframes, shadow DOM, and ' +
      'canvas. Read a browser_screenshot first to find the coordinate.',
    providerKind: 'native',
    providerId: 'internal',
    inputSchema: {
      type: 'object',
      properties: {
        ...XY,
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button. Default left.' },
        click_count: { type: 'number', description: 'Click count (2 = double-click). Default 1.' }
      },
      required: ['x', 'y'],
      additionalProperties: false
    },
    risks: ['destructive', 'write'],
    requiresApproval: true,
    enabled: true
  },
  async (args) => {
    const a = args as unknown as BrowserClickXyArgs
    const tab = resolveTab(a.tab_id)
    if (!tab) return NO_TAB
    return executeBrowserClickXy(a, makeSession(tab))
  }
)

toolRegistry.registerNative(
  {
    id: 'browser_key',
    name: 'browser_key',
    title: 'Browser: Key / type',
    description:
      'Send keyboard input to the in-app browser via the compositor (CDP Input). Provide EITHER ' +
      "`text` to type a literal string, OR `key` for a named special key (Enter, Tab, Escape, " +
      'ArrowDown, …) with optional `modifiers` (e.g. ["ctrl"] for Ctrl+A). Focus the target first ' +
      'with browser_click_xy.',
    providerKind: 'native',
    providerId: 'internal',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Literal text to type. Mutually exclusive with `key`.' },
        key: {
          type: 'string',
          description:
            'A named special key: Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, ' +
            'Home, End, PageUp, PageDown, Space. Mutually exclusive with `text`.'
        },
        modifiers: {
          type: 'array',
          items: { type: 'string', enum: ['alt', 'ctrl', 'meta', 'shift'] },
          description: 'Modifiers held during a `key` press. Ignored for `text`.'
        },
        tab_id: XY.tab_id
      },
      additionalProperties: false
    },
    risks: ['destructive', 'write'],
    requiresApproval: true,
    enabled: true
  },
  async (args) => {
    const a = args as unknown as BrowserKeyArgs
    const tab = resolveTab(a.tab_id)
    if (!tab) return NO_TAB
    return executeBrowserKey(a, makeSession(tab))
  }
)

toolRegistry.registerNative(
  {
    id: 'browser_move_xy',
    name: 'browser_move_xy',
    title: 'Browser: Move pointer',
    description: 'Move the pointer to a coordinate (hover) in the in-app browser via CDP Input.',
    providerKind: 'native',
    providerId: 'internal',
    inputSchema: {
      type: 'object',
      properties: { ...XY },
      required: ['x', 'y'],
      additionalProperties: false
    },
    risks: ['write'],
    requiresApproval: false,
    enabled: true
  },
  async (args) => {
    const a = args as unknown as BrowserMoveXyArgs
    const tab = resolveTab(a.tab_id)
    if (!tab) return NO_TAB
    return executeBrowserMoveXy(a, makeSession(tab))
  }
)

toolRegistry.registerNative(
  {
    id: 'browser_scroll_xy',
    name: 'browser_scroll_xy',
    title: 'Browser: Scroll',
    description:
      'Scroll by a wheel delta at a coordinate in the in-app browser via CDP Input. Positive ' +
      'delta_y scrolls down.',
    providerKind: 'native',
    providerId: 'internal',
    inputSchema: {
      type: 'object',
      properties: {
        ...XY,
        delta_x: { type: 'number', description: 'Horizontal wheel delta (px).' },
        delta_y: { type: 'number', description: 'Vertical wheel delta (px). Positive = down.' }
      },
      required: ['x', 'y'],
      additionalProperties: false
    },
    risks: ['write'],
    requiresApproval: false,
    enabled: true
  },
  async (args) => {
    const a = args as unknown as BrowserScrollXyArgs
    const tab = resolveTab(a.tab_id)
    if (!tab) return NO_TAB
    return executeBrowserScrollXy(a, makeSession(tab))
  }
)
