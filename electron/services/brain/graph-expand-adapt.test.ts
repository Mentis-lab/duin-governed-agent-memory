import { describe, it, expect, afterAll } from 'vitest'
import {
  adaptGraphViewToEntityGraph,
  buildGraphExpandContext,
  graphExpandGroundEnabled
} from './graph-expand-adapt'
import type { GraphView } from './retrieve-agent'
import type { WNNote } from './wholenote-ground'
import { readFileSync } from 'fs'
import { join } from 'path'

// A DUIN-style live graph (deriveGraph ⨝ construction): note nodes (id = note relpath) + entity
// nodes carrying their source `note`, connected by typed edges. Mirrors the Beacon/Atlas idiom.
const GRAPH: GraphView = {
  nodes: [
    { id: 'p0-beacon.md', label: 'beacon', kind: 'note' },
    { id: 'p1-people.md', label: 'people', kind: 'note' },
    { id: 'p2-atlas.md', label: 'atlas-note', kind: 'note' },
    { id: 'decision:designer-hire', label: 'designer hire', kind: 'decision', note: 'p0-beacon.md' },
    { id: 'project:beacon', label: 'Beacon', kind: 'project', note: 'p0-beacon.md' },
    { id: 'person:sam', label: 'Sam Rivera', kind: 'person', note: 'p1-people.md' },
    { id: 'person:jordan', label: 'Jordan Lee', kind: 'person', note: 'p1-people.md' },
    { id: 'project:atlas', label: 'Atlas', kind: 'project', note: 'p2-atlas.md' },
    { id: 'decision:postgres', label: 'Postgres adoption', kind: 'decision', note: 'p2-atlas.md' }
  ],
  edges: [
    { source: 'decision:designer-hire', target: 'project:beacon', type: 'blocks' },
    { source: 'person:sam', target: 'project:beacon', type: 'owns' }, // Sam (p1) owns Beacon (p0) → bridge
    { source: 'person:jordan', target: 'project:atlas', type: 'owns' }, // Jordan (p1) owns Atlas (p2) → bridge
    { source: 'project:atlas', target: 'decision:postgres', type: 'depends' }, // same note (p2) → no bridge
    { source: 'p1-people.md', target: 'p2-atlas.md', type: 'link' } // direct note↔note structural link
  ]
}
const NOTE_IDS = ['p0-beacon.md', 'p1-people.md', 'p2-atlas.md']

describe('adaptGraphViewToEntityGraph', () => {
  const eg = adaptGraphViewToEntityGraph(GRAPH, NOTE_IDS)

  it('turns a cross-note OWNS edge into a co-mention bridge (the multi-hop signal)', () => {
    // Sam-owns-Beacon links the people note to the beacon note → both entities span both notes.
    expect(eg.entityIndex['beacon']).toEqual(['p0-beacon.md', 'p1-people.md'])
    expect(eg.entityIndex['sam rivera']).toEqual(['p0-beacon.md', 'p1-people.md'])
  })

  it('leaves a same-note entity single-membered (df=1 — bridges nothing, dropped by the retriever)', () => {
    expect(eg.entityIndex['designer hire']).toEqual(['p0-beacon.md'])
    expect(eg.entityIndex['postgres adoption']).toEqual(['p2-atlas.md'])
  })

  it('synthesizes a bridge token for a direct note↔note structural edge', () => {
    expect(eg.entityIndex['__link__:p1-people.md|p2-atlas.md']).toEqual(['p1-people.md', 'p2-atlas.md'])
  })

  it('lists per-note entities (normalized, sorted) and covers every corpus note', () => {
    expect(eg.nodes.map((n) => n.note)).toEqual(NOTE_IDS)
    const p0 = eg.nodes.find((n) => n.note === 'p0-beacon.md')!
    expect(p0.entities).toContain('beacon')
    expect(p0.entities).toContain('designer hire')
  })

  it('drops stale note ids not present in the corpus', () => {
    const eg2 = adaptGraphViewToEntityGraph(GRAPH, ['p0-beacon.md', 'p1-people.md']) // p2 excluded
    expect(eg2.entityIndex['atlas'] ?? []).not.toContain('p2-atlas.md')
    for (const ids of Object.values(eg2.entityIndex)) expect(ids).not.toContain('p2-atlas.md')
  })

  it('is deterministic (same input → identical output)', () => {
    expect(adaptGraphViewToEntityGraph(GRAPH, NOTE_IDS)).toEqual(eg)
  })
})

