import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  inspect,
  firewallClear,
  firewallClearAll,
  DEFAULT_DENYLIST,
  setActiveDenylist
} from './confidential-firewall'

// Cold-start A3 changed the CONTRACT, not the matching logic: the shipped default is now empty and
// the real terms come from vault state. So the behaviour tests drive an EXPLICIT fixture list (what
// a populated vault supplies), and a separate block pins the empty-default contract.
//
// The fixture is deliberately invented rather than the author's real terms — a test that hardcodes
// the secrets would re-create the leak this workstream just closed, one directory over.
const FIXTURE = ['falcon', 'lane-b', '蓝图', 'nightjar']

beforeEach(() => setActiveDenylist(FIXTURE))
afterEach(() => setActiveDenylist(null))

describe('the shipped default', () => {
  it('is EMPTY — no operator terms compiled into the binary', () => {
    expect(DEFAULT_DENYLIST).toEqual([])
  })

  it('blocks nothing when no vault list is loaded, and that is by design', () => {
    setActiveDenylist([])
    // Fails OPEN on an empty list: there is nothing to protect until an operator declares terms.
    expect(inspect('falcon trailer notes').blocked).toBe(false)
  })
})

describe('inspect', () => {
  it('blocks confidential-lane content (Latin + CJK)', () => {
    expect(inspect('the falcon partnership plan').blocked).toBe(true)
    expect(inspect('关于蓝图的方案').blocked).toBe(true)
    expect(inspect('nightjar trailer notes').hits).toContain('nightjar')
  })

  it('does NOT false-fire on Latin substrings (boundary-aware)', () => {
    expect(inspect('the 23rd of June').blocked).toBe(false)
    expect(inspect('a standard public roadmap').blocked).toBe(false)
    expect(inspect('falconry as a hobby').blocked).toBe(false) // "falcon" inside a longer token
  })

  it('reports which terms tripped it', () => {
    const r = inspect('send the falcon and 蓝图 files')
    expect(r.blocked).toBe(true)
    expect(r.hits).toEqual(expect.arrayContaining(['falcon', '蓝图']))
  })

  it('is clear for empty / public text', () => {
    expect(inspect('').blocked).toBe(false)
    expect(inspect('a normal question about typescript').blocked).toBe(false)
  })

  it('honors a custom denylist argument over the active one', () => {
    expect(inspect('project kestrel status', ['kestrel']).blocked).toBe(true)
    expect(inspect('project kestrel status').blocked).toBe(false) // not in the active list
  })
})

describe('firewallClear', () => {
  it('is the inverse of blocked — true means safe to send externally', () => {
    expect(firewallClear('public roadmap summary')).toBe(true)
    expect(firewallClear('the nightjar numbers')).toBe(false)
  })
})

describe('firewallClearAll', () => {
  it('blocks a batch if ANY fragment is confidential', () => {
    const r = firewallClearAll(['clean one', 'the falcon bit', 'clean two'])
    expect(r.blocked).toBe(true)
    expect(r.hits).toContain('falcon')
  })
  it('passes a fully-clean batch', () => {
    expect(firewallClearAll(['hello', 'world', 'typescript']).blocked).toBe(false)
  })
})
