// WS0.1 (telos-read) tests. Covers: per-track telos populated from a fixture GOALS
// doc (ON); lane stamping (ProjectB/personal/Nora → confidential, the rest → open);
// missing GOALS graceful; the cache reads GOALS once; and the regression guard — OFF is
// byte-identical (no telos field, priors unchanged, GOALS never read).
//
// Cold-start A3 emptied the BUILT-IN ontology tracks, and loadTelos/worldState now read the
// PER-VAULT ontology. So the fixture declares its own tracks (`.duin/ontology.json` for the
// integration tests, a literal list for the pure parse tests) instead of borrowing one operator's
// six real lanes from a compiled-in constant.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { worldState } from './world-state-native'
import {
  parseGoals,
  loadTelos,
  laneOf,
  telosEnabled,
  clearTelosCache,
  telosReads,
  LANE_MAP,
  type Telos
} from './telos-native'
import { clearOntologyCache } from './ontology'

// Two of these keys (`ProjectB`, `SupplierCo`) are the keys LANE_MAP itself is stated against, so
// the lane stamping is exercised for real rather than only via the tolerant fallback.
const TRACKS = [
  { key: 'alpha', match: /alpha/i },
  { key: 'beta', match: /\bbeta\b/i },
  { key: 'gamma', match: /gamma/i },
  { key: 'ProjectB', match: /projectb/i },
  { key: 'SupplierCo', match: /supplierco/i },
  { key: 'personal', match: /personal/i }
]
const KEYS = TRACKS.map((t) => t.key)
const ONTOLOGY_JSON = {
  tracks: TRACKS.map((t) => ({ key: t.key, match: t.match.source }))
}

// A clean fixture: one heading per declared track, each with a clear objective line.
const FIXTURE_GOALS = `---
type: strategic-goals
---

# GOALS

## Current Cycle: Q2 2026

### Track 1 · Alpha — distribution
**Role:** BD Lead — maximize resource-barter partnerships to reduce cash CAC.

### Track 2 · Beta, Inc. — M&A Consulting
**Objective:** Secure overseas business models for the Japanese market.

### Track 3 · Gamma / harness
**Goal:** Make the harness the highest-fidelity operating partner.

### Track 4 · ProjectB · Lane B (Confidential)
**Goal:** Career optionality — potential join of a fund (isolated from Beta work).

### Track 5 · SupplierCo / Nora
**Mission:** Support Nora's transition out of her current industry.

### Track 6 · Personal
**Goal:** Longevity via data-driven health protocols and travel cadence.
`

let dir: string
const prev = process.env.DUIN_TELOS

const writeOntology = (): void => {
  mkdirSync(join(dir, '.duin'), { recursive: true })
  writeFileSync(join(dir, '.duin', 'ontology.json'), JSON.stringify(ONTOLOGY_JSON))
  clearOntologyCache()
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'telos-'))
  writeOntology()
  clearTelosCache()
})
afterEach(() => {
  if (prev === undefined) delete process.env.DUIN_TELOS
  else process.env.DUIN_TELOS = prev
  clearTelosCache()
  clearOntologyCache()
  rmSync(dir, { recursive: true, force: true })
})

// ── pure parse ─────────────────────────────────────────────────────────────

