import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  defaultRuleFor,
  canConfirmBinding,
  bindingCandidateLine,
  type BindingCandidate
} from './BrainStatusPanel'
import { bindCandidate } from '@/duin/lib/state'

// THE GAP these tests close: POST /state/bind-candidate had zero callers, and
// BrainStatusPanel's reflect() discarded `r.binding_candidates` from the result
// entirely — it read taste_counts and stream_size for a toast and dropped the
// candidate list on the floor. The falsification plumbing was complete end to end
// (learn-native.reflect clusters corrections into candidates, the human-confirm
// route mints a binding row, checkRecurrence falsifies it later) and there was no
// mouth: nothing in the app could confirm one.
//
// Renderer render tests need jsdom, which this repo's node-only vitest env does
// not provide, so the panel's behaviour is factored into pure exported helpers
// (the LoopSettings / FoundationsSettings convention). The transport is tested
// against a stubbed fetch, because the assertion that matters is the SHAPE of the
// body — the route 400s on a missing rule or an empty theme, and a confirm button
// that posts a body the route refuses is the same dead end one layer down.

const cand = (over: Partial<BindingCandidate> = {}): BindingCandidate => ({
  count: 3,
  theme: ['feishu', 'formatting'],
  sample: 'Use the md tag for bullets on Feishu, not the markdown param',
  ...over
})

describe('binding candidate — the rule draft the operator edits', () => {
  it('pre-fills from the sample correction, because that is what recurred', () => {
    expect(defaultRuleFor(cand())).toContain('Use the md tag for bullets')
  })

  it('falls back to the theme when a cluster carries no sample text', () => {
    const r = defaultRuleFor(cand({ sample: '' }))
    expect(r).toContain('feishu')
    expect(r).toContain('formatting')
  })

  // A candidate with neither sample nor theme cannot produce a rule the route
  // would accept, and the draft must not invent one that looks confirmable.
  it('produces nothing to confirm when the cluster is empty', () => {
    expect(defaultRuleFor(cand({ sample: '', theme: [] })).trim()).toBe('')
  })
})

describe('binding candidate — the confirm gate mirrors the route, not a guess', () => {
  // POST /state/bind-candidate 400s unless BOTH candidate.theme[] is non-empty AND
  // rule is a non-blank string. A button enabled outside that window produces a
  // 400 the operator reads as "the app is broken".
  it('allows a confirm only with a theme and a non-blank rule', () => {
    expect(canConfirmBinding(cand(), 'Always use the md tag')).toBe(true)
  })

  it('refuses a blank rule', () => {
    expect(canConfirmBinding(cand(), '   ')).toBe(false)
    expect(canConfirmBinding(cand(), '')).toBe(false)
  })

  it('refuses a candidate with no theme', () => {
    expect(canConfirmBinding(cand({ theme: [] }), 'Always use the md tag')).toBe(false)
  })
})

describe('binding candidate — the row says how strong the recurrence is', () => {
  it('names the recurrence count, since that is why it was surfaced at all', () => {
    expect(bindingCandidateLine(cand({ count: 3 }))).toContain('3')
  })

  it('singularises a lone occurrence rather than printing "1 corrections"', () => {
    expect(bindingCandidateLine(cand({ count: 1 }))).toContain('1 correction')
    expect(bindingCandidateLine(cand({ count: 1 }))).not.toContain('1 corrections')
  })
})

describe('bindCandidate transport — the body the route will actually accept', () => {
  const orig = globalThis.fetch
  let seen: { url: string; init: RequestInit | undefined } | null = null

  beforeEach(() => {
    seen = null
    globalThis.fetch = vi.fn(async (url: any, init?: any) => {
      seen = { url: String(url), init }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, binding: { id: 'b1', rule: 'r' } })
      } as any
    }) as any
  })
  afterEach(() => {
    globalThis.fetch = orig
  })

  it('POSTs candidate.theme[] and rule — the two fields the route 400s without', async () => {
    await bindCandidate(cand(), 'Always use the md tag')
    expect(seen).not.toBeNull()
    expect(seen!.url).toContain('/state/bind-candidate')
    expect(seen!.init?.method).toBe('POST')
    const body = JSON.parse(String(seen!.init?.body))
    expect(body.candidate.theme).toEqual(['feishu', 'formatting'])
    expect(body.rule).toBe('Always use the md tag')
    // count + sample travel too: the ledger row records the strength of the
    // recurrence that justified the bind, not just the rule text.
    expect(body.candidate.count).toBe(3)
    expect(body.candidate.sample).toContain('md tag')
  })

  it('surfaces a route refusal instead of resolving as if the bind landed', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: 'bind-candidate requires candidate.theme[] and a rule' })
    })) as any
    const r = await bindCandidate(cand(), '')
    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('theme')
  })
})
