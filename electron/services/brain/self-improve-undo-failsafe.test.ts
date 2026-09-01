// self-improve-undo-failsafe.test.ts — the undo record is an AFFORDANCE, never a precondition.
//
// applyChange now records a revertable action before it writes (see self-improve-undo-wiring.test.ts).
// recordAction can legitimately fail: captureSnapshot throws until setSnapshotDir has run (which only
// happens on main-process boot), and classifyAction throws on anything it doesn't rate Tier-B/grad.
// If either failure propagated, a ledger problem would cost the RSI loop its write — trading a real
// capability for a safety net. This suite pins the opposite: the write still lands.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../ans/action-ledger', () => ({
  recordAction: () => {
    throw new Error('snapshot dir not set')
  }
}))

import { applyChange } from './self-improve-loop'
import { rsiTunablesPath } from './rsi-tunables'
import type { InflightChange } from './self-improve-registry'

const NOW = '2026-07-25T00:00:00.000Z'
let vault = ''

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'duin-rsi-undo-fail-'))
  mkdirSync(join(vault, '.duin', '_state'), { recursive: true })
})
afterEach(() => rmSync(vault, { recursive: true, force: true }))

describe('RSI apply is resilient to an unavailable undo ledger', () => {
  it('applies the change even when recordAction throws', () => {
    const rec: InflightChange = {
      id: 'chg-1',
      changeClass: 'kind-weight',
      engine: 'risk',
      targetPath: rsiTunablesPath(vault),
      beforeBytes: '',
      afterBytes: '{\n  "namedSkillTopK": 5\n}\n',
      proposedAt: NOW,
      status: 'proposed'
    }

    const applied = applyChange(vault, rec, NOW)

    expect(applied.status).toBe('applied')
    expect(readFileSync(rec.targetPath, 'utf-8')).toContain('"namedSkillTopK": 5')
  })
})