describe('parseGoals — heading → track-key mapping', () => {
  it('maps each declared track heading to its objective line', () => {
    const m = parseGoals(FIXTURE_GOALS, TRACKS)
    expect(m['alpha']).toMatch(/resource-barter/)
    expect(m['beta']).toMatch(/Japanese market/)
    expect(m['gamma']).toMatch(/highest-fidelity/)
    expect(m['ProjectB']).toMatch(/career optionality/i)
    expect(m['SupplierCo']).toMatch(/Support Nora/)
    expect(m['personal']).toMatch(/Longevity/)
  })

  it('falls back to the de-numbered heading title when no objective line', () => {
    const md = '## X\n### Track 1 · Alpha sprint\nsome prose, no bold objective\n'
    const m = parseGoals(md, TRACKS)
    expect(m['alpha']).toBe('Alpha sprint')
  })

  it('first section wins for a repeated key (Current-Cycle before cross-cycle)', () => {
    const md = '### Track 1 · Alpha first\n**Goal:** aaa\n\n### 1. Alpha restated\n**Goal:** bbb\n'
    expect(parseGoals(md, TRACKS)['alpha']).toBe('aaa')
  })

  it('unmatched keys stay null; body keyword bleed does not mis-map', () => {
    // A ProjectB section body mentions "Beta" — heading-only mapping must NOT route it to the
    // beta track.
    const md = '### Track · ProjectB Lane\n**Goal:** join fund (isolated from Beta work)\n'
    const m = parseGoals(md, TRACKS)
    expect(m['ProjectB']).toMatch(/join fund/)
    expect(m['beta']).toBeNull()
    expect(m['SupplierCo']).toBeNull()
  })
})

// ── lane stamping ────────────────────────────────────────────────────────────

describe('laneOf / LANE_MAP — the lane guard', () => {
  it('the Lane-B + personal + Nora tracks are confidential; the rest open', () => {
    expect(laneOf('ProjectB')).toBe('confidential:projectb')
    expect(laneOf('SupplierCo')).toBe('confidential:personal')
    expect(laneOf('personal')).toBe('confidential:personal')
    expect(laneOf('alpha')).toBe('open')
    expect(laneOf('beta')).toBe('open')
    expect(laneOf('gamma')).toBe('open')
  })

  it('tolerant fallback covers lowercase / alias keys', () => {
    expect(laneOf('projectb')).toBe('confidential:projectb')
    expect(laneOf('my-supplierco-lane')).toBe('confidential:personal')
    expect(laneOf('supplierco')).toBe('confidential:personal')
    expect(laneOf('anything-else')).toBe('open')
  })

  it('LANE_MAP names the confidential keys explicitly', () => {
    expect(LANE_MAP.ProjectB).toBe('confidential:projectb')
    expect(LANE_MAP['SupplierCo']).toBe('confidential:personal')
    expect(LANE_MAP.personal).toBe('confidential:personal')
  })
})

// ── loadTelos: cache + graceful ──────────────────────────────────────────────

