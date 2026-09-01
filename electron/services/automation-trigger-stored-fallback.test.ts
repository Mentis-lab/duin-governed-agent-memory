import { describe, it, expect } from 'vitest'
import {
  parseStoredAutomationTrigger,
  unrunnableTriggerReason,
  type AutomationTrigger
} from './automation-trigger'

// The aggravator behind the cron-parser divergence: `parseStoredAutomationTrigger`'s
// legacy fallback `return legacyCronTrigger(legacyCron)` sat OUTSIDE the try.
//
// It runs on every row of every `listAutomations()`, which `tick()` calls every 60s
// inside `try { … } catch { return }`. So ONE row whose `cron` column no longer parses
// made fromRow throw -> listAutomations throw -> tick bail -> every automation stop
// being scheduled, panel blank, nothing logged as a failure. The blast radius of a
// single bad row was the whole scheduler.
//
// It must not throw, and it must not silently pretend the row is fine either.

describe('parseStoredAutomationTrigger — one bad row must not take the scheduler down', () => {
  it('reads a well-formed trigger JSON', () => {
    const t = parseStoredAutomationTrigger(
      JSON.stringify({ kind: 'schedule', cron: '0 9 * * *' }),
      ''
    )
    expect(t.kind).toBe('schedule')
    expect((t as { cron?: string }).cron).toBe('0 9 * * *')
    expect(unrunnableTriggerReason(t)).toBeNull()
  })

  it('falls back to the legacy cron column when the trigger JSON is malformed', () => {
    const t = parseStoredAutomationTrigger('{not json', '0 9 * * *')
    expect((t as { cron?: string }).cron).toBe('0 9 * * *')
    expect(unrunnableTriggerReason(t)).toBeNull()
  })

  it('does NOT throw when the legacy cron column is itself unparseable', () => {
    // e.g. a hand-edited DB, or an expression the converged (stricter) parser now
    // correctly rejects.
    let t: AutomationTrigger | undefined
    expect(() => {
      t = parseStoredAutomationTrigger(null, '5abc * * * *')
    }).not.toThrow()
    expect(t).toBeDefined()
  })

  it('does NOT throw when BOTH the trigger JSON and the cron column are unusable', () => {
    expect(() => parseStoredAutomationTrigger('{"kind":"nope"}', '')).not.toThrow()
  })

  it('reports the unreadable row instead of silently pretending it is schedulable', () => {
    const t = parseStoredAutomationTrigger(null, '1-2000000/1 * * * *')
    const reason = unrunnableTriggerReason(t)
    expect(reason).toBeTruthy()
    expect(reason).toMatch(/could not be read/)
  })
})
