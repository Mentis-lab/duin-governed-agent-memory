import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseOutput, listOutputs } from './outputs-native'

// Deep correctness proven by live parity (parity.ts /state/outputs → EXACT).
describe('outputs-native', () => {
  it('parseOutput: frontmatter row, unquotes title/type, id/title fallbacks', () => {
    expect(parseOutput('---\nid: o1\ntitle: "Q2 Brief"\ntype: "digest"\ncreated: 2026-06-01\ndecision: d1\n---\nbody', 'o1.md')).toEqual({
      id: 'o1',
      title: 'Q2 Brief',
      type: 'digest',
      created: '2026-06-01',
      decision: 'd1'
    })
    expect(parseOutput('no frontmatter', 'fallback.md')).toMatchObject({ id: 'fallback', title: 'fallback.md', type: 'note' })
  })

  let vault: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-out-'))
    mkdirSync(join(vault, '_agui_outputs'), { recursive: true })
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('lists _agui_outputs newest-first (reverse name sort); filters by decisionId', () => {
    writeFileSync(join(vault, '_agui_outputs', 'a.md'), '---\ndecision: d1\n---\n')
    writeFileSync(join(vault, '_agui_outputs', 'b.md'), '---\ndecision: d2\n---\n')
    expect(listOutputs(vault).outputs.map((o) => o.id)).toEqual(['b', 'a']) // reverse sort
    expect(listOutputs(vault, 'd1').outputs.map((o) => o.id)).toEqual(['a']) // filtered
  })

  it('null vault / missing dir → empty', () => {
    expect(listOutputs(null)).toEqual({ outputs: [] })
  })
})
