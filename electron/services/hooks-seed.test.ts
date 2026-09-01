import { describe, it, expect, vi, beforeEach } from 'vitest'
import vm from 'vm'

// Stateful fakes for the two collaborators so we can exercise the seeding
// branches without a real DB or settings file.
let hooksTable: Array<{ event: string; label: string; command: string }>
let settings: Record<string, unknown>

vi.mock('./hooks-store', () => ({
  createHook: vi.fn((input: { event: string; label: string; command: string }) => {
    hooksTable.push({ event: input.event, label: input.label, command: input.command })
    return input
  }),
  listHooks: vi.fn(() => hooksTable)
}))

vi.mock('./settings-helper', () => ({
  readSettings: vi.fn(() => settings),
  patchSettings: vi.fn((patch: Record<string, unknown>) => {
    settings = { ...settings, ...patch }
  })
}))

import { seedDefaultHooks } from './hooks-seed'
import { createHook } from './hooks-store'

beforeEach(() => {
  hooksTable = []
  settings = {}
  vi.clearAllMocks()
})

describe('seedDefaultHooks', () => {
  it('seeds the default set on a fresh install and sets the flag', () => {
    const r = seedDefaultHooks()
    expect(r.seeded).toBe(3)
    expect(hooksTable).toHaveLength(3)
    expect(settings.defaultHooksSeeded).toBe(true)
    // The three sandbox-faithful defaults, one per capability mode.
    expect(hooksTable.map((h) => h.event).sort()).toEqual(
      ['postToolUse', 'preToolUse', 'sessionStart']
    )
    // All seeded as JS hooks.
    expect((createHook as ReturnType<typeof vi.fn>).mock.calls.every((c) => c[0].language === 'js')).toBe(true)
  })

  it('is idempotent — the flag short-circuits a second run (no duplicates)', () => {
    seedDefaultHooks()
    const r2 = seedDefaultHooks()
    expect(r2.seeded).toBe(0)
    expect(r2.skipped).toBe('flag')
    expect(hooksTable).toHaveLength(3)
  })

  it('never resurrects user-deleted hooks: flag unset but table non-empty → skip + set flag', () => {
    hooksTable.push({ event: 'sessionStart', label: 'user hook', command: 'log(1)' })
    const r = seedDefaultHooks()
    expect(r.seeded).toBe(0)
    expect(r.skipped).toBe('non-empty')
    expect(hooksTable).toHaveLength(1) // unchanged
    expect(settings.defaultHooksSeeded).toBe(true) // future runs short-circuit on the flag
  })

  it('the preToolUse guard blocks a catastrophic command but not normal work', () => {
    seedDefaultHooks()
    const guard = hooksTable.find((h) => h.event === 'preToolUse')!
    // Execute the seeded body through the SAME vm path the runner uses
    // (hooks-runner.ts runJsHook): strict-mode IIFE with an `args` binding,
    // throw-to-block. `guard.command` is our own seeded constant, not input.
    const run = (command: string): string | null => {
      const sandbox: Record<string, unknown> = { args: { command }, log: () => {} }
      const ctx = vm.createContext(sandbox)
      try {
        new vm.Script(`(function(){ "use strict";\n${guard.command}\n})()`).runInContext(ctx, {
          timeout: 1000
        })
        return null
      } catch (e) {
        return String(e)
      }
    }
    expect(run('rm -rf /')).toContain('blocked a destructive command')
    expect(run('rm -rf ~')).toContain('blocked')
    expect(run('rm -rf .')).toContain('blocked') // bare cwd recursive
    expect(run('rm -rf *')).toContain('blocked')
    expect(run('rm -rf /*')).toContain('blocked')
    expect(run('format c:')).toContain('blocked')
    expect(run(':(){ :|:& };:')).toContain('blocked') // fork bomb
    // Normal commands pass through untouched.
    expect(run('npm run build')).toBeNull()
    expect(run('git status')).toBeNull()
    expect(run('rm -rf ./dist/tmp')).toBeNull() // scoped relative path is fine
    expect(run('rm -rf node_modules')).toBeNull() // scoped name is fine
  })
})
