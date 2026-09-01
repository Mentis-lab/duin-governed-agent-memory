import { describe, it, expect } from 'vitest'
import { MIGRATIONS, assertMigrationRegistryValid, type Migration } from './db-migrations'

// The fix for the void reserved-gap reservation (db-migrations.ts).
//
// `runMigrations` skips every migration whose `version <= user_version`, and every
// install that has launched the shipped build is stamped at LATEST_VERSION. So a
// migration assigned a number below that stamp is a PERMANENT SILENT NO-OP on every
// existing vault while looking fine on a fresh developer DB. The registry used to
// advertise 28-31 / 37-42 as "reserved for concurrent workstreams", which is exactly
// how you get one.
//
// The reservation is withdrawn and replaced by a mechanical gate that runs at module
// load. These tests prove the gate accepts the real registry and rejects the concrete
// casualty (duin/localization-phase0's deferred FTS5 rebuild numbered v28/v29).

function mig(version: number, description = 'test'): Migration {
  return { version, description, up: () => undefined }
}

describe('db-migrations — registry integrity gate', () => {
  it('accepts the shipped registry (the module would not have imported otherwise)', () => {
    expect(() => assertMigrationRegistryValid(MIGRATIONS)).not.toThrow()
  })

  it('rejects a NEW migration numbered into a dead gap below the released floor', () => {
    // localization-phase0's external-content FTS rebuild, numbered v29.
    expect(() =>
      assertMigrationRegistryValid([...MIGRATIONS, mig(29, 'deferred CJK bigram FTS rebuild')])
    ).toThrow(/never run on a real vault|strictly greater/)
  })

  it('names the next legal version in the failure message', () => {
    let message = ''
    try {
      assertMigrationRegistryValid([mig(1), mig(2), mig(29)])
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('v44')
  })

  it('rejects a duplicate version', () => {
    expect(() => assertMigrationRegistryValid([mig(1), mig(2), mig(2)])).toThrow(
      /strictly greater/
    )
  })

  it('rejects an out-of-order (inserted, not appended) registry', () => {
    expect(() => assertMigrationRegistryValid([mig(1), mig(43), mig(32)])).toThrow(
      /strictly greater/
    )
  })

  it('accepts a genuinely new migration above the released floor', () => {
    expect(() => assertMigrationRegistryValid([...MIGRATIONS, mig(999)])).not.toThrow()
  })
})
