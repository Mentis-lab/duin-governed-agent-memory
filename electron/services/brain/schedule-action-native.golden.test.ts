// GOLDEN for the loops.yaml CRUD port (scheduleAction) — add/edit/pause/resume/
// remove round-tripped through listSchedules, plus schedule-string parsing.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { scheduleAction, listSchedules } from './loop-artifacts-native'

describe('loop-artifacts-native — scheduleAction (loops.yaml CRUD)', () => {
  let dir: string
  const now = new Date(2026, 6, 7, 12, 0, 0)
  const rows = () => listSchedules(dir, now).schedules
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'duin-sched-'))
  })
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('add creates a loop readable by listSchedules; rejects duplicates', () => {
    const r = scheduleAction(dir, { action: 'add', name: 'nightly', schedule: 'daily@21:30', executor: 'brain', target: 'do it', note: 'EOD' })
    expect(r.ok).toBe(true)
    const row = rows().find((x) => x.name === 'nightly')!
    expect(row).toMatchObject({ name: 'nightly', schedule: 'daily@21:30', executor: 'brain', target: 'do it', enabled: true, note: 'EOD' })
    expect(scheduleAction(dir, { action: 'add', name: 'nightly', schedule: 'every:6h', target: 't' }).ok).toBe(false)
  })

  it('parses every/weekly schedule strings; add needs name+schedule+target', () => {
    scheduleAction(dir, { action: 'add', name: 'hourly', schedule: 'every:6h', target: 't' })
    scheduleAction(dir, { action: 'add', name: 'wk', schedule: 'weekly:sun@18:00', target: 't', executor: 'signal' })
    expect(rows().find((x) => x.name === 'hourly')!.schedule).toBe('every:6h')
    expect(rows().find((x) => x.name === 'wk')!.schedule).toBe('weekly:sun@18:00')
    expect(scheduleAction(dir, { action: 'add', name: 'x' }).ok).toBe(false) // missing schedule+target
  })

  it('pause/resume toggle enabled; edit changes fields; remove drops it', () => {
    scheduleAction(dir, { action: 'add', name: 'a', schedule: 'daily@09:00', target: 't' })
    expect(scheduleAction(dir, { action: 'pause', name: 'a' }).message).toBe("paused 'a'")
    expect(rows().find((x) => x.name === 'a')!.enabled).toBe(false)
    scheduleAction(dir, { action: 'resume', name: 'a' })
    expect(rows().find((x) => x.name === 'a')!.enabled).toBe(true)
    scheduleAction(dir, { action: 'edit', name: 'a', executor: 'brain' })
    expect(rows().find((x) => x.name === 'a')!.executor).toBe('brain')
    expect(scheduleAction(dir, { action: 'remove', name: 'a' }).message).toBe("removed 'a'")
    expect(rows().find((x) => x.name === 'a')).toBeUndefined()
    expect(scheduleAction(dir, { action: 'remove', name: 'ghost' }).message).toBe("no loop named 'ghost'")
  })
})
