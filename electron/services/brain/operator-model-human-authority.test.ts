// Human authority over the operator model — "a fact you stated is never retired, pruned, evicted or
// relabelled by a model on its own" (README "Memory you can read", docs/architecture.md, constitution §3).
//
// Before this suite the sentence was copy, not code. Every model-driven retirement path in this module
// treated an operator-stated fact like any other row:
//   - runAutoSupersede offered EVERY active fact to the LLM judge, with model-extracted facts as the
//     triggers, and the replacement it minted inherited the retired row's `operator` tag — a model
//     conclusion wearing the operator's provenance (constitution §3's exact failure mode);
//   - verifyPool hard-deleted any candidate the verifier failed to echo back, source unread;
//   - evictToCap ordered churn by status and age only, so an operator-stated candidate could be the
//     row the cap dropped while machine noise survived;
//   - reflect() let a model-inferred word-superset absorb the operator's own statement.
//
// The invariant these tests pin: an operator-stated fact (source 'operator', or a fact a human
// adjudicated) can be superseded only by a fact the operator states, and is exempt from the model's
// prune, the cap's eviction order and reflect's absorption. Machine facts keep every existing behavior,
// so the controls below prove the guards are guards, not off-switches.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const chatOnce = vi.fn()
vi.mock('../providers/registry', () => ({
  chatOnce: (...a: unknown[]) => chatOnce(...a),
  routeModel: () => ({ id: 'test-model', provider: 'test' }),
  routeDistinctModel: () => null,
  routeDistinctModels: () => []
}))
// The capture-surprise gate lazily imports the embedder; keep every candidate and never touch the index.
vi.mock('./surprise-gate', () => ({ surpriseGate: async (c: string[]) => ({ keep: c, dropped: [] }) }))
vi.mock('../local-brain/index-store', () => ({ embedForRecall: async () => null }))

import {
  setOperatorModelPath,
  recordFacts,
  learnFromTurn,
  verifyPool,
  reflect,
  supersedeFact,
  promoteFact,
  getAllOperatorFacts,
  getEvictionLog,
  isOperatorStated,
  factSource,
  __resetOperatorModel
} from './operator-model'

type Msg = { role: string; content: string }
type Meta = { purpose: string; role: string }

/** Route learnFromTurn's three model calls by their `role` audit tag. */
const wireModel = (opts: { extraction: string[]; judge: string }): void => {
  chatOnce.mockImplementation((msgs: Msg[], _model: unknown, _sig: unknown, meta: Meta) => {
    if (meta?.role === 'operator-supersede') return Promise.resolve({ content: opts.judge })
    if (meta?.role === 'operator-verify') {
      const shown = msgs.find((m) => m.role === 'user')!.content.split('\n\nCANDIDATES:\n')[1] ?? ''
      return Promise.resolve({ content: JSON.stringify(shown.split('\n').filter(Boolean)) })
    }
    return Promise.resolve({ content: JSON.stringify(opts.extraction) }) // operator-learning
  })
}

const judgeCalls = (): Msg[][] =>
  chatOnce.mock.calls.filter((c) => (c[3] as Meta)?.role === 'operator-supersede').map((c) => c[0] as Msg[])

const byText = (text: string) => getAllOperatorFacts().find((f) => f.fact === text)
const byId = (id: string | null) => getAllOperatorFacts().find((f) => f.id === id)

// Two shared content tokens ("code", "editor") put the old fact in front of the judge (overlap floor = 2).
const OLD_EDITOR = 'Operator uses VSCode as the main code editor'
const MACHINE_EDITOR = 'Operator switched to Neovim as the main code editor'

beforeEach(() => {
  setOperatorModelPath(join(mkdtempSync(join(tmpdir(), 'duin-ha-')), 'operator-model.json'))
  __resetOperatorModel()
  chatOnce.mockReset()
})

