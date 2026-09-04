// The govern jury's `RULES (confirmed)` context must carry LIVE rules only.
//
// BITEMPORAL LIVENESS: supersedeFact retires a rule by stamping `invalidatedAt` and deliberately
// LEAVING `status: 'promoted'` (soft-delete, so the audit can walk why a rule fell), so
// `listByStatus('promoted')` keeps serving retired rules FOREVER. defaultGovernJury shipped that
// list verbatim under the literal header `RULES (confirmed)`, which turns JURY_SYSTEM's "do NOT
// contradict a confirmed rule" against the operator's own correction: told the dead rule still
// holds, the jurors dutifully OMIT the replacement fact that superseded it — and omission from
// this keep-list means REVERT. So on the next governTick (server.ts, 30-min debounce) the
// corrected-away rule auto-reverts its own successor, unattended; `reverted` is remembered
// precisely so the fact isn't blindly re-promoted.
//
// Nothing upstream catches it: a SINGLE stale omission slips under the mass-revert guard
// (`pass.size * 2 < provisional.length`), which only trips on a majority rejection.
//
// Sibling readers already carry this predicate — runGovernPass's `prov` (operator-govern.ts) and
// verifyPool's `rules` (operator-model.ts). This one did not, and was invisible because retiring a
// rule strips it from every surface an operator can SEE (buildOperatorBlock stops grounding it, the
// concept file moves to `.brain/_retired/`) while never touching the one field this reader consulted.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { OperatorFact } from './operator-model'

const h = vi.hoisted(() => ({
  store: [] as OperatorFact[],
  /** every user message the panel actually sent, so the prompt itself can be asserted on */
  prompts: [] as string[],
  reverted: [] as string[],
  confirmed: [] as string[]
}))

vi.mock('../providers/registry', () => ({
  routeModel: () => 'extractor-model',
  routeDistinctModels: () => ['juror-a'],
  // P0 (W4): MIN_JURY_ANSWERS (2) — two jurors; both are answered by the literal juror below.
  resolveJury: () => [
    { task: 'jury', modelId: 'juror-a', provider: 'prov-juror-a', chain: ['juror-a'], source: 'policy' },
    { task: 'jury', modelId: 'juror-b', provider: 'prov-juror-b', chain: ['juror-b'], source: 'policy' }
  ],
  getProviderForModel: (m: string) => (m === 'extractor-model' ? 'zhipu' : `prov-${m}`),
  chatOnce: async (msgs: { role: string; content: string }[]) => {
    const user = msgs.find((m) => m.role === 'user')!.content
    h.prompts.push(user)
    return { content: JSON.stringify(literalJuror(user)) }
  }
}))
// The real firewall resolves its denylist from vault state on first use. Pin it open so this test
// measures LIVENESS only and never accidentally passes because a term got redacted.
vi.mock('../governance/confidential-firewall', () => ({ firewallClear: () => true }))
vi.mock('./operator-model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./operator-model')>()
  return {
    ...actual,
    // Status-only read, exactly like the real one — that is the whole point.
    listByStatus: (s: string) => h.store.filter((f) => f.status === s),
    confirmFact: (id: string) => {
      h.confirmed.push(id)
      return true
    },
    revertFact: (id: string) => {
      h.reverted.push(id)
      return true
    },
    recordGovernProvenance: () => {}
  }
})

const { defaultGovernJury, runGovernPass } = await import('./operator-govern')

/** A juror that follows JURY_SYSTEM literally: endorse every candidate VERBATIM except one that
 *  contradicts a rule it was shown. Contradiction is modelled the way any competent model reads it
 *  — two statements about the SAME subject asserting different values. The jury is not the defect
 *  here; it behaves correctly on whatever context it is handed. */
