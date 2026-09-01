import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { listDetectors } from './detectors-native'

describe('listDetectors', () => {
  let vault: string
  let sd: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-dt-'))
    sd = join(vault, '.duin', '_state')
    mkdirSync(join(vault, '.duin', 'routines'), { recursive: true })
    mkdirSync(sd, { recursive: true })
    writeFileSync(join(vault, '.duin', 'routines', 'gaps.py'), '#')
    writeFileSync(join(sd, 'autonomous-log.jsonl'), JSON.stringify({ ts: '2026-06-01', routine: 'gaps', message: 'ran' }) + '\n')
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('surfaces grouped findings from a routine <name>.json (drops NOISE keys + empties)', () => {
    writeFileSync(
      join(sd, 'gaps.json'),
      JSON.stringify({ generated: '2026-06-02', orphans: [{ title: 'a' }, { title: 'b' }], params: ['x'], empty: [] })
    )
    const { detectors } = listDetectors(vault)
    expect(detectors).toHaveLength(1)
    expect(detectors[0].name).toBe('gaps')
    expect(detectors[0].groups.map((g) => g.key)).toEqual(['orphans']) // params(NOISE)+empty dropped
    expect(detectors[0].groups[0].items).toEqual(['a', 'b'])
    expect(detectors[0].total).toBe(2)
    expect(detectors[0].stateFile).toBe('.duin/_state/gaps.json')
  })

  it('null vault → empty', () => {
    expect(listDetectors(null)).toEqual({ detectors: [] })
  })
})
