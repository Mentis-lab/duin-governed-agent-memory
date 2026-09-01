import { describe, it, expect, beforeEach } from 'vitest'
import {
  classifyActionTier,
  tierForVerb,
  tierNeedsGate,
  tierRequiresApproval,
  isTierAtLeast,
  TIER_RANK,
  registerExternalActionTier,
  externalActionTier,
  isRegisteredExternalActionGated,
  __clearExternalActionRegistry
} from './action-tier'

describe('tier predicates', () => {
  it('only non-read tiers are gated', () => {
    expect(tierNeedsGate('read')).toBe(false)
    expect(tierNeedsGate('write-reversible')).toBe(true)
    expect(tierNeedsGate('irreversible')).toBe(true)
  })
  it('only irreversible always requires approval', () => {
    expect(tierRequiresApproval('read')).toBe(false)
    expect(tierRequiresApproval('write-reversible')).toBe(false)
    expect(tierRequiresApproval('irreversible')).toBe(true)
  })
  it('ranks tiers monotonically', () => {
    expect(TIER_RANK.read).toBeLessThan(TIER_RANK['write-reversible'])
    expect(TIER_RANK['write-reversible']).toBeLessThan(TIER_RANK.irreversible)
    expect(isTierAtLeast('irreversible', 'write-reversible')).toBe(true)
    expect(isTierAtLeast('read', 'write-reversible')).toBe(false)
    expect(isTierAtLeast('write-reversible', 'write-reversible')).toBe(true)
  })
})

describe('tierForVerb — keyword inference', () => {
  it('classes irreversible verbs', () => {
    for (const v of ['send', 'delete', 'overwrite', 'transfer', 'pay', 'publish', 'cancel', 'revoke']) {
      expect(tierForVerb(v)).toBe('irreversible')
    }
  })
  it('classes write-reversible verbs', () => {
    for (const v of ['create', 'draft', 'add', 'update', 'upload', 'schedule', 'save']) {
      expect(tierForVerb(v)).toBe('write-reversible')
    }
  })
  it('classes read verbs', () => {
    for (const v of ['get', 'list', 'search', 'read', 'fetch', 'view']) {
      expect(tierForVerb(v)).toBe('read')
    }
  })
  it('is case-insensitive and takes the leading verb token', () => {
    expect(tierForVerb('SEND')).toBe('irreversible')
    expect(tierForVerb('create_event')).toBe('write-reversible')
    expect(tierForVerb('delete-file')).toBe('irreversible')
  })
  it('returns null for an unrecognized verb', () => {
    expect(tierForVerb('frobnicate')).toBeNull()
    expect(tierForVerb('')).toBeNull()
    expect(tierForVerb(undefined)).toBeNull()
    expect(tierForVerb(42 as unknown)).toBeNull()
  })
})

describe('classifyActionTier — explicit wins, else infer, else fail-safe', () => {
  it('honors an explicit tier over the verb', () => {
    expect(classifyActionTier({ tier: 'read', verb: 'delete' })).toBe('read')
    expect(classifyActionTier({ tier: 'irreversible' })).toBe('irreversible')
  })
  it('infers from the verb when no explicit tier', () => {
    expect(classifyActionTier({ verb: 'create_draft' })).toBe('write-reversible')
    expect(classifyActionTier({ verb: 'send_email' })).toBe('irreversible')
    expect(classifyActionTier({ verb: 'list_events' })).toBe('read')
  })
  it('DEFAULTS to irreversible (most restrictive) for an unclassifiable action', () => {
    expect(classifyActionTier({})).toBe('irreversible')
    expect(classifyActionTier({ verb: 'frobnicate' })).toBe('irreversible')
  })
})

describe('external-action tier registry', () => {
  beforeEach(() => __clearExternalActionRegistry())

  it('records and reads back a tier', () => {
    registerExternalActionTier('calendar_create_event', 'write-reversible')
    registerExternalActionTier('calendar_delete_event', 'irreversible')
    expect(externalActionTier('calendar_create_event')).toBe('write-reversible')
    expect(externalActionTier('calendar_delete_event')).toBe('irreversible')
    expect(externalActionTier('unknown_tool')).toBeNull()
  })
  it('isRegisteredExternalActionGated is true only for non-read registered actions', () => {
    registerExternalActionTier('drive_read', 'read')
    registerExternalActionTier('drive_upload', 'write-reversible')
    registerExternalActionTier('drive_delete', 'irreversible')
    expect(isRegisteredExternalActionGated('drive_read')).toBe(false)
    expect(isRegisteredExternalActionGated('drive_upload')).toBe(true)
    expect(isRegisteredExternalActionGated('drive_delete')).toBe(true)
    expect(isRegisteredExternalActionGated('not_registered')).toBe(false)
  })
})
