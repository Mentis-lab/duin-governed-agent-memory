import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  formatGlobalError,
  installGlobalErrorHandlers,
  reloadWindow,
  type GlobalErrorReport
} from './global-errors'

// U4 — before this, src/main.tsx passed createRoot no options, there was no
// ErrorBoundary anywhere in src/, and the ONLY unhandledrejection listener in the
// repo lived in artifact-sandbox.ts (a different WebContentsView). A throw or a
// rejection went to console.error on a frameless window with no application menu,
// i.e. nowhere the operator could see it.

function fakeTarget() {
  const listeners = new Map<string, (e: unknown) => void>()
  return {
    listeners,
    addEventListener: (t: string, l: (e: unknown) => void) => listeners.set(t, l),
    removeEventListener: (t: string) => listeners.delete(t),
    fire: (t: string, e: unknown) => listeners.get(t)?.(e)
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('formatGlobalError', () => {
  it('never returns a blank message — a blank toast is the silence we are fixing', () => {
    expect(formatGlobalError(new Error(''), 'promise')).toBe(
      'Unhandled background error: an error with no message'
    )
    expect(formatGlobalError(undefined, 'render')).toBe('Interface error: an error with no message')
  })

  it('labels the source so the operator knows what kind of failure it was', () => {
    expect(formatGlobalError(new Error('boom'), 'promise')).toBe(
      'Unhandled background error: boom'
    )
    expect(formatGlobalError('boom', 'render')).toBe('Interface error: boom')
    expect(formatGlobalError({ message: 'boom' }, 'error')).toBe('Unexpected error: boom')
  })
})

describe('installGlobalErrorHandlers', () => {
  it('registers BOTH unhandledrejection and error', () => {
    const target = fakeTarget()
    installGlobalErrorHandlers(target, () => {})
    expect([...target.listeners.keys()].sort()).toEqual(['error', 'unhandledrejection'])
  })

  it('reports a rejected promise instead of letting it vanish', () => {
    // The acceptance case: `Promise.reject(new Error('x'))` must produce a toast.
    const target = fakeTarget()
    const seen: GlobalErrorReport[] = []
    installGlobalErrorHandlers(target, (r) => seen.push(r))
    target.fire('unhandledrejection', { reason: new Error('x') })
    expect(seen).toHaveLength(1)
    expect(seen[0].source).toBe('promise')
    expect(seen[0].message).toBe('Unhandled background error: x')
  })

  it('reports a window error event', () => {
    const target = fakeTarget()
    const seen: GlobalErrorReport[] = []
    installGlobalErrorHandlers(target, (r) => seen.push(r))
    target.fire('error', { error: new Error('render blew up') })
    expect(seen[0]).toMatchObject({ source: 'error', message: 'Unexpected error: render blew up' })
  })

  it('swallows benign ResizeObserver loop noise instead of toasting it every launch', () => {
    // The 2026-08-14 operator report: the cosmos canvas layout storm at launch
    // fires ResizeObserver's "undelivered notifications" warning, and the
    // handler toasted it as "Unexpected error: …" on every start. Both
    // canonical texts are ignored, in both the error-object and bare-message
    // event shapes; everything else must stay loud.
    const target = fakeTarget()
    const seen: GlobalErrorReport[] = []
    installGlobalErrorHandlers(target, (r) => seen.push(r))
    target.fire('error', {
      error: new Error('ResizeObserver loop completed with undelivered notifications.')
    })
    target.fire('error', { message: 'ResizeObserver loop limit exceeded' })
    expect(seen).toHaveLength(0)
    target.fire('error', { error: new Error('a real one') })
    expect(seen).toHaveLength(1)
  })

  it('uninstalls cleanly', () => {
    const target = fakeTarget()
    const off = installGlobalErrorHandlers(target, () => {})
    off()
    expect(target.listeners.size).toBe(0)
  })
})

describe('reloadWindow', () => {
  it('calls the window:reload IPC that had ZERO renderer callers before this', async () => {
    const reload = vi.fn(async () => ({ success: true }))
    vi.stubGlobal('window', { api: { window: { reload } } })
    await reloadWindow()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('falls back to location.reload when the preload surface is missing', async () => {
    const locReload = vi.fn()
    vi.stubGlobal('window', {})
    vi.stubGlobal('location', { reload: locReload })
    await reloadWindow()
    expect(locReload).toHaveBeenCalledTimes(1)
  })

  it('falls back when the IPC call itself throws', async () => {
    const locReload = vi.fn()
    vi.stubGlobal('window', {
      api: {
        window: {
          reload: async () => {
            throw new Error('main process gone')
          }
        }
      }
    })
    vi.stubGlobal('location', { reload: locReload })
    await reloadWindow()
    expect(locReload).toHaveBeenCalledTimes(1)
  })
})