describe('isOperatorStated', () => {
  it('is true for operator-sourced rows, legacy untagged rows, and human-adjudicated machine rows', () => {
    recordFacts([
      { fact: 'Operator prefers tea in the afternoon', kind: 'context', source: 'operator' },
      { fact: 'Operator ships releases on Fridays', kind: 'context', source: 'machine' }
    ])
    const op = byText('Operator prefers tea in the afternoon')!
    const mc = byText('Operator ships releases on Fridays')!
    expect(isOperatorStated(op)).toBe(true)
    expect(isOperatorStated(mc)).toBe(false)
    expect(isOperatorStated({ ...mc, source: undefined })).toBe(true) // legacy rows read as operator (factSource)
    expect(promoteFact(mc.id)).toBe(true) // a human endorsed it → human authority now covers it
    expect(isOperatorStated(byText('Operator ships releases on Fridays')!)).toBe(true)
  })
})

describe('T1/T2 — auto-supersession: only the operator can retire what the operator stated', () => {
  it('a MODEL-extracted fact never reaches the judge against an operator-stated fact, and retires nothing', async () => {
    recordFacts([{ fact: OLD_EDITOR, kind: 'context', source: 'operator' }])
    wireModel({ extraction: [MACHINE_EDITOR], judge: '1' })

    // No keyless teaching in this turn: the only trigger is the model's own inference.
    await learnFromTurn('which editor would you use for a rust project?', 'Neovim is a fine choice')

    expect(judgeCalls()).toHaveLength(0) // the pool offered to a machine trigger excludes operator-stated rows
    expect(byText(OLD_EDITOR)?.invalidatedAt).toBeUndefined()
    // The model's inference is still captured — as a MACHINE candidate, not as a replacement.
    const inferred = byText(MACHINE_EDITOR)
    expect(inferred).toBeDefined()
    expect(factSource(inferred!)).toBe('machine')
  })

  it('a model-extracted fact can still retire a MACHINE fact, and the replacement is tagged machine', async () => {
    recordFacts([{ fact: OLD_EDITOR, kind: 'context', source: 'machine' }])
    wireModel({ extraction: [MACHINE_EDITOR], judge: '1' })

    await learnFromTurn('which editor would you use for a rust project?', 'Neovim is a fine choice')

    expect(judgeCalls()).toHaveLength(1)
    const old = byText(OLD_EDITOR)!
    expect(old.invalidatedAt).toBeDefined()
    const replacement = byId(old.supersededBy ?? null)
    expect(replacement?.fact).toBe(MACHINE_EDITOR)
    expect(factSource(replacement!)).toBe('machine') // never launders into 'operator'
  })

  it('the operator\'s OWN keyless teaching retires the operator-stated fact, and the replacement is operator-sourced', async () => {
    recordFacts([{ fact: OLD_EDITOR, kind: 'context', source: 'operator' }])
    wireModel({ extraction: [], judge: '1' })

    // "my X is Y" is the keyless teaching path.
    await learnFromTurn('my main code editor is now Neovim', 'noted')

    expect(judgeCalls()).toHaveLength(1)
    const old = byText(OLD_EDITOR)!
    expect(old.invalidatedAt).toBeDefined()
    const replacement = byId(old.supersededBy ?? null)
    expect(replacement).toBeDefined()
    expect(factSource(replacement!)).toBe('operator')
  })
})