function literalJuror(userMsg: string): string[] {
  const [head, tail] = userMsg.split('\n\nCANDIDATES (on probation):\n')
  const rules = head.replace('RULES (confirmed):\n', '').split('\n').filter((l) => l && l !== '(none)')
  const subject = (s: string): string => s.split(' is ')[0].trim().toLowerCase()
  return tail
    .split('\n')
    .filter((c) => !rules.some((r) => r.includes(' is ') && c.includes(' is ') && subject(r) === subject(c) && r !== c))
}

const RETIRED_RULE = 'my editor is VSCode'
const LIVE_RULE = 'ship the smallest change that works'
const REPLACEMENT = 'my editor is Neovim'

const f = (o: Partial<OperatorFact> & Pick<OperatorFact, 'id' | 'fact' | 'status'>): OperatorFact =>
  ({ kind: 'context', ts: 1, observedSessions: ['s1', 's2', 's3'], ...o }) as OperatorFact

/** Seven unrelated provisional facts (none contain " is ", so none can trip the juror) plus the
 *  replacement. Eight is enough that dropping ONE leaves the mass-revert guard un-tripped. */
const provisionalPool = (): OperatorFact[] => [
  f({ id: 'neovim', fact: REPLACEMENT, status: 'provisional', kind: 'correction' }),
  ...[
    'review PRs before merging',
    'report the number, not the vibe',
    'lead with the outcome',
    'say what was skipped',
    'verify before claiming',
    'prefer a guard clause over a new layer',
    'keep the diff small'
  ].map((t, i) => f({ id: `p${i}`, fact: t, status: 'provisional' }))
]

beforeEach(() => {
  h.prompts = []
  h.reverted = []
  h.confirmed = []
  h.store = [
    // supersedeFact stamped invalidatedAt and LEFT status 'promoted'.
    f({ id: 'vscode', fact: RETIRED_RULE, status: 'promoted', invalidatedAt: 2, supersededBy: 'neovim' }),
    f({ id: 'live', fact: LIVE_RULE, status: 'promoted' }),
    ...provisionalPool()
  ]
})

describe('defaultGovernJury — retired rules must not be presented as confirmed context', () => {
  it('the retired rule never reaches the jury prompt; the live one still does', async () => {
    await defaultGovernJury(provisionalPool())

    // Two seated jurors (MIN_JURY_ANSWERS), one prompt each — the same context reaches both.
    expect(h.prompts).toHaveLength(2)
    for (const prompt of h.prompts) {
      expect(prompt).toContain(LIVE_RULE)
      expect(prompt).not.toContain('VSCode') // the whole defect, in one assertion
    }
  })

  it('does not omit the replacement fact that superseded the retired rule', async () => {
    const r = await defaultGovernJury(provisionalPool())

    // Pre-fix: the juror is shown the dead VSCode rule, correctly reads "my editor is Neovim" as
    // contradicting it, and omits it — pass.size 7 of 8, which the majority-only mass-revert guard
    // waves through.
    expect(r.pass!.has('neovim')).toBe(true)
    expect(r.pass!.size).toBe(8)
  })

  it('END TO END: a govern pass must not auto-revert the operator up-to-date fact', async () => {
    const res = await runGovernPass(defaultGovernJury)

    expect(h.reverted).toEqual([]) // pre-fix: ['neovim'] — revertFact on the CURRENT fact
    expect(res.reverted).toBe(0)
    expect(h.confirmed).toContain('neovim')
  })

  it('a LIVE confirmed rule still binds — this filters retired rules, not all rules', async () => {
    // Same store, except the operator never corrected the VSCode rule: it is genuinely current.
    h.store = h.store.map((x) => (x.id === 'vscode' ? f({ id: 'vscode', fact: RETIRED_RULE, status: 'promoted' }) : x))

    const r = await defaultGovernJury(provisionalPool())

    expect(h.prompts[0]).toContain('VSCode')
    expect(r.pass!.has('neovim')).toBe(false) // a real conflict with a real confirmed rule still reverts
  })
})
