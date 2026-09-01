import { describe, it, expect } from 'vitest'
import { ago, byLiveliness, grantSummary, planeCopy, quotaPatchFromForm, usageLine, GRANTABLE, DEFAULT_GRANT } from './AgentsSettings'

// The Agents pane — the operator's side of the Brain API membrane. Renderer render tests need
// jsdom, which this repo's node-only vitest env does not provide, so the pane's decisions live
// in pure exported helpers and are unit-tested here (same convention as ChannelsSettings.test).
//
// Why this pane exists at all: executive:pairings:approve and its five siblings were registered
// in main and bound in preload, with ZERO renderer callers. The pairing notice told the operator
// to approve in "Connected Agents", a screen that had never been built, so the only way to admit
// an agent was to call approvePairing() by hand.
//
// The load-bearing assertion here is BLANK-vs-ZERO on the budget fields. They are opposite
// intentions — "use the default" and "let it do nothing" — and the natural Number('') === 0
// collapses them, silently banning an agent the moment someone clears a field.

/** Unwrap a result the test expects to be valid, so the assertions below read as intent. */
function ok(r: ReturnType<typeof quotaPatchFromForm>): { callsPerHour: number; charsPerHour: number } | null {
  if (!r.ok) throw new Error(`expected a valid quota, got: ${r.reason}`)
  return r.quota
}

describe('quotaPatchFromForm — blank restores the default, zero is a real bound', () => {
  it('returns null when both fields are blank, which the store reads as "reset to default"', () => {
    expect(ok(quotaPatchFromForm('', ''))).toBeNull()
    expect(ok(quotaPatchFromForm('   ', '  '))).toBeNull()
  })

  it('returns an explicit zero when the operator types 0 — a deliberate freeze, not a reset', () => {
    // This is the case that makes the null/zero split worth having. If clearing and zeroing
    // produced the same patch, one of the two intentions would be unreachable from the UI.
    expect(ok(quotaPatchFromForm('0', '0'))).toEqual({ callsPerHour: 0, charsPerHour: 0 })
    expect(ok(quotaPatchFromForm('0', '0'))).not.toBeNull()
  })

  it('passes ordinary budgets through as numbers', () => {
    expect(ok(quotaPatchFromForm('240', '400000'))).toEqual({ callsPerHour: 240, charsPerHour: 400_000 })
    expect(ok(quotaPatchFromForm(' 60 ', ' 1000 '))).toEqual({ callsPerHour: 60, charsPerHour: 1000 })
  })

  it('treats one-field-filled as setting a budget, not as a partial reset', () => {
    // A budget with an unbounded half is not a budget, so the blank half floors at 0 rather
    // than silently restoring the generous default for that dimension.
    expect(ok(quotaPatchFromForm('60', ''))).toEqual({ callsPerHour: 60, charsPerHour: 0 })
    expect(ok(quotaPatchFromForm('', '5000'))).toEqual({ callsPerHour: 0, charsPerHour: 5000 })
  })

  it('refuses a typo at the FORM rather than letting NaN reach the store', () => {
    // inputMode="numeric" is a keyboard hint, not a constraint — "abc" is typeable on a
    // desktop. Number('abc') is NaN, and NaN passes the IPC layer's `typeof === 'number'`
    // check to be refused deep in updatePrincipalGrant as "out of range", which is an
    // unhelpful thing to say about a typo. Catch it where the offending field is visible.
    const bad = quotaPatchFromForm('abc', '100')
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.reason).toContain('Calls / hour')

    const bad2 = quotaPatchFromForm('100', 'lots')
    expect(bad2.ok).toBe(false)
    if (!bad2.ok) expect(bad2.reason).toContain('Characters / hour')
  })

  it('refuses a negative budget, which would read as a bound and act as none', () => {
    const neg = quotaPatchFromForm('-1', '100')
    expect(neg.ok).toBe(false)
    if (!neg.ok) expect(neg.reason).toContain('negative')
  })
})

describe('byLiveliness — the roster does not decay into dead rows', () => {
  it('puts active first, paused next, and permanently revoked last', () => {
    // Revocation is permanent by policy, so revoked entries only ever accumulate. Left in
    // insertion order they eventually outnumber the live ones and the operator reads past
    // the section that actually matters.
    const rows = [
      { status: 'revoked' as const, id: 'c' },
      { status: 'paused' as const, id: 'b' },
      { status: 'active' as const, id: 'a' }
    ]
    expect(rows.slice().sort(byLiveliness).map((r) => r.id)).toEqual(['a', 'b', 'c'])
  })

  it('is stable enough to leave same-status rows in their existing order', () => {
    const rows = [
      { status: 'active' as const, id: 'first' },
      { status: 'active' as const, id: 'second' }
    ]
    expect(rows.slice().sort(byLiveliness).map((r) => r.id)).toEqual(['first', 'second'])
  })
})