describe('loadTelos — cache + missing-file graceful', () => {
  it('missing GOALS.md → all telos.text null, lanes still stamped, no throw', () => {
    const m = loadTelos(dir) // no GOALS.md written
    for (const k of KEYS) expect(m[k].text).toBeNull()
    expect(m['ProjectB'].lane).toBe('confidential:projectb')
    expect(m['alpha'].lane).toBe('open')
    expect(telosReads()).toBe(0) // a failed read does not count
  })

  it('reads GOALS.md exactly once across repeated calls (cache)', () => {
    writeFileSync(join(dir, 'GOALS.md'), FIXTURE_GOALS)
    expect(telosReads()).toBe(0)
    const a = loadTelos(dir)
    const b = loadTelos(dir)
    const c = loadTelos(dir)
    expect(telosReads()).toBe(1) // parsed once
    expect(a).toBe(b) // same cached object reference
    expect(b).toBe(c)
    expect(a['beta'].text).toMatch(/Japanese market/)
  })

  it('a vault with no declared tracks yields an empty telos map (A3 default)', () => {
    const bare = mkdtempSync(join(tmpdir(), 'telos-bare-'))
    try {
      writeFileSync(join(bare, 'GOALS.md'), FIXTURE_GOALS)
      expect(loadTelos(bare)).toEqual({})
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })
})

// ── worldState integration: ON attaches, OFF byte-identical ──────────────────

describe('worldState — DUIN_TELOS ON attaches lane-stamped telos', () => {
  beforeEach(() => {
    process.env.DUIN_TELOS = '1'
    writeFileSync(join(dir, 'GOALS.md'), FIXTURE_GOALS)
    clearTelosCache()
  })

  it('every track carries a telos; text from GOALS, lane from LANE_MAP', () => {
    expect(telosEnabled()).toBe(true)
    const ws = worldState(dir, new Date('2026-07-08T00:00:00Z'))
    const byKey = new Map(ws.tracks.map((t) => [t.key as string, t.telos as Telos]))

    expect(byKey.get('alpha')).toEqual({
      text: expect.stringMatching(/resource-barter/),
      lane: 'open'
    })
    expect(byKey.get('beta')!.lane).toBe('open')
    expect(byKey.get('beta')!.text).toMatch(/Japanese market/)

    // confidential lanes stamped from turn one
    expect(byKey.get('ProjectB')!.lane).toBe('confidential:projectb')
    expect(byKey.get('ProjectB')!.text).toMatch(/career optionality/i)
    expect(byKey.get('SupplierCo')!.lane).toBe('confidential:personal')
    expect(byKey.get('personal')!.lane).toBe('confidential:personal')

    // every declared track got a telos object
    for (const k of KEYS) expect(byKey.get(k)).toBeTruthy()
  })

  it('ON + missing GOALS → telos present but text null, lanes still stamped', () => {
    rmSync(join(dir, 'GOALS.md'))
    clearTelosCache()
    const ws = worldState(dir, new Date('2026-07-08T00:00:00Z'))
    expect(ws.tracks.length).toBe(KEYS.length)
    for (const t of ws.tracks) {
      expect((t.telos as Telos).text).toBeNull()
      expect((t.telos as Telos).lane).toBe(laneOf(t.key as string))
    }
  })
})

describe('worldState — DUIN_TELOS OFF is byte-identical (regression guard)', () => {
  it('no telos field on any track, priors unchanged, GOALS never read', () => {
    delete process.env.DUIN_TELOS
    writeFileSync(join(dir, 'GOALS.md'), FIXTURE_GOALS) // present but must be ignored
    clearTelosCache()
    expect(telosEnabled()).toBe(false)

    const ws = worldState(dir, new Date('2026-07-08T00:00:00Z'))
    expect(ws.tracks.length).toBe(KEYS.length)
    // no telos key anywhere
    for (const t of ws.tracks) expect('telos' in t).toBe(false)
    expect(JSON.stringify(ws)).not.toContain('telos')
    // priors label unchanged
    expect(ws.priors).toBe('me.md · GOALS.md (canonical — read, not copied)')
    // GOALS was never read
    expect(telosReads()).toBe(0)
  })

  it('empty string / "0" are also OFF (only "1" arms it)', () => {
    writeFileSync(join(dir, 'GOALS.md'), FIXTURE_GOALS)
    for (const v of ['', '0', 'true', 'yes']) {
      process.env.DUIN_TELOS = v
      clearTelosCache()
      const ws = worldState(dir, new Date('2026-07-08T00:00:00Z'))
      for (const t of ws.tracks) expect('telos' in t).toBe(false)
      expect(telosReads()).toBe(0)
    }
  })

  it('OFF vs ON differ ONLY by the appended telos field', () => {
    writeFileSync(join(dir, 'GOALS.md'), FIXTURE_GOALS)

    delete process.env.DUIN_TELOS
    clearTelosCache()
    const off = worldState(dir, new Date('2026-07-08T00:00:00Z'))

    process.env.DUIN_TELOS = '1'
    clearTelosCache()
    const on = worldState(dir, new Date('2026-07-08T00:00:00Z'))

    // strip telos off the ON tracks → must equal the OFF result exactly
    const stripped = {
      ...on,
      tracks: on.tracks.map((t) => {
        const { telos, ...rest } = t as Record<string, unknown>
        void telos
        return rest
      })
    }
    expect(stripped).toEqual(off)
  })
})
