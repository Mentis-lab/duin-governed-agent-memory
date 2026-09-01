// Run: node --test scripts/   (npm run test:teeth)
//
// NOT vitest. vitest.config.ts's `include` is ['electron/**/*.test.ts', 'src/**/*.test.{ts,tsx}']
// and it explicitly excludes scripts/**, so a vitest-flavoured test here would silently never
// run — and a gate whose own test never runs is precisely the disease this lint was written to
// catch, one level up.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { extractApiGroups, reachedGroups, stripComments } from './preload-surface-lint.mjs'

// The detector written for the window.api.executive gap: six handlers registered, six bindings
// exposed, zero renderer callers, three days unnoticed through a full suite and two lint passes.
//
// Both bugs pinned below were found by RUNNING the lint on the real preload rather than by
// reading it, which is the argument for these tests existing at all: a checker whose first
// output is a false alarm gets skimmed, and a checker that mis-parses reports a comfortable
// zero. Either failure mode is worse than not having it.

describe('extractApiGroups', () => {
  test('finds the top-level members of the exposed object', () => {
    const src = `const api = {
      chat: { send: () => 1 },
      notices: { list: () => 2 },
      setUiZoom: (z) => z
    }`
    assert.deepEqual(extractApiGroups(src), ['chat', 'notices', 'setUiZoom'])
  })

  test('does not mistake a FUNCTION PARAMETER for exposed surface', () => {
    // The real bug: `setUiZoom: (factor: number): void => webFrame.setZoomFactor(factor)` keeps
    // brace depth at 1 through its parameter list, so a brace-only scanner read `factor:` as a
    // member and the first run duly reported `window.api.factor` as dead cross-boundary
    // capability. It is an argument name.
    const src = `const api = {
      setUiZoom: (factor: number): void => webFrame.setZoomFactor(factor),
      resize: (opts: { width: number; height: number }) => go(opts)
    }`
    assert.deepEqual(extractApiGroups(src), ['setUiZoom', 'resize'])
  })

  test('does not descend into nested groups', () => {
    const src = `const api = {
      executive: { pairings: { approve: () => 1, deny: () => 2 } }
    }`
    assert.deepEqual(extractApiGroups(src), ['executive'])
  })

  test('returns nothing when the literal is absent, so the caller can fail loudly', () => {
    // A parse miss must never render as "no dead surface found". The runner treats [] as a
    // hard error rather than a clean bill of health.
    assert.deepEqual(extractApiGroups('export const notApi = { chat: {} }'), [])
  })

  test('ignores a members-shaped thing that only appears inside a comment', () => {
    const src = `const api = {
      /* historical: ghost: { gone: () => 1 }, */
      chat: { send: () => 1 }
    }`
    assert.deepEqual(extractApiGroups(src), ['chat'])
  })
})

describe('reachedGroups', () => {
  test('counts a plain member access', () => {
    assert.deepEqual(reachedGroups(['chat'], ['void window.api.chat.send()']), new Set(['chat']))
  })

  test('counts OPTIONAL chaining, which the first version missed', () => {
    // The other real bug: the initial regex demanded a literal dot and immediately reported
    // `executive` dead — a binding wired minutes earlier through `(window as ...).api?.executive`.
    assert.deepEqual(
      reachedGroups(['executive'], ['const e = (window as X).api?.executive ?? null']),
      new Set(['executive'])
    )
  })

  test('does NOT count a mention inside a comment', () => {
    // The bug being hunted is a surface that is described but never wired, so letting its own
    // documentation vouch for it would defeat the check entirely.
    const sources = [
      '// the api.browser bridge is for a UI we never built',
      '/* api.monitor: reserved */'
    ]
    assert.deepEqual(reachedGroups(['browser', 'monitor'], sources), new Set())
  })

  test('does not let a same-named unrelated property vouch for a group', () => {
    // `stub.monitor` is not `api.monitor`. Requiring the `api.` prefix keeps an unrelated
    // property from marking a dead binding as live.
    assert.deepEqual(reachedGroups(['monitor'], ['stubs.filter((s) => s.monitor)']), new Set())
  })

  test('reports a group referenced nowhere', () => {
    assert.deepEqual(reachedGroups(['ghost'], ['const x = window.api.chat']), new Set())
  })
})

describe('stripComments', () => {
  test('removes block and line comments but leaves a URL alone', () => {
    assert.ok(String(stripComments('a /* x */ b')).includes('a'))
    assert.ok(!String(stripComments('a /* x */ b')).includes('x'))
    assert.ok(!String(stripComments('code // note')).includes('note'))
    // `//` inside a string is preceded by ':' in a URL — the guard keeps it.
    assert.ok(String(stripComments("const u = 'https://example.com'")).includes('https://example.com'))
  })
})