describe('grantSummary — an absent bound is a DEFAULT, never an absence', () => {
  it('describes an unscoped principal as reading the whole vault', () => {
    expect(grantSummary({}).reads).toBe('your whole vault')
    expect(grantSummary({ scope: [] }).reads).toBe('your whole vault')
  })

  it('lists the granted subtrees when scoped', () => {
    expect(grantSummary({ scope: ['03 Projects/DUIN', '01 Wiki'] }).reads).toBe(
      '03 Projects/DUIN, 01 Wiki'
    )
  })

  it('says "the default hourly budget" rather than going blank when no quota is set', () => {
    // The server bounds every principal whether or not a row carries an override. A blank here
    // would read as "unlimited" and be exactly wrong.
    expect(grantSummary({}).budget).toBe('the default hourly budget')
    expect(grantSummary({}).budget).not.toBe('')
  })

  it('shows a real override, including a zero one', () => {
    expect(grantSummary({ quota: { callsPerHour: 60, charsPerHour: 1000 } }).budget).toContain('60 calls')
    // A frozen principal must not render like an unset one.
    expect(grantSummary({ quota: { callsPerHour: 0, charsPerHour: 0 } }).budget).toContain('0 calls')
    expect(grantSummary({ quota: { callsPerHour: 0, charsPerHour: 0 } }).budget).not.toBe(
      'the default hourly budget'
    )
  })
})

describe('planeCopy — every grant is describable, including one this build does not know', () => {
  it('explains what each shipped plane actually hands over', () => {
    expect(planeCopy('beliefs.read').label).toBe('Read beliefs')
    expect(planeCopy('beliefs.read').detail).toContain('operator model')
  })

  it('marks the write planes, so a write grant is visible before it is approved', () => {
    for (const p of ['goals.write', 'learning.submit', 'memory.write']) {
      expect(planeCopy(p).write, `${p} should be flagged as a write`).toBe(true)
    }
    for (const p of ['context.read', 'beliefs.read', 'goals.read', 'judgment.precheck']) {
      expect(planeCopy(p).write, `${p} is a read`).toBeUndefined()
    }
  })

  it('falls back to the raw plane name rather than rendering nothing', () => {
    // A plane added to the store but not yet to this table must still appear on the card:
    // authority the UI cannot describe is worse when the UI hides it.
    expect(planeCopy('future.plane').label).toBe('future.plane')
  })
})

describe('ago', () => {
  const now = Date.parse('2026-08-17T12:00:00.000Z')

  it('says "never" for a principal that has not called yet', () => {
    expect(ago(null, now)).toBe('never')
  })

  it('reports minutes, hours and days', () => {
    expect(ago('2026-08-17T11:59:30.000Z', now)).toBe('just now')
    expect(ago('2026-08-17T11:30:00.000Z', now)).toBe('30m ago')
    expect(ago('2026-08-17T09:00:00.000Z', now)).toBe('3h ago')
    expect(ago('2026-08-15T12:00:00.000Z', now)).toBe('2d ago')
  })

  it('does not pretend to know when the timestamp is unparseable', () => {
    expect(ago('not a date', now)).toBe('unknown')
  })
})

describe('usageLine — spend against the ceiling, without inventing a measurement', () => {
  it('is empty for a grant that has never been used', () => {
    // "0 calls used this hour" on a fresh principal implies a reading was taken. It was not.
    expect(usageLine({})).toBe('')
    expect(usageLine({ usage: { windowStartedAt: 'x', calls: 0, chars: 0 } })).toBe('')
  })

  it('shows spend against the ceiling when one is set', () => {
    expect(
      usageLine({
        usage: { windowStartedAt: 'x', calls: 12, chars: 900 },
        quota: { callsPerHour: 240, charsPerHour: 400_000 }
      })
    ).toBe('12/240 calls used this hour')
  })

  it('shows bare spend when the principal is on the default budget', () => {
    // The default ceiling lives on the server, so quoting a number here would be this pane
    // asserting a value it does not hold.
    expect(usageLine({ usage: { windowStartedAt: 'x', calls: 12, chars: 900 } })).toBe(
      '12 calls used this hour'
    )
  })
})

describe('GRANTABLE / DEFAULT_GRANT — derived, not a third copy of the vocabulary', () => {
  it('offers every plane the copy table describes', () => {
    for (const p of ['context.read', 'beliefs.read', 'goals.read', 'goals.write', 'judgment.precheck', 'learning.submit', 'memory.write']) {
      expect(GRANTABLE, `${p} must be offerable`).toContain(p)
    }
  })

  it('ticks the reads by default and leaves every write unticked', () => {
    // Same rule the store's DEFAULT_PLANES encodes, derived from the write flag rather than
    // re-typed. A new plane added to the copy table joins the form automatically, and joins it
    // unticked if it writes — so the failure mode is under-granting, never over-granting.
    expect(DEFAULT_GRANT).toEqual(['context.read', 'beliefs.read', 'goals.read', 'judgment.precheck'])
    for (const p of DEFAULT_GRANT) {
      expect(planeCopy(p).write, `${p} is a read`).toBeUndefined()
    }
  })

  it('never defaults a write plane on, whatever the table grows to', () => {
    expect(DEFAULT_GRANT.filter((p) => planeCopy(p).write)).toEqual([])
    expect(DEFAULT_GRANT.length).toBeLessThan(GRANTABLE.length)
  })
})
