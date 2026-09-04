// roles.ts — the P0 model-plane contract's two runtime pieces: the bench marker and the fix hints.

import { describe, it, expect } from 'vitest'
import { isBenchRequest, providerFixHint, BENCH_HEADER, MODEL_IPC, AUTO_ENGINE } from './roles'
import type { ProviderHealthReason } from './roles'

describe('isBenchRequest — evaluation traffic is exempt from learning ONLY behind the exec gate (D3)', () => {
  it('true only for header "1" with an authorized caller', () => {
    expect(isBenchRequest({ [BENCH_HEADER]: '1' }, true)).toBe(true)
    expect(isBenchRequest({ [BENCH_HEADER]: ['1'] }, true)).toBe(true)
  })

  it('an unauthenticated caller cannot mark its turn bench — the header is ignored', () => {
    expect(isBenchRequest({ [BENCH_HEADER]: '1' }, false)).toBe(false)
  })

  it('anything but "1" is an ordinary turn', () => {
    for (const v of ['0', 'true', '', undefined, 1, ['0']]) {
      expect(isBenchRequest({ [BENCH_HEADER]: v }, true), `value ${JSON.stringify(v)}`).toBe(false)
    }
    expect(isBenchRequest({}, true)).toBe(false)
  })
})

describe('providerFixHint — one hint per reason, naming the provider', () => {
  it('every reason but ok has a hint that names the provider and says what to do', () => {
    const reasons: ProviderHealthReason[] = ['no-key', 'no-credit', 'unauthorized', 'model-access', 'rate-limit', 'not-found', 'network', 'unknown']
    for (const r of reasons) {
      const h = providerFixHint(r, 'DeepSeek')
      expect(h, r).toContain('DeepSeek')
      expect(h.length, r).toBeGreaterThan(20)
    }
    expect(providerFixHint('ok', 'DeepSeek')).toBe('')
  })
})

describe('channel names and the auto sentinel are stable (lanes B/C build against them)', () => {
  it('MODEL_IPC is the model:* namespace', () => {
    for (const v of Object.values(MODEL_IPC)) expect(v.startsWith('model:')).toBe(true)
    expect(MODEL_IPC.healthChanged).toBe('model:health-changed')
  })

  it('AUTO_ENGINE keeps the duin-brain connector id so old conversation rows keep their meaning', () => {
    expect(AUTO_ENGINE).toBe('duin-brain')
  })
})