describe('buildGraphExpandContext', () => {
  const NOTES: WNNote[] = [
    { id: 'p0-beacon.md', text: '---\nx: 1\n---\nBeacon is blocked by the pending designer hire decision.' },
    { id: 'p1-people.md', text: 'Sam Rivera owns the Beacon project. Jordan Lee owns Atlas.' },
    { id: 'p2-atlas.md', text: 'Atlas depends on the Postgres adoption decision.' }
  ]

  it('assembles a whole-note context block reusing the [Note: id] format, frontmatter stripped', () => {
    const { context, used, hopsUsed } = buildGraphExpandContext(
      'Who owns the project the designer hire decision is blocking?',
      NOTES,
      GRAPH
    )
    expect(context).toContain('[Note: p0-beacon.md]')
    expect(context).not.toContain('x: 1') // frontmatter stripped by the shared assembler
    expect(used.length).toBeGreaterThan(0)
    expect(hopsUsed).toBeGreaterThanOrEqual(1)
  })

  it('surfaces the answer-bearing bridge note (p1) that BM25 reaches only via the graph', () => {
    const { context } = buildGraphExpandContext(
      'Who owns the project the designer hire decision is blocking?',
      NOTES,
      GRAPH
    )
    expect(context).toContain('[Note: p1-people.md]')
  })
})

// 2026-07-25 — the default is OFF again (opt-IN, `=== '1'`). P1 had flipped it to opt-OUT
// (`!== '0'`, default ON) on a "+8pp recall@gold on multi-hop" claim measured on 10–20-note TUNE
// corpora. That claim does NOT reproduce at vault scale. Offline eval on the operator's real index
// (25 probes, 12,793 chunks, 100% vector coverage, exact brute-force KNN, verbatim ports of the
// production scoring fns), against the RRF 2:1 fusion this branch REPLACES:
//     RRF 2:1 fusion   recall@5 0.408   MRR 0.636
//     graph-expand     recall@5 0.318   MRR 0.533     →  −9.0pp recall@5, −10.3pp MRR
// Multi-hop is an exact TIE at k=5 (0.450 vs BM25 0.450) and −28.4pp at the production
// DUIN_WHOLENOTE_TOPK=12 (0.483 vs 0.767). These tests replace the prior "ON by default" assertions.
// The feature itself is untouched and still works when DUIN_GRAPH_EXPAND_GROUND=1.
describe('graphExpandGroundEnabled — OFF by default (opt-IN; the default-ON arm measured WORSE)', () => {
  const orig = process.env.DUIN_GRAPH_EXPAND_GROUND
  afterAll(() => {
    if (orig === undefined) delete process.env.DUIN_GRAPH_EXPAND_GROUND
    else process.env.DUIN_GRAPH_EXPAND_GROUND = orig
  })

  it('is FALSE when the flag is unset — the shipped default is the measured-better RRF fusion path', () => {
    delete process.env.DUIN_GRAPH_EXPAND_GROUND
    expect(graphExpandGroundEnabled()).toBe(false)
  })
  it('is true ONLY for an explicit "1" (opt-in), so the feature stays fully usable', () => {
    process.env.DUIN_GRAPH_EXPAND_GROUND = '1'
    expect(graphExpandGroundEnabled()).toBe(true)
  })
  it('is false for every other value — "0" and any truthy-looking string alike (no accidental re-enable)', () => {
    // The old kill-switch value '0' still disables; the point of the flip is that '', 'true', 'yes'
    // no longer ENABLE. A sloppy `!== '0'` re-introduction would fail on 'true'/'yes'/''.
    for (const v of ['0', '', 'true', 'yes', 'on', '2']) {
      process.env.DUIN_GRAPH_EXPAND_GROUND = v
      expect(graphExpandGroundEnabled(), `value ${JSON.stringify(v)} must NOT enable`).toBe(false)
    }
  })
})

