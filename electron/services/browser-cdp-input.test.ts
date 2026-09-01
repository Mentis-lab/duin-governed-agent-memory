import { describe, it, expect } from 'vitest'
import {
  executeBrowserClickXy,
  executeBrowserMoveXy,
  executeBrowserScrollXy,
  executeBrowserKey,
  type CdpInputSession
} from './browser-cdp-input'

interface Sent {
  method: string
  params: Record<string, unknown>
}

function fakeSession(opts?: { viewport?: { width: number; height: number } | null; fail?: boolean }): {
  session: CdpInputSession
  sent: Sent[]
} {
  const sent: Sent[] = []
  const session: CdpInputSession = {
    async send(method, params) {
      if (opts?.fail) throw new Error('transport boom')
      sent.push({ method, params: params ?? {} })
      return {}
    },
    viewport() {
      return opts?.viewport === undefined ? { width: 1200, height: 800 } : opts.viewport
    }
  }
  return { session, sent }
}

describe('browser_click_xy', () => {
  it('dispatches move → press → release with correct button mask', async () => {
    const { session, sent } = fakeSession()
    const out = await executeBrowserClickXy({ x: 100, y: 200 }, session)
    expect(out).toBe('clicked left at (100,200)')
    expect(sent.map((s) => (s.params as { type: string }).type)).toEqual([
      'mouseMoved',
      'mousePressed',
      'mouseReleased'
    ])
    expect(sent[1].params).toMatchObject({ button: 'left', buttons: 1, clickCount: 1, x: 100, y: 200 })
    expect(sent[2].params).toMatchObject({ buttons: 0 })
  })

  it('supports right button and double-click', async () => {
    const { session, sent } = fakeSession()
    const out = await executeBrowserClickXy({ x: 10, y: 20, button: 'right', click_count: 2 }, session)
    expect(out).toBe('clicked right at (10,20) x2')
    expect(sent[1].params).toMatchObject({ button: 'right', buttons: 2, clickCount: 2 })
  })

  it('rejects non-finite coordinates without sending', async () => {
    const { session, sent } = fakeSession()
    expect(await executeBrowserClickXy({ x: NaN, y: 5 }, session)).toMatch(/finite numbers/)
    expect(sent).toHaveLength(0)
  })

  it('rejects coordinates outside the viewport', async () => {
    const { session, sent } = fakeSession({ viewport: { width: 100, height: 100 } })
    expect(await executeBrowserClickXy({ x: 500, y: 10 }, session)).toMatch(/outside viewport 100x100/)
    expect(sent).toHaveLength(0)
  })

  it('rejects negative coordinates', async () => {
    const { session } = fakeSession()
    expect(await executeBrowserClickXy({ x: -1, y: 10 }, session)).toMatch(/non-negative/)
  })

  it('allows out-of-bounds when viewport is unknown', async () => {
    const { session, sent } = fakeSession({ viewport: null })
    expect(await executeBrowserClickXy({ x: 9999, y: 9999 }, session)).toBe('clicked left at (9999,9999)')
    expect(sent).toHaveLength(3)
  })

  it('returns an error string (never throws) on transport failure', async () => {
    const { session } = fakeSession({ fail: true })
    expect(await executeBrowserClickXy({ x: 1, y: 1 }, session)).toMatch(/CDP click failed — transport boom/)
  })
})

describe('browser_key', () => {
  it('types literal text via insertText', async () => {
    const { session, sent } = fakeSession()
    const out = await executeBrowserKey({ text: 'hello' }, session)
    expect(out).toBe('typed "hello"')
    expect(sent).toEqual([{ method: 'Input.insertText', params: { text: 'hello' } }])
  })

  it('dispatches a named key as keyDown/keyUp with the right vk', async () => {
    const { session, sent } = fakeSession()
    const out = await executeBrowserKey({ key: 'Enter' }, session)
    expect(out).toBe('pressed Enter')
    expect(sent).toHaveLength(2)
    expect(sent[0].params).toMatchObject({ type: 'keyDown', key: 'Enter', windowsVirtualKeyCode: 13 })
    expect(sent[1].params).toMatchObject({ type: 'keyUp', key: 'Enter' })
  })

  it('applies modifier bitmask (ctrl+shift = 2|8 = 10)', async () => {
    const { session, sent } = fakeSession()
    const out = await executeBrowserKey({ key: 'ArrowLeft', modifiers: ['ctrl', 'shift'] }, session)
    expect(out).toBe('pressed ctrl+shift+ArrowLeft')
    expect(sent[0].params).toMatchObject({ modifiers: 10 })
  })

  it('rejects when both text and key are given', async () => {
    const { session, sent } = fakeSession()
    expect(await executeBrowserKey({ text: 'a', key: 'Enter' }, session)).toMatch(/exactly one/)
    expect(sent).toHaveLength(0)
  })

  it('rejects when neither text nor key is given', async () => {
    const { session } = fakeSession()
    expect(await executeBrowserKey({}, session)).toMatch(/exactly one/)
  })

  it('rejects an unknown named key and lists supported keys', async () => {
    const { session, sent } = fakeSession()
    const out = await executeBrowserKey({ key: 'F13' }, session)
    expect(out).toMatch(/unknown key 'F13'/)
    expect(out).toMatch(/Enter/)
    expect(sent).toHaveLength(0)
  })
})

describe('browser_scroll_xy / browser_move_xy', () => {
  it('scrolls with a wheel delta', async () => {
    const { session, sent } = fakeSession()
    const out = await executeBrowserScrollXy({ x: 50, y: 60, delta_y: 240 }, session)
    expect(out).toBe('scrolled (0,240) at (50,60)')
    expect(sent[0].params).toMatchObject({ type: 'mouseWheel', deltaX: 0, deltaY: 240 })
  })

  it('rejects a zero-delta scroll', async () => {
    const { session, sent } = fakeSession()
    expect(await executeBrowserScrollXy({ x: 1, y: 1 }, session)).toMatch(/non-zero/)
    expect(sent).toHaveLength(0)
  })

  it('moves the pointer (hover)', async () => {
    const { session, sent } = fakeSession()
    expect(await executeBrowserMoveXy({ x: 5, y: 6 }, session)).toBe('moved to (5,6)')
    expect(sent[0].params).toMatchObject({ type: 'mouseMoved', x: 5, y: 6 })
  })
})
