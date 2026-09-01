import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  learningLoadFailed,
  learningLoadSucceeded,
  requireLearningSuccess,
  requireMutationSuccess
} from './learning-state'

const panelSource = readFileSync(fileURLToPath(new URL('./LearningPanel.tsx', import.meta.url)), 'utf8')

describe('Learning panel failure states', () => {
  it('distinguishes an initial read failure from a genuine empty result', () => {
    expect(learningLoadFailed({ status: 'loading' }, 'offline')).toEqual({
      status: 'unavailable',
      error: 'offline'
    })
    expect(learningLoadSucceeded([])).toEqual({ status: 'ready', facts: [] })
  })

  it('retains prior facts when a refresh fails', () => {
    const facts = [{ id: 'fact-1' }]
    expect(learningLoadFailed(learningLoadSucceeded(facts), 'timeout')).toEqual({
      status: 'stale',
      facts,
      error: 'timeout'
    })
  })

  it('rejects false IPC envelopes for reads and vetoes', () => {
    expect(() => requireLearningSuccess({ success: false, error: 'read failed' }, 'fallback')).toThrow('read failed')
    expect(() => requireMutationSuccess({ success: false, error: 'veto failed' }, 'fallback')).toThrow('veto failed')
  })

  it('only renders the genuine-empty state after a successful load', () => {
    expect(panelSource).toMatch(/learningState\.status === 'ready' && learning\.length === 0/)
    expect(panelSource).toMatch(/learningState\.status === 'unavailable'/)
    expect(panelSource).toMatch(/learningState\.status === 'stale'/)
  })
})
