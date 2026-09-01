import { describe, it, expect } from 'vitest'
import { reconcileExternalTier } from './action-tier'

describe('reconcileExternalTier — declared-vs-actual integrity (SIA activation)', () => {
  it('escalates a read-declared action whose name infers irreversible (the under-gate)', () => {
    expect(reconcileExternalTier('send_email', 'read')).toEqual({ tier: 'irreversible', escalatedFrom: 'read' })
    expect(reconcileExternalTier('delete_record', 'read')).toEqual({ tier: 'irreversible', escalatedFrom: 'read' })
  })
  it('escalates a read-declared action whose name infers write-reversible', () => {
    expect(reconcileExternalTier('write_note', 'read')).toEqual({ tier: 'write-reversible', escalatedFrom: 'read' })
  })
  it('respects a genuine read whose name also infers read', () => {
    expect(reconcileExternalTier('read_file', 'read')).toEqual({ tier: 'read', escalatedFrom: null })
    expect(reconcileExternalTier('list_dir', 'read')).toEqual({ tier: 'read', escalatedFrom: null })
  })
  it('respects an unrecognized name (no name-opinion → keep declared)', () => {
    expect(reconcileExternalTier('frobnicate_widget', 'read')).toEqual({ tier: 'read', escalatedFrom: null })
  })
  it('does NOT over-gate an already-gated declaration (a reversible delete stays write-reversible)', () => {
    expect(reconcileExternalTier('delete_temp', 'write-reversible')).toEqual({ tier: 'write-reversible', escalatedFrom: null })
    expect(reconcileExternalTier('send_thing', 'write-reversible')).toEqual({ tier: 'write-reversible', escalatedFrom: null })
  })
})
