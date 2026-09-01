// window-guard.test.ts — fully pins the decision logic that IS the security boundary. No electron
// import needed (the module under test has none), so this runs the real predicates, not a stub.

import { describe, it, expect } from 'vitest'
import { isAllowedNavigationTarget, isExternalOpenTarget } from './window-guard'

const PACKAGED_RENDERER = 'file:///C:/DUIN/resources/app/renderer/index.html'
const DEV_RENDERER = 'http://localhost:5173/'

describe('isExternalOpenTarget — what a window-open request may hand to the OS opener', () => {
  it('allows http and https', () => {
    expect(isExternalOpenTarget('http://example.com')).toBe(true)
    expect(isExternalOpenTarget('https://example.com/path?x=1')).toBe(true)
  })

  it('denies file:// — a window-open must not hand the OS opener a local path', () => {
    expect(isExternalOpenTarget('file:///etc/passwd')).toBe(false)
  })

  it('denies dangerous / non-web schemes', () => {
    expect(isExternalOpenTarget('javascript:alert(1)')).toBe(false)
    expect(isExternalOpenTarget('data:text/html,<script>alert(1)</script>')).toBe(false)
    expect(isExternalOpenTarget('chrome-extension://abc/index.html')).toBe(false)
    expect(isExternalOpenTarget('view-source:http://example.com')).toBe(false)
  })

  it('denies a malformed URL instead of throwing', () => {
    expect(() => isExternalOpenTarget('not a url')).not.toThrow()
    expect(isExternalOpenTarget('not a url')).toBe(false)
    expect(isExternalOpenTarget('')).toBe(false)
  })
})

describe("isAllowedNavigationTarget — what may load IN PLACE, inheriting this window's preload", () => {
  it('allows the packaged app (file://)', () => {
    expect(isAllowedNavigationTarget(PACKAGED_RENDERER, PACKAGED_RENDERER)).toBe(true)
    expect(isAllowedNavigationTarget(`${PACKAGED_RENDERER}?view=node&key=abc`, PACKAGED_RENDERER)).toBe(true)
  })

  it('allows only the configured Vite origin', () => {
    expect(isAllowedNavigationTarget('http://localhost:5173/?view=node&key=abc', DEV_RENDERER)).toBe(true)
    expect(isAllowedNavigationTarget('http://localhost:5173/other', DEV_RENDERER)).toBe(true)
    expect(isAllowedNavigationTarget('http://127.0.0.1:5173/', DEV_RENDERER)).toBe(false)
    expect(isAllowedNavigationTarget('http://localhost:4173/', DEV_RENDERER)).toBe(false)
    expect(isAllowedNavigationTarget('https://localhost:5173/', DEV_RENDERER)).toBe(false)
  })

  it('denies sibling file documents', () => {
    expect(isAllowedNavigationTarget('file:///C:/DUIN/resources/app/renderer/other.html', PACKAGED_RENDERER)).toBe(false)
    expect(isAllowedNavigationTarget('file:///C:/Users/operator/Downloads/index.html', PACKAGED_RENDERER)).toBe(false)
  })

  // This is the exact shape of the defect this module fixes: without this predicate wired into
  // EVERY full-preload window (not just mainWindow), a plain http(s) link rendered inside vault-note
  // or connector-ingested content navigates the window in place, and Electron re-executes the SAME
  // preload against the attacker's page — handing it the full window.api contextBridge (chat, files,
  // hooks, shell).
  it('denies an arbitrary remote origin, even https', () => {
    expect(isAllowedNavigationTarget('https://attacker.example/x', PACKAGED_RENDERER)).toBe(false)
    expect(isAllowedNavigationTarget('http://attacker.example/x', DEV_RENDERER)).toBe(false)
  })

  it('denies a non-loopback host that merely contains "localhost"', () => {
    // Exact hostname match, not a substring match — 'localhost.attacker.example' must not sneak
    // through under a naive .includes('localhost') check.
    expect(isAllowedNavigationTarget('http://localhost.attacker.example/', DEV_RENDERER)).toBe(false)
    expect(isAllowedNavigationTarget('http://notlocalhost/', DEV_RENDERER)).toBe(false)
  })

  it('F1 supersession: a bare OS dir path as the trusted value fails CLOSED — for every candidate', () => {
    // The pre-exact-predicate signature took a renderer DIRECTORY; a caller still passing one must
    // not degrade into 'null'-origin equality that would allow arbitrary file: targets.
    const rendererDir = process.platform === 'win32' ? 'C:\\DUIN\\resources\\app\\renderer' : '/opt/duin/renderer'
    expect(isAllowedNavigationTarget('file:///C:/DUIN/resources/app/renderer/index.html', rendererDir)).toBe(false)
    expect(isAllowedNavigationTarget('file:///C:/Users/me/.ssh/evil.html', rendererDir)).toBe(false)
  })

  it('opaque origins never satisfy the dev-server branch', () => {
    // trusted = dev server (http), candidate with an opaque origin ('null') must be denied even
    // though two opaque origins compare equal as strings.
    expect(isAllowedNavigationTarget('file:///C:/anything.html', DEV_RENDERER)).toBe(false)
    expect(isAllowedNavigationTarget('data:text/html,<script>1</script>', DEV_RENDERER)).toBe(false)
  })

  it('denies a malformed URL instead of throwing', () => {
    expect(() => isAllowedNavigationTarget('not a url', PACKAGED_RENDERER)).not.toThrow()
    expect(isAllowedNavigationTarget('not a url', PACKAGED_RENDERER)).toBe(false)
    expect(isAllowedNavigationTarget(PACKAGED_RENDERER, 'not a url')).toBe(false)
  })
})
