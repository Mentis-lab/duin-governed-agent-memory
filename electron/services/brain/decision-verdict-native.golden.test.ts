// GOLDEN for the decision_verdict.py port — the 3-effect write (frontmatter
// verdict + ## Updates prepend + decision-outcomes.jsonl row). Pins each effect.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { recordVerdict } from './decision-verdict-native'

describe('decision-verdict-native — golden (3-effect write)', () => {
  let dir: string
  const decPath = (name: string): string => join(dir, 'DUIN', 'Decisions', name)
  const now = new Date(2026, 6, 7) // 2026-07-07
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'duin-verdict-'))
    mkdirSync(join(dir, 'DUIN', 'Decisions'), { recursive: true })
  })
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('inserts verdict before tags:, prepends ## Updates, appends ledger row', () => {
    writeFileSync(
      decPath('dec1.md'),
      ['---', 'surfaced_by: TQ', 'review_on: 2026-07-01', 'reversibility: low', 'tags: [decision]', '---', '# Ship it', '', '## Updates', '- 2026-06-01 — created', ''].join('\n'),
      'utf-8'
    )
    const r = recordVerdict(dir, 'dec1', 'right', 'paid off', now)
    expect(r.ok).toBe(true)
    const out = readFileSync(decPath('dec1.md'), 'utf-8')
    // effect 1: verdict inserted right before tags:
    expect(out).toContain('verdict: right\ntags: [decision]')
    // effect 2: newest-first line under ## Updates
    expect(out).toContain('## Updates\n- 2026-07-07 — verdict: **right** — paid off\n- 2026-06-01 — created')
    // effect 3: ledger row (Python json.dumps spacing)
    const ledger = readFileSync(join(dir, '.duin', '_state', 'decision-outcomes.jsonl'), 'utf-8').trim()
    expect(JSON.parse(ledger)).toEqual({
      ts: '2026-07-07',
      id: 'dec1',
      title: 'Ship it',
      surfaced_by: 'TQ',
      reversibility: 'low',
      review_on: '2026-07-01',
      verdict: 'right',
      note: 'paid off'
    })
    expect(ledger.startsWith('{"ts": "2026-07-07", "id": "dec1"')).toBe(true) // spaced separators
  })

  it('creates ## Updates when absent; appends verdict when no tags:', () => {
    writeFileSync(decPath('d2.md'), ['---', 'surfaced_by: self', '---', '# Title only', ''].join('\n'), 'utf-8')
    recordVerdict(dir, 'd2', 'partial', 'mixed', now)
    const out = readFileSync(decPath('d2.md'), 'utf-8')
    expect(out).toContain('surfaced_by: self\nverdict: partial') // appended to fm (no tags)
    expect(out).toContain('## Updates\n- 2026-07-07 — verdict: **partial** — mixed')
  })

  it('rejects a bad verdict; reports not-found', () => {
    expect(recordVerdict(dir, 'd2', 'maybe', 'x', now).ok).toBe(false)
    expect(recordVerdict(dir, 'nope', 'right', 'x', now)).toEqual({ ok: false, error: 'decision not found: nope' })
    expect(existsSync(join(dir, '.duin', '_state', 'decision-outcomes.jsonl'))).toBe(false)
  })
})
