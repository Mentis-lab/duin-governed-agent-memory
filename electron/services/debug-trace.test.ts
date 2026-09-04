import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { setDebugTraceUserDataPath, trace } from './debug-trace'
import { __resetMainLogForTest, mainLogStatus } from './main-log'

// P0 audit E2 (2026-09-03): an isolated instance seeded with `debugTrace: true` booted with
// main.log NON-verbose. trace() had run before the userData provider was set, cached "no provider
// → off" for ENABLED_TTL_MS, and setDebugTraceUserDataPath read that cache into initMainLog. The
// provider change now invalidates the cache, and every fresh read keeps main-log's gate in step.
describe('debug-trace → main-log verbose wiring', () => {
  let dir: string
  beforeEach(() => {
    __resetMainLogForTest()
    dir = mkdtempSync(join(tmpdir(), 'duin-debug-trace-'))
  })
  afterEach(() => {
    setDebugTraceUserDataPath(null)
    __resetMainLogForTest()
    rmSync(dir, { recursive: true, force: true })
  })

  it('a trace() before the provider is set does not pin main.log non-verbose', () => {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ debugTrace: true }))
    setDebugTraceUserDataPath(null)
    trace('early', {}) // caches "off" — there is no provider yet
    setDebugTraceUserDataPath(() => dir)
    expect(mainLogStatus().verbose).toBe(true)
  })

  it('without the flag main.log stays warn-level', () => {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({}))
    setDebugTraceUserDataPath(() => dir)
    expect(mainLogStatus().verbose).toBe(false)
  })
})
