// GovernProvenance.jury — the juror count the govern loop now writes (W4) survives the disk.
//
// The field is what makes "crossModel:false because nobody answered" distinguishable from
// "crossModel:false because one family sat alone" in the audit (property 3: provenance is recorded,
// never inferred). A persisted row is read back through setOperatorModelPath, the same path the
// 5-minute projector and the govern audit use, so this is the round trip that matters.

import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  setOperatorModelPath,
  recordFacts,
  getOperatorFacts,
  recordGovernProvenance,
  buildGovernAudit,
  __resetOperatorModel,
  type GovernProvenance
} from './operator-model'

beforeEach(() => __resetOperatorModel())

describe('GovernProvenance.jury round-trips through operator-model.json', () => {
  it('a row with jury: "none" and one with a count come back exactly as written', () => {
    const dir = mkdtempSync(join(tmpdir(), 'duin-opmodel-jury-'))
    setOperatorModelPath(dir)
    recordFacts([{ fact: 'Truth over comfort' }, { fact: 'Lead with the outcome' }])
    const a = getOperatorFacts().find((f) => f.fact === 'Truth over comfort')!
    const b = getOperatorFacts().find((f) => f.fact === 'Lead with the outcome')!
    const none: GovernProvenance = {
      juryModelId: null,
      juryProvider: null,
      crossModel: false,
      verdict: 'hold',
      behavioralFlip: null,
      ts: 100,
      jury: 'none'
    }
    const three: GovernProvenance = {
      juryModelId: 'jury-a+jury-b+jury-c',
      juryProvider: 'openai+google+xai',
      crossModel: true,
      verdict: 'confirm',
      behavioralFlip: null,
      ts: 200,
      earned: 2,
      observed: 3,
      jury: 3
    }
    recordGovernProvenance(a.id, none)
    recordGovernProvenance(b.id, three)

    // On disk, verbatim.
    const raw = JSON.parse(readFileSync(join(dir, 'operator-model.json'), 'utf-8')) as {
      facts: Array<{ id: string; govern?: GovernProvenance }>
    }
    expect(raw.facts.find((f) => f.id === a.id)?.govern).toEqual(none)
    expect(raw.facts.find((f) => f.id === b.id)?.govern).toEqual(three)

    // And back through the loader.
    __resetOperatorModel()
    expect(getOperatorFacts()).toHaveLength(0)
    setOperatorModelPath(dir)
    const again = getOperatorFacts()
    expect(again.find((f) => f.id === a.id)?.govern).toEqual(none)
    expect(again.find((f) => f.id === b.id)?.govern).toEqual(three)
    expect(again.find((f) => f.id === a.id)?.govern?.jury).toBe('none')
    expect(again.find((f) => f.id === b.id)?.govern?.jury).toBe(3)
  })

  it('a row recorded before the field existed reads back with jury absent — never invented', () => {
    const dir = mkdtempSync(join(tmpdir(), 'duin-opmodel-jury-legacy-'))
    setOperatorModelPath(dir)
    recordFacts([{ fact: 'Verify before claiming' }])
    const f = getOperatorFacts().find((x) => x.fact === 'Verify before claiming')!
    recordGovernProvenance(f.id, {
      juryModelId: 'm1',
      juryProvider: 'deepseek',
      crossModel: true,
      verdict: 'confirm',
      behavioralFlip: true,
      ts: 300
    })
    __resetOperatorModel()
    setOperatorModelPath(dir)
    const back = getOperatorFacts().find((x) => x.id === f.id)!
    expect(back.govern?.jury).toBeUndefined()
    expect('jury' in (back.govern ?? {})).toBe(false)
    // The audit still lists the row (it does not require the new field), and a row that has it
    // shows it there too — the govern audit is the surface that reads the count.
    const audit = buildGovernAudit()
    expect(audit.facts.some((x) => x.id === f.id)).toBe(true)
    recordGovernProvenance(f.id, { ...back.govern!, jury: 2 })
    expect(buildGovernAudit().facts.find((x) => x.id === f.id)?.govern?.jury).toBe(2)
  })
})
