import { describe, it, expect, afterEach } from 'vitest'
import { claimMetabolismTick, startClaimMetabolismTick, stopClaimMetabolismTick } from './claim-metabolism-tick'
import { claimMetabolismLive, runLiveMetabolism, runShadowMetabolism } from './claim-extract'

const ENV = 'DUIN_CLAIM_METABOLISM_LIVE'
afterEach(() => {
  delete process.env[ENV]
  stopClaimMetabolismTick()
})

describe('claim-metabolism live gating', () => {
  it('claimMetabolismLive() reflects the flag (default ON; only "0" disables)', () => {
    delete process.env[ENV]
    expect(claimMetabolismLive()).toBe(true) // default ON (validated live)
    process.env[ENV] = '1'
    expect(claimMetabolismLive()).toBe(true)
    process.env[ENV] = '0'
    expect(claimMetabolismLive()).toBe(false)
  })
  it('null vault is a safe no-op for both shadow and live runs', async () => {
    const empty = { total: 0, active: 0, byVerdict: {}, worldState: { resolvedDecisions: 0, passedStreams: 0 }, corrections: [] }
    expect(await runShadowMetabolism(null)).toEqual(empty)
    process.env[ENV] = '1'
    expect(await runLiveMetabolism(null)).toEqual(empty)
  })
})

describe('claim-metabolism-tick — best-effort, never throws', () => {
  it('a null vault dir is a no-op', () => {
    expect(() => claimMetabolismTick(() => null)).not.toThrow()
  })
  it('a throwing vault-dir getter does not crash the tick', () => {
    expect(() => claimMetabolismTick(() => { throw new Error('settings read blew up') })).not.toThrow()
  })
  it('start/stop are no-ops when LIVE is disabled (=0) — zero background work', () => {
    process.env[ENV] = '0'
    expect(() => startClaimMetabolismTick(() => null)).not.toThrow()
    expect(() => stopClaimMetabolismTick()).not.toThrow()
  })
})
