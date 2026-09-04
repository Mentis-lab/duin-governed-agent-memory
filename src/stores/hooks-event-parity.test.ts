// Backlog finding 68. The renderer carries its OWN HookEvent union, and it had drifted:
// the main process fired more events than this copy declared, so the autonomy lifecycle
// events (automations-runner, workflow-runner) fired in production every day with no way
// for a user hook to subscribe to any of them. The Settings UI simply had no such option.
// (The two loop events that were ALSO declared turned out to be fired by nothing, and
// were removed from both sides on 2026-09-03.)
//
// Pinned against the main-process source so the two copies cannot drift again in
// silence. Source-level because the renderer cannot import the electron module.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (...p: string[]): string => readFileSync(join(__dirname, '..', '..', ...p), 'utf-8')

/** Members of the `export type HookEvent = | 'a' | 'b'` union in a source file.
 *  Stops at the first line that is not a `| 'member'` continuation, so it cannot run on
 *  into the next declaration (HookLanguage's 'js' | 'shell' is right below it). */
function unionMembers(src: string): string[] {
  const lines = src.split(String.fromCharCode(10))
  const start = lines.findIndex((l) => l.startsWith('export type HookEvent ='))
  expect(start, 'HookEvent union not found').toBeGreaterThan(-1)
  const out: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    // Comment and blank lines sit INSIDE both unions (the F3 block has a rationale
    // comment mid-list), so they must not terminate the scan.
    if (/^\s*(\/\/|$)/.test(line)) continue
    const m = /^\s*\|\s*'([a-zA-Z]+)'\s*$/.exec(line)
    if (!m) break
    out.push(m[1])
  }
  expect(out.length, 'parsed no members').toBeGreaterThan(0)
  return out
}

describe('HookEvent parity between main and renderer', () => {
  const main = unionMembers(read('electron', 'services', 'hooks-store.ts'))
  const renderer = unionMembers(read('src', 'stores', 'hooks-store.ts'))

  it('the renderer knows every event the main process can fire', () => {
    const missing = main.filter((e) => !renderer.includes(e))
    expect(missing, `renderer is missing: ${missing.join(', ')}`).toEqual([])
  })

  it('the renderer invents no event the main process cannot fire', () => {
    const extra = renderer.filter((e) => !main.includes(e))
    expect(extra, `renderer has phantom events: ${extra.join(', ')}`).toEqual([])
  })

  it('the Settings UI offers every event, not just the interactive ones', () => {
    // The union being right is not enough — EVENT_OPTIONS is what the operator sees.
    const ui = read('src', 'components', 'settings', 'HooksSettings.tsx')
    // From the opening `= [` to the closing bracket at column 0. Slicing to the first
    // ']' would stop inside `HookEvent[]` on the declaration line and match nothing.
    const declAt = ui.indexOf('const EVENT_OPTIONS')
    const openAt = ui.indexOf('[', ui.indexOf('=', declAt))
    const closeAt = ui.indexOf(String.fromCharCode(10) + ']', openAt)
    const opts = ui.slice(openAt, closeAt)
    const offered = [...opts.matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1])
    const missing = main.filter((e) => !offered.includes(e))
    expect(missing, `fired in production but not offered in Settings: ${missing.join(', ')}`).toEqual([])
  })

  it('the autonomy lifecycle events are specifically present', () => {
    // loopStarted / loopIterationDone are NOT here: they were declared on both sides but
    // nothing in main ever fired them (loop-controller has no fireHooks call), so both
    // unions dropped them on 2026-09-03 and Settings stopped offering them.
    for (const e of ['automationStarted', 'automationDone', 'workflowStarted', 'workflowFinished']) {
      expect(renderer, e).toContain(e)
    }
  })

  it('the two never-fired loop events are gone from the renderer and from Settings', () => {
    const ui = read('src', 'components', 'settings', 'HooksSettings.tsx')
    for (const e of ['loopStarted', 'loopIterationDone']) {
      expect(renderer, e).not.toContain(e)
      expect(ui.includes(`'${e}'`), `${e} still offered in Settings`).toBe(false)
    }
  })
})
