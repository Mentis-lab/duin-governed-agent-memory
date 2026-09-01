// GOLDEN output locks for the strategies port (listStrategies / listMentalModels).
// Freezes the exact array passthrough + the static MODEL_TEMPLATES shape and the
// per-model `type` default, so a refactor of the template map or the reader can't
// silently drift the mental-models surface. Deterministic (WS0 parity net).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { listStrategies, listMentalModels } from './strategies-native'

describe('strategies-native — golden output locks (parity net)', () => {
  let dir: string
  const st = (): string => join(dir, '.duin', '_state')
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'duin-strat-gold-'))
    mkdirSync(st(), { recursive: true })
    writeFileSync(
      join(st(), 'strategies.json'),
      JSON.stringify([{ id: 's1', type: 'principle', statement: 'Ship small' }, { id: 's2', lens: 'first-principles' }])
    )
  })
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('listStrategies — exact array passthrough', () => {
    expect(JSON.stringify(listStrategies(dir))).toBe(
      '{"strategies":[{"id":"s1","type":"principle","statement":"Ship small"},{"id":"s2","lens":"first-principles"}]}'
    )
  })

  it('listMentalModels — per-model type default + full static templates', () => {
    expect(JSON.stringify(listMentalModels(dir))).toBe(
      '{"models":[{"id":"s1","type":"principle","statement":"Ship small"},{"id":"s2","lens":"first-principles","type":"strategy"}],"templates":{"strategy":[{"key":"aspiration","label":"Goals & aspirations"},{"key":"where_to_play","label":"Where to play"},{"key":"how_to_win","label":"How to win"},{"key":"capabilities","label":"Capabilities"},{"key":"values","label":"Values / guardrails"}],"principle":[{"key":"statement","label":"The principle"},{"key":"why","label":"Why it holds"},{"key":"applies_when","label":"When it applies"},{"key":"examples","label":"In practice"}],"lens":[{"key":"lens","label":"The lens"},{"key":"reveals","label":"What it surfaces"},{"key":"prompts","label":"Questions it prompts"},{"key":"watch_fors","label":"Watch-fors"}],"framework":[{"key":"steps","label":"The steps"},{"key":"use_when","label":"When to use it"},{"key":"io","label":"Inputs → outputs"},{"key":"examples","label":"In practice"}],"playbook":[{"key":"trigger","label":"Trigger"},{"key":"plays","label":"Plays / steps"},{"key":"watch_fors","label":"Watch-fors"},{"key":"examples","label":"In practice"}]}}'
    )
  })
})
