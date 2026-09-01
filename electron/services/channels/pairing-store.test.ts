import { describe, it, expect, beforeEach } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync } from 'fs'
import {
  setPairingPath,
  requestPairing,
  approvePairing,
  approveByCode,
  revokePairing,
  authorizeStatus,
  getPairing,
  listPairings
} from './pairing-store'

// Each test gets a fresh tmp dir so the module's persisted state can't bleed.
beforeEach(() => {
  setPairingPath(mkdtempSync(join(tmpdir(), 'pairing-')))
})

describe('pairing-store — deny-first lifecycle', () => {
  it('an unknown external user is pending (never auto-approved)', () => {
    expect(getPairing('telegram', 'u1')).toBeNull()
    expect(authorizeStatus('telegram', 'u1')).toBe('pending')
  })

  it('pending → approved → revoked', () => {
    const rec = requestPairing('telegram', 'u1')
    expect(rec.status).toBe('pending')
    expect(rec.code).toBeTruthy()
    expect(authorizeStatus('telegram', 'u1')).toBe('pending')

    expect(approvePairing('telegram', 'u1')).toBe(true)
    expect(authorizeStatus('telegram', 'u1')).toBe('approved')
    expect(getPairing('telegram', 'u1')?.code).toBeNull() // code consumed on approval

    expect(revokePairing('telegram', 'u1')).toBe(true)
    expect(authorizeStatus('telegram', 'u1')).toBe('denied')
  })

  it('re-requesting an already-approved user does NOT mint a new code', () => {
    approvePairing('telegram', 'u1')
    const rec = requestPairing('telegram', 'u1')
    expect(rec.status).toBe('approved')
    expect(rec.code).toBeNull()
  })
})

describe('pairing-store — one-time pairing code', () => {
  it('approveByCode consumes the code (single-use)', () => {
    const rec = requestPairing('telegram', 'u1')
    const code = rec.code as string

    expect(approveByCode('telegram', code)).toBe('u1')
    expect(authorizeStatus('telegram', 'u1')).toBe('approved')

    // Replay the same code → nothing pending matches → rejected.
    expect(approveByCode('telegram', code)).toBeNull()
  })

  it('a wrong / empty code approves nobody', () => {
    requestPairing('telegram', 'u1')
    expect(approveByCode('telegram', 'not-the-code')).toBeNull()
    expect(approveByCode('telegram', '')).toBeNull()
    expect(authorizeStatus('telegram', 'u1')).toBe('pending')
  })

  it('a code is scoped to its channel + does not approve a different user', () => {
    const a = requestPairing('telegram', 'u1')
    requestPairing('telegram', 'u2')
    // u1's code must not approve u2, and must not work on another channel.
    expect(approveByCode('slack', a.code as string)).toBeNull()
    expect(approveByCode('telegram', a.code as string)).toBe('u1')
    expect(authorizeStatus('telegram', 'u2')).toBe('pending')
  })
})

describe('pairing-store — persistence + listing', () => {
  it('reloads persisted state from disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pairing-'))
    setPairingPath(dir)
    approvePairing('telegram', 'u1')
    requestPairing('telegram', 'u2')

    // Fresh load from the same file.
    setPairingPath(dir)
    expect(authorizeStatus('telegram', 'u1')).toBe('approved')
    expect(authorizeStatus('telegram', 'u2')).toBe('pending')
  })

  it('listPairings omits the live code and can filter by channel', () => {
    requestPairing('telegram', 'u1')
    requestPairing('slack', 'u9')
    const all = listPairings()
    expect(all.length).toBe(2)
    expect(all.every((r) => !('code' in r))).toBe(true)
    expect(listPairings('telegram').map((r) => r.externalUserId)).toEqual(['u1'])
  })
})