// Dispatch composition proof (structural). The HTTP grounding path is not unit-mountable, so we
// assert the invariants that make the three-way fallback compose correctly directly on server.ts
// source:
//   1. the graph-expand branch's ONLY entry gate is `query && graphExpandGroundEnabled()` (now
//      default-OFF / opt-in again — see the polarity tests above), and it is the sole caller of
//      buildGraphExpandContext;
//   2. the BM25 whole-note branch is guarded by `!contextOverride`, so graph-expand takes precedence
//      and whole-note runs only as its FALLBACK (when graph-expand yielded nothing);
//   3. the agentic snippet retriever is ALSO guarded by `!contextOverride`, so it stays reachable as
//      the FINAL fallback when neither validated-better path yielded context.
// If someone ungated a branch or dropped a guard, this fails.
describe('server wiring — three-way grounding fallback composes correctly (structural invariants)', () => {
  const src = readFileSync(join(__dirname, '..', 'local-brain', 'server.ts'), 'utf-8')

  it('the graph-expand branch is entered ONLY behind graphExpandGroundEnabled()', () => {
    expect(src).toMatch(/if\s*\(\s*query\s*&&\s*graphExpandGroundEnabled\(\)\s*\)/)
    // and it is the caller of buildGraphExpandContext (nothing else invokes the retriever grounding).
    expect(src).toContain('buildGraphExpandContext(')
  })

  it('the BM25 whole-note branch defers via !contextOverride (so graph-expand takes precedence)', () => {
    // P8: the whole-note RUNNING branch is now additionally gated on wholeNoteEgressAllowed(modelId),
    // but the !contextOverride precedence guard is preserved (graph-expand still wins first).
    // 2026-08-17: the flag/breadth half now resolves into `wholeNoteWanted` (adaptive
    // breadth — see grounding-breadth.ts). The two invariants this pins are unchanged:
    // !contextOverride precedence, and the P8 egress gate on the RUNNING branch.
    expect(src).toMatch(
      /if\s*\(\s*!contextOverride\s*&&\s*query\s*&&\s*wholeNoteWanted\s*&&\s*wholeNoteEgressAllowed\(modelId\)\s*\)/
    )
    // …and `wholeNoteWanted` cannot become true without the master flag. Without this the
    // indirection introduced above would let a future edit satisfy the branch on breadth alone.
    expect(src).toMatch(/const\s+wholeNoteWanted\s*=\s*wholeNoteGroundEnabled\(\)\s*&&/)
  })

  it('the agentic retriever stays reachable as the final fallback (guarded by !contextOverride)', () => {
    expect(src).toMatch(/if\s*\(\s*!contextOverride\s*&&\s*query\s*&&\s*agenticRetrieverEnabled\(\)\s*\)/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// REGRESSION GUARD (2026-07-25) — the default path must run the FOUR downstream ranking stages.
//
// The defect this locks down was not "a boolean was ON". It was that turning it on SILENTLY DELETED
// four ranking stages: the branch sets `contextOverride`, and every one of these is gated on
// `!contextOverride`, so all four were skipped on a default install —
//     1. 1-hop graph-neighbour merge      (mergeGraphNeighbors)
//     2. shared cross-encoder rerank      (rerankHits)
//     3. taste-rerank                     (tasteRerank)
//     4. claim-freshness demotion         (applyClaimFreshness)
// — and agui-grounding's `contextOverride ?? hitsToContext(hits)` then threw away the RRF-fused
// `hits` those stages operate on. So a test that only asserts env parsing is NOT enough: it would
// still pass if someone re-armed the branch from a different call site or moved a stage above it.
//
// The chat handler is not unit-mountable (server.ts imports electron), so this proves the SAME
// invariant structurally, which is this file's established idiom (see the dispatch tests above):
//   (a) the default env leaves the branch UNREACHABLE (functional — calls the real predicate);
//   (b) every one of the four stages is still guarded by `!contextOverride` and sits AFTER the
//       graph-expand dispatch, so an unset flag means nothing suppresses them;
//   (c) the set of writers to `contextOverride` is PINNED to the three known branches, so a new
//       one cannot appear and re-suppress the stages unnoticed.
describe('regression — with the default (unset) flag, all four downstream ranking stages run', () => {
  const src = readFileSync(join(__dirname, '..', 'local-brain', 'server.ts'), 'utf-8')
  const agui = readFileSync(join(__dirname, '..', 'local-brain', 'agui-grounding.ts'), 'utf-8')

  /** The dispatch-site index of the graph-expand branch (not its definition/comment). */
  const graphExpandIdx = src.search(/if\s*\(\s*query\s*&&\s*graphExpandGroundEnabled\(\)\s*\)/)

  /** The four stages, each identified by a call only IT makes, in pipeline order. */
  const STAGES: { name: string; marker: string }[] = [
    { name: '1-hop graph-neighbour merge', marker: 'mergeGraphNeighbors(' },
    { name: 'cross-encoder rerank', marker: 'await rerankHits(' },
    { name: 'taste-rerank', marker: 'await tasteRerank(' },
    { name: 'claim-freshness demotion', marker: 'applyClaimFreshness(' }
  ]

  /** The handler-level `if (…)` that encloses `marker` (handler statements are indented 4 spaces). */
  function enclosingGuard(marker: string): string {
    const at = src.indexOf(marker)
    expect(at, `stage marker not found in server.ts: ${marker}`).toBeGreaterThan(-1)
    const ifAt = src.lastIndexOf('\n    if (', at)
    expect(ifAt, `no handler-level guard found before ${marker}`).toBeGreaterThan(-1)
    return src.slice(ifAt + 1, src.indexOf('{', ifAt))
  }

  // (a) FUNCTIONAL: the real predicate, under the real default env, says the branch does not run.
  it('the default env (flag unset) leaves the graph-expand branch unreachable', () => {
    const orig = process.env.DUIN_GRAPH_EXPAND_GROUND
    try {
      delete process.env.DUIN_GRAPH_EXPAND_GROUND
      expect(graphExpandGroundEnabled()).toBe(false)
    } finally {
      if (orig === undefined) delete process.env.DUIN_GRAPH_EXPAND_GROUND
      else process.env.DUIN_GRAPH_EXPAND_GROUND = orig
    }
    // …and that predicate is the branch's ONLY entry gate, so false ⇒ the body cannot execute
    // ⇒ this branch cannot assign contextOverride ⇒ it cannot suppress the four stages.
    expect(graphExpandIdx).toBeGreaterThan(-1)
  })

  // (b) STRUCTURAL: each stage is `!contextOverride`-gated and downstream of the dispatch.
  for (const { name, marker } of STAGES) {
    it(`stage "${name}" is gated on !contextOverride and sits AFTER the graph-expand dispatch`, () => {
      expect(enclosingGuard(marker)).toContain('!contextOverride')
      expect(src.indexOf(marker)).toBeGreaterThan(graphExpandIdx)
    })
  }

  it('the four stages appear in pipeline order (no stage was quietly hoisted above another)', () => {
    const idxs = STAGES.map((s) => src.indexOf(s.marker))
    expect(idxs).toEqual([...idxs].sort((a, b) => a - b))
  })

  // (c) PINNED WRITER SET: only these branches may assign contextOverride. If an unaccounted-for one
  // appears, the "unset flag ⇒ stages run" reasoning silently breaks and this fails.
  //
  // UPDATED 2026-07-25 (three → four), DELIBERATELY. The ⚠ that used to sit here recorded that the
  // AGENTIC retriever — default-ON whenever a model is configured — also set contextOverride at its
  // dispatch site and suppressed these same four stages, and called that "a pre-existing design
  // decision (the agentic pass ranks its own citations)". That justification has now been MEASURED and
  // it does not hold: routing the citations through the stages instead scores recall@5 0.431 vs 0.316,
  // MRR 0.870 vs 0.797, any-hit@5 0.938 vs 0.815 (paired, 65 live probe-runs — see
  // brain/agentic-bypass.eval.ts). So the agentic branch now writes contextOverride AFTER the
  // four stages, and the old pre-stage compile write survives only behind the
  // DUIN_AGENTIC_RANK_STAGES=0 kill-switch. Net: FOUR write sites, but only three of them can suppress
  // a stage, and the fourth (the agentic render) provably cannot because it runs last.
  // The suppression-ordering invariant itself is pinned in local-brain/agentic-rank-stages.test.ts.
  it('exactly four branches write contextOverride (graph-expand, whole-note, agentic×2) — no new suppressor', () => {
    const writes = src.match(/^\s*contextOverride = /gm) ?? []
    expect(writes.length).toBe(4)
    expect(src).toContain('const { context, used, hopsUsed } = buildGraphExpandContext(') // #1 graph-expand
    expect(src).toContain('wholeNoteWanted && wholeNoteEgressAllowed(modelId)') // #2 whole-note
    expect(src).toContain('contextOverride = compiled.context') // #3 agentic, KILL-SWITCH path only
    expect(src).toContain('contextOverride = citationsToContext(orderCitationsByHits(') // #4 agentic, default
    // …and the two OTHER writers are themselves `!contextOverride`-gated, i.e. neither can fire
    // before the graph-expand dispatch — the flip is what decides the head of this chain.
    expect(src).toMatch(/if\s*\(\s*!contextOverride\s*&&\s*query\s*&&\s*wholeNoteWanted/)
    expect(src).toMatch(/if\s*\(\s*!contextOverride\s*&&\s*query\s*&&\s*agenticRetrieverEnabled\(\)/)
  })

  // The consumer side: an unset contextOverride is what lets the RRF-fused `hits` reach the model.
  // `const|let` because the evidence gate appends its caveat to the same binding — the invariant
  // being pinned is the FALLBACK EXPRESSION, not the declaration keyword.
  it('agui-grounding falls back to the fused hits when contextOverride is unset', () => {
    // `let` since the evidence gate may append a caveat; the guarded property is the FALLBACK
    // (contextOverride ?? hitsToContext(hits)), not the binding kind.
    expect(agui).toMatch(/(?:const|let) context = contextOverride \?\? hitsToContext\(hits\)/)
  })

  // The evidence gate mutates that same binding, so it must not fire on a context this
  // module did not produce — `hits` does not describe an overridden context, and judging
  // it there would be judging the wrong evidence.
  it('the evidence gate is skipped when contextOverride is set', () => {
    expect(agui).toMatch(/evidenceGateEnabled\(\)\s*&&\s*!contextOverride/)
  })
})

// P1 keeps wholeNoteGroundEnabled OPT-IN (=== '1', default OFF) as a deliberate PRIVACY decision:
// unlike the local model-free graph-expand path, whole-note ships up to ~120K chars of full vault-note
// bodies to the (possibly cloud/CN-hosted) answer provider — a real data-egress cost on a sensitive
// vault, held to the operator's explicit call. That function is private to server.ts (not import-
// mountable), so we assert the opt-IN polarity on the source. Graph-expand (above) IS default-on.
describe('wholeNoteGroundEnabled — OFF by default (opt-IN, privacy: full-note egress)', () => {
  const src = readFileSync(join(__dirname, '..', 'local-brain', 'server.ts'), 'utf-8')

  it('reads DUIN_WHOLENOTE_GROUND with opt-IN polarity (=== "1"), so it does NOT egress note bodies by default', () => {
    expect(src).toMatch(/function wholeNoteGroundEnabled\(\)\s*:\s*boolean\s*\{\s*return\s+process\.env\.DUIN_WHOLENOTE_GROUND\s*===\s*'1'/)
  })

  it('does NOT flip the trap-guard flags (MODE stays non-fuse default, NOTECAP 20000, SUPPORT_DROP off)', () => {
    // These must remain untouched (bench-regressing if flipped). Assert their safe defaults survive:
    expect(src).toMatch(/process\.env\.DUIN_WHOLENOTE_MODE\s*\|\|\s*'bm25'/) // default 'bm25', NOT 'fuse'
    expect(src).toMatch(/\?\s*Number\(rawCap\)\s*:\s*20000/) // NOTECAP default 20000
  })
})

// P8 · private-grounding guard. Whole-note ships FULL note bodies to the answer model; if that model
// is cloud-hosted this egresses the operator's sensitive vault. The guard makes the branch FAIL CLOSED:
// full bodies go out only when the turn's answer model is LOCAL (wholeNoteEgressAllowed → isLocalModel)
// or the operator explicitly set DUIN_WHOLENOTE_ALLOW_CLOUD=1. The dispatch is not import-mountable
// (server.ts imports electron), so we assert the guard invariants on the source — the predicates
// themselves are unit-tested in providers/registry-locality.test.ts.
describe('P8 — whole-note grounding is gated on answer-model locality (fail closed)', () => {
  const src = readFileSync(join(__dirname, '..', 'local-brain', 'server.ts'), 'utf-8')

  it('the whole-note RUNNING branch requires wholeNoteEgressAllowed(modelId) (so cloud answer models are blocked)', () => {
    expect(src).toMatch(
      /if\s*\(\s*!contextOverride\s*&&\s*query\s*&&\s*wholeNoteWanted\s*&&\s*wholeNoteEgressAllowed\(modelId\)\s*\)/
    )
    // The adaptive-breadth refactor must not become a way around the flag.
    expect(src).toMatch(/const\s+wholeNoteWanted\s*=\s*wholeNoteGroundEnabled\(\)\s*&&/)
  })

  it('a flag-on-but-BLOCKED case is detected and skip-logged (does NOT run whole-note)', () => {
    // The mutually-exclusive skip check: flag on AND egress NOT allowed → warn, no whole-note body.
    expect(src).toMatch(
      /if\s*\(\s*!contextOverride\s*&&\s*query\s*&&\s*wholeNoteWanted\s*&&\s*!wholeNoteEgressAllowed\(modelId\)\s*\)/
    )
    expect(src).toContain('warnWholeNoteEgressBlockedOnce(modelId)')
  })

  it('the skip is logged with a clear once-only message pointing at the escape hatch', () => {
    // warns ONCE per process (a per-turn log would spam every message)
    expect(src).toMatch(/let\s+wholeNoteEgressBlockWarned\s*=\s*false/)
    expect(src).toMatch(/whole-note skipped: answer model .*is cloud; full-note egress blocked/)
    expect(src).toContain("set DUIN_WHOLENOTE_ALLOW_CLOUD=1 to allow")
  })

  it('`modelId` (the already-resolved answer model) is reused — the guard adds NO second resolution', () => {
    // The guard passes the pre-resolved `modelId` variable to wholeNoteEgressAllowed (a pure read),
    // not a fresh resolution. Since the P0 model plane the turn resolves the chat ROLE once
    // (resolveAnswerEngine → RoleResolution, whose modelId is the engine and whose chain the
    // failover walk reads), so that name appears exactly twice in the file: its definition and the
    // SINGLE per-turn call. A second call would mean re-resolution / possible reorder (health can
    // change between two reads) — this catches that regression.
    const occurrences = (src.match(/resolveAnswerEngine\(/g) || []).length
    expect(occurrences).toBe(2) // 1 definition + 1 call site
    expect(src).toContain('const engine = resolveAnswerEngine(requestedModel)')
    expect(src).toContain('const modelId = engine?.modelId ?? null')
    expect(src).not.toContain('resolveAnswerModel(')
  })

  it('the agentic snippet retriever remains the safe fallback AFTER the whole-note guard (minimal egress)', () => {
    // Compare DISPATCH-site positions (the guarded branch conditions), not the earlier fn definitions.
    const wholeIdx = src.indexOf('wholeNoteWanted && wholeNoteEgressAllowed(modelId)')
    const agenticIdx = src.indexOf('!contextOverride && query && agenticRetrieverEnabled()')
    expect(wholeIdx).toBeGreaterThan(-1)
    expect(agenticIdx).toBeGreaterThan(-1)
    expect(agenticIdx).toBeGreaterThan(wholeIdx) // agentic path is after → reachable when whole-note is skipped
  })
})