describe('T3 — supersedeFact refuses a machine or external replacement of an operator-stated fact', () => {
  it('blocks machine and external sources on operator-stated rows, allows them on machine rows', () => {
    recordFacts([
      { fact: 'Operator ships releases on Fridays', kind: 'context', source: 'operator' },
      { fact: 'Operator drinks tea at three', kind: 'context', source: 'machine' },
      { fact: 'Operator reviews the roadmap on Mondays', kind: 'context', source: 'machine' }
    ])
    const op = byText('Operator ships releases on Fridays')!
    const mc = byText('Operator drinks tea at three')!
    const endorsed = byText('Operator reviews the roadmap on Mondays')!

    expect(supersedeFact(op.id, 'Operator ships releases on Mondays', 'context', 'machine').superseded).toBe(false)
    expect(supersedeFact(op.id, 'Operator ships releases on Mondays', 'context', 'external').superseded).toBe(false)
    expect(op.invalidatedAt).toBeUndefined()
    expect(byText('Operator ships releases on Mondays')).toBeUndefined() // no orphan replacement minted

    const r = supersedeFact(mc.id, 'Operator drinks coffee at three', 'context', 'machine')
    expect(r.superseded).toBe(true)
    expect(factSource(byId(r.newId)!)).toBe('machine')

    // A human promotion puts a machine fact under human authority.
    expect(promoteFact(endorsed.id)).toBe(true)
    expect(supersedeFact(endorsed.id, 'Operator reviews the roadmap on Fridays', 'context', 'machine').superseded).toBe(false)
    // The operator may still change their own mind.
    expect(supersedeFact(op.id, 'Operator ships releases on Mondays', 'context', 'operator').superseded).toBe(true)
  })
})

describe('T4 — verifyPool never drops an operator-stated candidate', () => {
  it('prunes the machine candidate the verifier omitted and keeps the operator one it also omitted', async () => {
    recordFacts([
      { fact: 'Operator prefers concise confirmations', kind: 'context', source: 'operator' },
      { fact: 'Operator uses VSCode as editor', kind: 'context', source: 'machine' },
      { fact: 'Operator ships releases on Fridays', kind: 'context', source: 'machine' }
    ])
    chatOnce.mockResolvedValue({ content: JSON.stringify(['Operator uses VSCode as editor']) })

    const r = await verifyPool()

    expect(r.dropped).toBe(1)
    expect(byText('Operator ships releases on Fridays')).toBeUndefined()
    expect(byText('Operator prefers concise confirmations')?.status).toBe('candidate')
    expect(getEvictionLog().some((e) => e.fact === 'Operator prefers concise confirmations')).toBe(false)
  })
})

describe('T5 — cap eviction drops machine churn before operator-stated churn', () => {
  it('keeps the two OLDEST rows when they are operator-stated and evicts the oldest machine candidate instead', () => {
    const MAX_FACTS = 300
    recordFacts([
      { fact: 'Operator prefers tea in the afternoon', kind: 'context', source: 'operator' },
      { fact: 'Operator prefers quiet mornings for writing', kind: 'context', source: 'operator' }
    ])
    recordFacts(
      Array.from({ length: MAX_FACTS - 2 }, (_, i) => ({ fact: `Operator fact number ${i} about work`, kind: 'context', source: 'machine' as const }))
    )
    expect(getAllOperatorFacts()).toHaveLength(MAX_FACTS)

    recordFacts([{ fact: 'Operator fact number extra about work', kind: 'context', source: 'machine' }])

    const texts = getAllOperatorFacts().map((f) => f.fact)
    expect(texts).toContain('Operator prefers tea in the afternoon')
    expect(texts).toContain('Operator prefers quiet mornings for writing')
    const evicted = getEvictionLog()
    expect(evicted).toHaveLength(1)
    expect(evicted[0].fact).toBe('Operator fact number 0 about work') // the oldest MACHINE candidate
  })
})

describe('T6 — reflect never absorbs an operator-stated row into a model superset', () => {
  it('leaves the operator statement live and still merges machine subsets into machine supersets', () => {
    recordFacts([
      { fact: 'Operator ships code on fridays', kind: 'context', source: 'operator' },
      { fact: 'Operator never ships code on fridays', kind: 'context', source: 'machine' },
      { fact: 'Operator reviews pull requests', kind: 'context', source: 'machine' },
      { fact: 'Operator reviews pull requests from ana only', kind: 'context', source: 'machine' }
    ])

    reflect()

    expect(byText('Operator ships code on fridays')?.invalidatedAt).toBeUndefined()
    expect(byText('Operator reviews pull requests')?.invalidatedAt).toBeDefined() // control: same-trust merge intact
    expect(byText('Operator reviews pull requests')?.invalidatedBy).toBe('reflect')
  })
})
