import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  resolveOwed,
  recordInsightVerdict,
  recordPredictionVerdict,
  asOwedNodeId,
  asInsightId,
  asPredictionId,
  BrainUnavailableError,
  brainWritesAvailable,
} from './brain-client'

// M6.0 contract: TS-brain-owned writes route to the in-process brain IPC and NEVER to
// fetch()/python. This is the regression gate for the "read-brain ≠ write-brain" bug class
// (owed Resolve 400, insight-verdict "not found", prediction verdict cross-brain) — each of
// those was a fetch→python write of an IPC-read id. If any owned writer calls fetch, this fails.
describe('brain-client — authoritative write seam (M6.0)', () => {
  const brain = {
    recordDecision: vi.fn(async () => ({ success: true })),
    insightVerdict: vi.fn(async () => ({ success: true })),
    recordVerdict: vi.fn(async () => ({ success: true })),
  }
  const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({}) }))

  beforeEach(() => {
    ;(globalThis as unknown as { window?: unknown }).window = { api: { brain } }
    ;(globalThis as unknown as { fetch?: unknown }).fetch = fetchSpy
    fetchSpy.mockClear()
    brain.recordDecision.mockClear()
    brain.insightVerdict.mockClear()
    brain.recordVerdict.mockClear()
  })
  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
    delete (globalThis as unknown as { fetch?: unknown }).fetch
  })

  it('routes owed resolution to the brain IPC, never to fetch/python', async () => {
    const r = await resolveOwed(asOwedNodeId('owed::demo'), 'cleared', 'note')
    expect(r).toEqual({ ok: true })
    expect(brain.recordDecision).toHaveBeenCalledWith('owed::demo', 'cleared', 'note')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('routes insight verdict to the brain IPC, never to fetch/python', async () => {
    await recordInsightVerdict(asInsightId('insight-1'), 'useful')
    expect(brain.insightVerdict).toHaveBeenCalledWith('insight-1', 'useful')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('routes prediction verdict to the brain IPC, never to fetch/python', async () => {
    await recordPredictionVerdict(asPredictionId('pred-1'), 'happened', 'note')
    expect(brain.recordVerdict).toHaveBeenCalledWith('pred-1', 'happened', 'note')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('surfaces a failed brain write instead of masking it', async () => {
    brain.recordDecision.mockResolvedValueOnce({ success: false, error: 'nope' } as { success: boolean; error?: string })
    const r = await resolveOwed(asOwedNodeId('owed::y'), 'blocked')
    expect(r).toEqual({ ok: false, error: 'nope' })
  })

  it('throws BrainUnavailableError when the IPC bridge is absent — no silent wrong-brain fallback', async () => {
    delete (globalThis as unknown as { window?: unknown }).window
    expect(brainWritesAvailable()).toBe(false)
    await expect(resolveOwed(asOwedNodeId('z'), 'done')).rejects.toBeInstanceOf(BrainUnavailableError)
  })
})
