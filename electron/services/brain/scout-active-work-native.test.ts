import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  recentVaultEdits,
  buildScoutPrompt,
  runScout,
  scoutActiveWork,
  __resetScoutDebounceForTesting
} from './scout-active-work-native'
import { listCascadePending } from './cascade-native'

const NOW = new Date(2026, 6, 3, 12, 0, 0)

describe('scout — recentVaultEdits (vault walk)', () => {
  let vault: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-rve-'))
    mkdirSync(join(vault, '04 Notes'), { recursive: true })
    mkdirSync(join(vault, '04 Notes', '_internal'), { recursive: true })
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('returns recently-edited .md notes, excluding underscored/Template/ARGOSY + old files', () => {
    const fresh = join(vault, '04 Notes', 'Fresh idea.md')
    writeFileSync(fresh, '---\ntype: note\n---\n\nWorking on the TapTap launch plan today.')
    const tmpl = join(vault, '04 Notes', 'Template note.md')
    writeFileSync(tmpl, 'ignore me')
    const under = join(vault, '04 Notes', '_scratch.md')
    writeFileSync(under, 'ignore me too')
    const nested = join(vault, '04 Notes', '_internal', 'hidden.md')
    writeFileSync(nested, 'ignore nested underscore dir')
    const old = join(vault, '04 Notes', 'Old note.md')
    writeFileSync(old, 'ancient')
    const oldT = new Date(2026, 0, 1).getTime() / 1000
    utimesSync(old, oldT, oldT)

    const edits = recentVaultEdits(vault, { now: () => NOW })
    expect(edits.map((e) => e.title)).toEqual(['Fresh idea'])
    expect(edits[0].snippet).toBe('Working on the TapTap launch plan today.') // frontmatter stripped
    expect(edits[0].path).toBe('04 Notes/Fresh idea.md')
  })
})

describe('scout — buildScoutPrompt (PURE)', () => {
  it('embeds signals + open-task guard + lane enum', () => {
    const p = buildScoutPrompt(
      [{ mt: 0, path: 'p', title: 'Note A', snippet: 'snip' }],
      [{ title: 'Move', track: '北澜' }],
      ['existing task'],
      '北澜|orbis'
    )
    expect(p).toContain("DUIN's proactive SCOUT")
    expect(p).toContain('RECENT EDITS: [{"note":"Note A","snippet":"snip"}]')
    expect(p).toContain('ENGAGED MOVES: [{"title":"Move","track":"北澜"}]')
    expect(p).toContain('OPEN TASKS (do NOT duplicate): ["existing task"]')
    expect(p).toContain('Pick the track lane from: 北澜|orbis.')
  })
})

describe('scout — runScout', () => {
  let vault: string
  let sd: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-scout-'))
    sd = join(vault, '.duin', '_state')
    mkdirSync(sd, { recursive: true })
    mkdirSync(join(vault, '04 Notes'), { recursive: true })
    writeFileSync(join(vault, '04 Notes', 'Signal.md'), 'Working on the Bilibili event booth design.')
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('stages judged work-items, deduped against open tasks', async () => {
    // one open task that should suppress a duplicate scout proposal
    mkdirSync(join(vault, '06 Tasks'), { recursive: true })
    writeFileSync(join(vault, '06 Tasks', 'Inbox.md'), '- [ ] Bilibili booth logistics {{duinTaskId:: t1}}\n')
    let pass = 0
    const generate = async (): Promise<string> => {
      pass++
      if (pass === 1) {
        return JSON.stringify([
          { title: 'Prepare the keynote deck', track: '北澜' }, // fresh — no token overlap with the open task
          { title: 'Bilibili booth logistics', track: '北澜' } // shares bilibili+booth → entityMatch dup → dropped
        ])
      }
      return JSON.stringify([{ idx: 0, keep: true }, { idx: 1, keep: true }])
    }
    const n = await runScout(vault, { generate, now: () => NOW, uid: () => 'sc0' })
    expect(n).toBe(1) // the logistics dup was filtered by entityMatch vs the open task
    const pend = listCascadePending(vault).pending
    expect(pend).toHaveLength(1)
    expect(pend[0]).toMatchObject({ kind: 'active-work', source: 'scout', proposal: { title: 'Prepare the keynote deck' } })
  })

  it('does nothing with no signals', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'duin-bare-'))
    mkdirSync(join(bare, '.duin', '_state'), { recursive: true })
    let called = false
    const n = await runScout(bare, { generate: async () => { called = true; return '[]' }, now: () => NOW })
    expect(n).toBe(0)
    expect(called).toBe(false)
    rmSync(bare, { recursive: true, force: true })
  })
})

describe('scout — scoutActiveWork (debounce)', () => {
  beforeEach(() => __resetScoutDebounceForTesting())

  it('debounces within 2h, bypassed by force', () => {
    const deps = { generate: async () => '[]' }
    const t0 = 10_000_000
    expect(scoutActiveWork('/nope', deps, { nowMs: t0 })).toEqual({ ok: true, scanning: true }) // first run
    expect(scoutActiveWork('/nope', deps, { nowMs: t0 + 60_000 })).toEqual({ ok: true, skipped: 'debounced' })
    // force bypasses AND updates the timestamp (to t0+60_000)
    expect(scoutActiveWork('/nope', deps, { nowMs: t0 + 60_000, force: true })).toEqual({ ok: true, scanning: true })
    // 2h after the last run (t0+60_000) → runs again
    expect(scoutActiveWork('/nope', deps, { nowMs: t0 + 60_000 + 7_200_000 })).toEqual({ ok: true, scanning: true })
  })
})
