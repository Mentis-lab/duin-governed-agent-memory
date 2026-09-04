import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { applyNodeLabels, nodeLabelsPath, parseNodeLabels, readNodeLabels, recordNodeLabel } from './node-labels'

let vault = ''
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'duin-node-labels-'))
})
afterEach(() => {
  try {
    rmSync(vault, { recursive: true, force: true })
  } catch {
    /* tmp cleanup */
  }
})

describe('node labels — the operator names a derived entity', () => {
  it('parses last-write-wins, an empty label clears, malformed lines are skipped', () => {
    const body = [
      JSON.stringify({ id: 'person:a', label: 'Alice', at: '1' }),
      'not json',
      JSON.stringify({ id: 'person:a', label: 'Alice Chen', at: '2' }),
      JSON.stringify({ id: 'org:b', label: 'Beta', at: '3' }),
      JSON.stringify({ id: 'org:b', label: '', at: '4' }),
      JSON.stringify({ label: 'no id' })
    ].join('\n')
    const m = parseNodeLabels(body)
    expect([...m.entries()]).toEqual([['person:a', 'Alice Chen']])
  })

  it('records to the vault ledger and reads it back; a rewrite invalidates the memo', () => {
    expect(readNodeLabels(vault).size).toBe(0)
    expect(recordNodeLabel(vault, 'topic:x', 'Launch plan')).toBe(true)
    expect(readNodeLabels(vault).get('topic:x')).toBe('Launch plan')
    expect(recordNodeLabel(vault, 'topic:x', 'Launch plan v2')).toBe(true)
    expect(readNodeLabels(vault).get('topic:x')).toBe('Launch plan v2')
    expect(recordNodeLabel(vault, 'topic:x', '')).toBe(true)
    expect(readNodeLabels(vault).has('topic:x')).toBe(false)
    const raw = readFileSync(nodeLabelsPath(vault) as string, 'utf8').trim().split('\n')
    expect(raw).toHaveLength(3)
    expect(JSON.parse(raw[0])).toMatchObject({ id: 'topic:x', label: 'Launch plan', actor: 'operator' })
    expect(recordNodeLabel(null, 'topic:x', 'y')).toBe(false)
    expect(recordNodeLabel(vault, '  ', 'y')).toBe(false)
  })

  it('applies to the served graph in place and marks provenance', () => {
    const nodes = [
      { id: 'topic:x', label: 'launch' },
      { id: 'person:a', label: 'A. Chen' },
      { id: 'Notes/a.md', label: 'a' }
    ]
    const n = applyNodeLabels(nodes, new Map([['topic:x', 'Launch plan'], ['person:a', 'A. Chen']]))
    expect(n).toBe(1)
    expect(nodes[0]).toEqual({ id: 'topic:x', label: 'Launch plan', labelBy: 'operator' })
    expect(nodes[1]).toEqual({ id: 'person:a', label: 'A. Chen' })
    expect(applyNodeLabels(nodes, new Map())).toBe(0)
  })
})
