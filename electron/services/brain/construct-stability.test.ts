// P3 construction-STABILITY — orchestration tests for constructBrain's clobber guard + per-batch
// retry. constructBrain is normally not unit-tested (it needs a callable model), so here the two
// key seams are mocked: providers/registry (routeModel + chatStream) and local-brain/index-store
// (allChunks + isReindexing). Everything else (batch loop, merge, guards, persist, getConstruction)
// runs for real against a temp `.brain/state/` cache, so these assert the ACTUAL cache-write policy.
//
// The vault has 41 notes → 2 batches (batch0 = note-0..note-39, batch1 = note-40), so a run can have
// ONE batch succeed and ONE fail (the degraded signal the clobber guard keys on). The mock routes by
// the `### note-40` heading that only batch1's prompt carries.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { createHash } from 'crypto'

// ── hoisted mock fns (vi.mock factories run before module init) ──
const h = vi.hoisted(() => ({
  chatStream: vi.fn(),
  routeModel: vi.fn(() => 'glm-4-flash'),
  allChunks: vi.fn(() => [] as { file: string; text: string }[]),
  isReindexing: vi.fn(() => false)
}))

vi.mock('../providers/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../providers/registry')>()
  return { ...actual, routeModel: h.routeModel, chatStream: h.chatStream }
})
vi.mock('../local-brain/index-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../local-brain/index-store')>()
  return { ...actual, allChunks: h.allChunks, isReindexing: h.isReindexing }
})

import { constructBrain, setConstructPaths, getConstruction, __resetConstructionForTest } from './construct'
import type { ConstructedData } from './types'

// ── helpers ──
function dirKeyFor(dir: string): string {
  return createHash('sha1').update(dir).digest('hex').slice(0, 16)
}
/** The path constructBrain writes/reads (brain-root state wins over legacy). */
function cacheFile(vault: string): string {
  return join(vault, '.brain', 'state', 'brain-construction.json')
}
function seedPrior(vault: string, n: number): void {
  const data: ConstructedData = {
    entities: Array.from({ length: n }, (_, k) => ({
      id: `person:prior-${k}`,
      kind: 'person' as const,
      label: `Prior ${k}`,
      note: 'note-0'
    })),
    edges: [],
    classifications: []
  }
  const p = cacheFile(vault)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify({ key: dirKeyFor(vault), builtAt: new Date().toISOString(), data }), 'utf-8')
}
function readCacheEntityCount(vault: string): number | null {
  try {
    const raw = JSON.parse(readFileSync(cacheFile(vault), 'utf-8')) as { data: ConstructedData }
    return raw.data.entities.length
  } catch {
    return null
  }
}
/** The persisted coverage cursor — where the NEXT run starts. */
function readCursor(vault: string): number | undefined {
  try {
    return (JSON.parse(readFileSync(cacheFile(vault), 'utf-8')) as { nextBatch?: number }).nextBatch
  } catch {
    return undefined
  }
}
/** A construction JSON body carrying `ids` as entities. */
function okJson(ids: string[]): string {
  return JSON.stringify({
    // Label derived from the ID, not the index. It used to be `L${k}`, which made entity 0 of
    // one run and entity 0 of another share the label `L0` — harmless while cross-batch dedup
    // keyed on `id`, but a synthetic collision now that it keys on kind+label. Distinct real
    // entities have distinct labels; only this fixture's index numbering made them clash, and
    // these tests are about UNION-by-entity, not about label collision.
    entities: ids.map((id) => ({ id, kind: 'person', label: `L-${id}`, note: 'note-0' })),
    edges: [],
    classifications: []
  })
}

type Outcome = { kind: 'ok'; ids: string[] } | { kind: 'error' } | { kind: 'truncated' }
// Per-test router: (which batch, which attempt) → outcome. Set in each test.
let respond: (batch: 'b0' | 'b1', attempt: number) => Outcome
const attempts = new Map<string, number>()

describe('constructBrain — P3 construction stability (clobber guard + per-batch retry)', () => {
  let vault: string
  const ENV_KEYS = [
    'DUIN_BRAIN_HEALTH_MONITOR',
    'DUIN_CONSTRUCT_SYNONYMS',
    'DUIN_CONSTRUCT_BATCH_BACKOFF_MS',
    'DUIN_CONSTRUCT_BATCH_ATTEMPTS',
    'DUIN_CONSTRUCT_SPLIT_CALLS',
    'DUIN_CONSTRUCT_DEADLINE_MS',
    'DUIN_CONSTRUCT_CONCURRENCY'
  ] as const
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k]
    // Silence the fire-and-forget health monitor + skip the embedder-dependent synonym pass, and
    // make retries instant. These are the runtime-read tunables the source honors.
    process.env.DUIN_BRAIN_HEALTH_MONITOR = '0'
    process.env.DUIN_CONSTRUCT_SYNONYMS = '0'
    process.env.DUIN_CONSTRUCT_BATCH_BACKOFF_MS = '0'
    process.env.DUIN_CONSTRUCT_BATCH_ATTEMPTS = '1' // no retry by default; the retry test overrides

    vi.clearAllMocks()
    attempts.clear()
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    vault = mkdtempSync(join(tmpdir(), 'construct-stab-'))
    __resetConstructionForTest()
    setConstructPaths(vault, () => vault)

    // 41 notes → 2 batches. Only batch1's prompt contains the `### note-40` heading.
    h.allChunks.mockReturnValue(
      Array.from({ length: 41 }, (_, k) => ({ file: `note-${k}`, text: `Body of note ${k}.` }))
    )
    h.isReindexing.mockReturnValue(false)
    h.routeModel.mockReturnValue('glm-4-flash')

    // chatStream mock drives onChunk/onDone/onError exactly like the real stream terminal.
    h.chatStream.mockImplementation(
      async (messages: { content: string }[], _model, _tools, callbacks: {
        onChunk: (c: string) => void
        onDone: (f: string, t: unknown, r: unknown, c: { finishReason: string | null }) => void
        onError: (e: string) => void
      }) => {
        const content = String(messages[0].content)
        const batch: 'b0' | 'b1' = content.includes('### note-40') ? 'b1' : 'b0'
        const n = (attempts.get(batch) ?? 0) + 1
        attempts.set(batch, n)
        const o = respond(batch, n)
        if (o.kind === 'error') {
          callbacks.onError('simulated stream error')
          return
        }
        const json = o.kind === 'ok' ? okJson(o.ids) : okJson(['person:truncated'])
        callbacks.onChunk(json)
        callbacks.onDone(json, undefined, undefined, { finishReason: o.kind === 'truncated' ? 'length' : 'stop' })
      }
    )
  })

  afterEach(() => {
    __resetConstructionForTest()
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    vi.restoreAllMocks()
    try {
      rmSync(vault, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  })

  // (a) a DEGRADED run must not lose the richer prior — but the MECHANISM is the union, not a refusal.
  //
  // This test used to assert `kept-cache`: the degraded-clobber guard refused to persist whenever a
  // run had dropped batches AND produced under 80% of the cached entity count. That test compares a
  // PARTIAL yield against a COMPLETE prior, which no partial run can pass, and it is what froze the
  // live graph at its 2026-07-20 build through three separate runs on 2026-07-30/31.
  //
  // The guard is gone. `convergeConstruction` retains every prior entity whose source note still
  // exists, so the property the guard existed to protect holds by construction — and the run's own
  // finding is no longer thrown away with it.
  it('degraded run (a batch failed) keeps the richer prior AND contributes its own finding', async () => {
    seedPrior(vault, 5)
    // batch0 succeeds with a single entity; batch1 fails outright (dropped) → okBatches 1/2.
    respond = (batch) => (batch === 'b0' ? { kind: 'ok', ids: ['person:new-0'] } : { kind: 'error' })

    const res = await constructBrain()

    expect(res!.status).toBe('built')
    expect(res!.entities).toBe(6) // 5 prior retained by the union + 1 found this run
    expect(readCacheEntityCount(vault)).toBe(6)
    expect(getConstruction()?.entities).toHaveLength(6)
  })

  // (b) CONVERGENCE: a clean run UNIONS into the prior — new entities are added, and prior entities the
  // run flakily missed (note still live) are RETAINED, so the graph never re-rolls to the run's raw
  // count. This is the anti-churn fix (the live 44↔260 bounce came from clean runs REPLACING the cache).
  it('clean run CONVERGES: new entities union in; flakily-missed prior entities are retained (anti-churn)', async () => {
    seedPrior(vault, 5) // person:prior-0..4, all on the live note-0
    // Clean run extracts 2 DIFFERENT entities — it did NOT re-find the 5 prior (flaky omission), but
    // their note (note-0) still lives, so they must survive. Union = 7, NOT a replace-to-2.
    respond = (batch) => ({ kind: 'ok', ids: batch === 'b0' ? ['person:new-0'] : ['person:new-1'] })

    const res = await constructBrain()
    if (!res) throw new Error('expected a ConstructResult, got null')

    expect(res.status).toBe('built')
    expect(res.entities).toBe(7) // 5 retained + 2 new — the graph GAINED, never re-rolled to 2
    expect(readCacheEntityCount(vault)).toBe(7)
    const ids = getConstruction()!.entities.map((e) => e.id)
    expect(ids).toContain('person:new-0') // the run's entities land
    expect(ids).toContain('person:prior-0') // a flakily-missed prior entity survived (anti-churn)
  })

  // (b2) The REAL anti-deadlock property under convergence: a genuine DELETION still propagates. An
  // entity whose source note is gone from the vault is PRUNED — convergence is not a one-way ratchet.
  it('convergence PRUNES a prior entity whose source note was deleted (no deadlock — deletions propagate)', async () => {
    const p = cacheFile(vault)
    mkdirSync(dirname(p), { recursive: true })
    const data: ConstructedData = {
      entities: [
        { id: 'person:stale', kind: 'person', label: 'Stale', note: 'deleted-note' }, // note not in note-0..40
        { id: 'person:live', kind: 'person', label: 'Live', note: 'note-0' }
      ],
      edges: [],
      classifications: []
    }
    writeFileSync(p, JSON.stringify({ key: dirKeyFor(vault), builtAt: new Date().toISOString(), data }), 'utf-8')

    // Clean run re-finds neither prior entity. note-0 lives (person:live retained); 'deleted-note' is
    // gone from the vault, so person:stale is pruned.
    respond = (batch) => ({ kind: 'ok', ids: batch === 'b0' ? ['person:fresh'] : ['person:fresh-1'] })
    const res = await constructBrain()
    if (!res) throw new Error('expected a ConstructResult, got null')

    const ids = getConstruction()!.entities.map((e) => e.id)
    expect(ids).toContain('person:live') // note still live → retained
    expect(ids).not.toContain('person:stale') // note deleted → pruned (convergence isn't a ratchet)
    expect(ids).toContain('person:fresh') // the run's own entities
  })

  // (c) the pre-existing 0-entity guard still holds (a productive but empty run keeps the prior).
  it('an all-ok-but-EMPTY run does not clobber a good prior (0-entity guard intact)', async () => {
    seedPrior(vault, 5)
    respond = () => ({ kind: 'ok', ids: [] }) // both batches ok, zero entities

    const res = await constructBrain()

    expect(res).toEqual({ entities: 0, edges: 0, status: 'kept-cache' })
    expect(readCacheEntityCount(vault)).toBe(5) // preserved
  })

  // The distinction the status now carries: a genuinely empty vault with NO prior really does
  // build (and persists []), where a guarded no-op does not. Both used to report 'built', which
  // is what made a protected no-op unreadable — and surfaced to the user as a success toast
  // reading "Built 0 entities, 0 links".
  it("distinguishes a real empty build from a guarded no-op", async () => {
    h.allChunks.mockReturnValue([]) // empty vault, index settled, no prior construction
    respond = () => ({ kind: 'ok', ids: [] })

    const res = await constructBrain()

    expect(res).toEqual({ entities: 0, edges: 0, status: 'built' }) // wrote [] to reflect reality
    expect(readCacheEntityCount(vault)).toBe(0) // persisted, not skipped
  })

  // (e) per-batch retry: a batch that fails once is retried and RECOVERS (not a dropped batch).
  it('retries a transiently-dropped batch and persists the recovered result', async () => {
    process.env.DUIN_CONSTRUCT_BATCH_ATTEMPTS = '2' // allow one retry
    // no prior — first-ever build. batch0 ok first try; batch1 errors on attempt 1, succeeds on 2.
    respond = (batch, attempt) => {
      if (batch === 'b0') return { kind: 'ok', ids: ['person:new-0'] }
      return attempt === 1 ? { kind: 'error' } : { kind: 'ok', ids: ['person:new-1'] }
    }

    const res = await constructBrain()
    if (!res) throw new Error('expected a ConstructResult, got null')

    expect(res.status).toBe('built')
    expect(res.entities).toBe(2) // both batches contributed — the retry recovered batch1
    expect(readCacheEntityCount(vault)).toBe(2)
    // batch1 was attempted twice (fail → retry → success); batch0 once.
    expect(attempts.get('b1')).toBe(2)
    expect(attempts.get('b0')).toBe(1)
  })

  // A degraded run CONTRIBUTES rather than being discarded, and a later clean run still converges.
  // The old assertion here was `toBe(5)` — the degraded run refused, its one real finding thrown
  // away with the batch that failed. Accumulating instead is the whole point: with a wall-clock
  // deadline that cuts most runs short, discarding every partial run means never converging at all.
  it('a degraded run contributes, and a later clean run converges the cache', async () => {
    seedPrior(vault, 5)
    // Degraded: batch0 ok (1 entity), batch1 truncated (dropped).
    respond = (batch) => (batch === 'b0' ? { kind: 'ok', ids: ['person:new-0'] } : { kind: 'truncated' })
    await constructBrain()
    expect(readCacheEntityCount(vault)).toBe(6) // 5 prior + the 1 the good batch found

    // Later CLEAN run: its new entities union into the retained prior (5 + 2 = 7) — never blocked.
    attempts.clear()
    respond = (batch) => ({ kind: 'ok', ids: batch === 'b0' ? ['person:new-0'] : ['person:new-1'] })
    const res2 = await constructBrain()
    if (!res2) throw new Error('expected a ConstructResult, got null')
    expect(res2.entities).toBe(7) // converged: 5 prior + 2 new — the clean run always contributes
    expect(readCacheEntityCount(vault)).toBe(7)
  })

  // ── truncation is a SIZE problem, so the answer is size, not repetition ──
  //
  // The batch loop used to re-send a truncated batch verbatim. temperature is 0 and the prompt,
  // model and token budget are identical across attempts, so that could only truncate again: it
  // burned the whole retry allowance at ~8k output tokens per attempt and dropped the batch
  // anyway. Live evidence 2026-07-30: 3 of 4 observed streams finished `length`, every batch was
  // ultimately dropped, and construction had produced nothing for ten days while looking healthy.

  /** The note ids the model was shown, per call, in call order. */
  function promptsSeen(): string[][] {
    return h.chatStream.mock.calls.map((c) => {
      const content = String((c[0] as { content: string }[])[0].content)
      return Array.from(content.matchAll(/^### (note-\d+)$/gm), (m) => m[1])
    })
  }
  /** Truncate every prompt carrying at least `minNotes` notes; complete anything smaller. */
  function truncateAtOrAbove(minNotes: number): void {
    h.chatStream.mockImplementation(
      async (messages: { content: string }[], _model, _tools, cb: {
        onChunk: (c: string) => void
        onDone: (f: string, t: unknown, r: unknown, c: { finishReason: string | null }) => void
      }) => {
        const ids = Array.from(String(messages[0].content).matchAll(/^### (note-\d+)$/gm), (m) => m[1])
        const truncated = ids.length >= minNotes
        const json = truncated ? okJson(['person:truncated']) : okJson(ids.map((id) => `person:from-${id}`))
        cb.onChunk(json)
        cb.onDone(json, undefined, undefined, { finishReason: truncated ? 'length' : 'stop' })
      }
    )
  }

  // A batch the wall-clock cap never STARTED is not a batch that failed. Counting it as one made
  // every slow vault look broken: measured live 2026-07-30, 27 of 31 batches were deadline-skipped
  // and 1 truncated, the run was refused as "degraded", and the graph stayed frozen at its 07-20
  // build for ten days. The write is a UNION into the prior (deletions computed against the FULL
  // live note set), so a partial run can only ever ADD — there is nothing for the guard to protect.
  it('persists a run whose only dropped batches ran out of WALL CLOCK, not out of quality', async () => {
    seedPrior(vault, 50)
    // Serialize the workers and make the FIRST batch outlive the deadline, so batch1 is never
    // started — `deadline_skipped`, the live 27-of-31 case. (With the default concurrency both
    // batches start in the same millisecond and nothing is ever skipped, which is what made an
    // earlier version of this test pass against the bug.)
    process.env.DUIN_CONSTRUCT_CONCURRENCY = '1'
    process.env.DUIN_CONSTRUCT_DEADLINE_MS = '1'
    h.chatStream.mockImplementation(
      async (_messages: unknown, _model, _tools, cb: {
        onChunk: (c: string) => void
        onDone: (f: string, t: unknown, r: unknown, c: { finishReason: string | null }) => void
      }) => {
        await new Promise((r) => setTimeout(r, 10)) // push past the 1ms deadline
        const json = okJson(['person:new-0'])
        cb.onChunk(json)
        cb.onDone(json, undefined, undefined, { finishReason: 'stop' })
      }
    )

    const res = await constructBrain()
    if (!res) throw new Error('expected a ConstructResult, got null')

    // Exactly one batch ran; the other was skipped on time, not quality.
    expect(h.chatStream.mock.calls.length).toBe(1)
    // Union, not replace: the 50 prior entities survive and the run's finding is added on top.
    expect(res.status).toBe('built')
    expect(res.entities).toBe(51)
    expect(readCacheEntityCount(vault)).toBe(51)
  })

  // The degraded-clobber guard is GONE. It refused to persist when a run had dropped batches and
  // produced fewer than 80% of the cached entity count — a test no PARTIAL run can pass, because
  // it compares a partial yield against a COMPLETE prior. Three live runs on 2026-07-30/31 were
  // refused that way (27/31, 27/31, 19/31 batches skipped on the wall clock), each leaving the
  // graph frozen at its 2026-07-20 build.
  //
  // Nothing is lost by removing it: `convergeConstruction` is a UNION that retains every prior
  // entity whose source note still exists, so a degraded run can only ADD. The collapse the guard
  // was written for was only reachable under the REPLACE semantics convergence replaced.
  // A prior we cannot READ is still a prior. getConstruction() returns null for "no cache" AND for
  // "cache present but corrupt/locked", so an unreadable-but-good cache read as zero prior entities,
  // the clobber guard declined to fire, and a 0-entity run persisted over it — the exact outcome
  // that guard exists to prevent, reached through the signal it consults.
  it('refuses to overwrite a cache that exists but cannot be parsed', () => {
    seedPrior(vault, 40)
    writeFileSync(cacheFile(vault), '{"key":"' + dirKeyFor(vault) + '","builtAt":"x","data":{oops', 'utf-8')
    respond = () => ({ kind: 'ok', ids: [] }) // a run that finds nothing

    return constructBrain().then((res) => {
      expect(res!.status).toBe('kept-cache') // NOT 'built' over the top of it
      // the corrupt bytes are left exactly as they were, for a human to look at
      expect(readFileSync(cacheFile(vault), 'utf-8')).toContain('{oops')
    })
  })

  it('an entity whose source note was DELETED is still pruned — convergence is not a ratchet', async () => {
    seedPrior(vault, 3) // prior entities all cite note-0
    h.allChunks.mockReturnValue([{ file: 'note-99', text: 'Only this note survives.' }])
    respond = () => ({ kind: 'ok', ids: ['person:kept'] })

    const res = await constructBrain()

    // note-0 is gone from the vault, so its 3 prior entities go with it. Only the new one remains.
    expect(res!.entities).toBe(1)
  })

  // Batch order is identical on every run, so a deadline-truncated run used to re-extract the SAME
  // leading batches forever and never reach the tail of the vault — 11 of 31 completed on
  // 2026-07-31, and they would have been the same 11 every time.
  it('resumes coverage where the last run stopped, instead of re-extracting the same head', async () => {
    process.env.DUIN_CONSTRUCT_CONCURRENCY = '1'
    process.env.DUIN_CONSTRUCT_DEADLINE_MS = '1'
    let seen: string[][] = []
    h.chatStream.mockImplementation(
      async (messages: { content: string }[], _model, _tools, cb: {
        onChunk: (c: string) => void
        onDone: (f: string, t: unknown, r: unknown, c: { finishReason: string | null }) => void
      }) => {
        const ids = Array.from(String(messages[0].content).matchAll(/^### (note-\d+)$/gm), (m) => m[1])
        seen.push(ids)
        await new Promise((r) => setTimeout(r, 10)) // outlive the deadline → only one batch per run
        const json = okJson(ids.map((id) => `person:from-${id}`))
        cb.onChunk(json)
        cb.onDone(json, undefined, undefined, { finishReason: 'stop' })
      }
    )

    await constructBrain()
    const firstRun = seen[0]
    expect(firstRun).toContain('note-0') // run 1 starts at the head

    // Run 2 must pick up the OTHER batch (note-40), not repeat the head.
    seen = []
    __resetConstructionForTest()
    setConstructPaths(vault, () => vault)
    await constructBrain()

    expect(seen[0]).toEqual(['note-40'])
  })

  // The cursor must record how far the run TRAVELLED, not how many batches SUCCEEDED. It advanced
  // by `okBatches`, so any batch consumed-and-failed left the cursor short: the failure sat BEHIND
  // the cursor while the batch it landed on had already been extracted. Every subsequent run then
  // re-spent a full LLM budget re-covering ground — an attenuated form of the exact "never reaches
  // the tail" stall the cursor was added to end.
  it('advances past a batch it CONSUMED AND FAILED, not just the ones that succeeded', async () => {
    // 81 notes → 3 batches. b0 fails outright; b1 and b2 succeed. All three are consumed.
    h.allChunks.mockReturnValue(
      Array.from({ length: 81 }, (_, k) => ({ file: `note-${k}`, text: `Body ${k}.` }))
    )
    h.chatStream.mockImplementation(
      async (messages: { content: string }[], _m, _t, cb: {
        onChunk: (c: string) => void
        onDone: (f: string, t: unknown, r: unknown, c: { finishReason: string | null }) => void
        onError: (e: string) => void
      }) => {
        const first = String(messages[0].content).includes('### note-0\n')
        if (first) return cb.onError('simulated stream error') // b0 consumed, fails
        const json = okJson(['person:ok'])
        cb.onChunk(json)
        cb.onDone(json, undefined, undefined, { finishReason: 'stop' })
      }
    )

    await constructBrain()

    // Travelled all 3 → (0 + 2 + 1) % 3 === 0, a completed lap. Counting successes gave 2, which
    // would restart mid-vault on a slice already covered.
    expect(readCursor(vault)).toBe(0)
  })

  // The cursor and the cache answer different questions. Returning from the 0-entity guard without
  // advancing pinned every future run to the same leading slice: a run over low-signal notes (logs,
  // link lists, stubs) burned its whole budget, learned nothing, refused to persist, and the next
  // run repeated it. Indefinitely. That is the original stall, reintroduced one guard higher up.
  it('advances the cursor even when the run yields nothing to persist', async () => {
    seedPrior(vault, 5) // something to protect → the 0-entity guard fires
    h.allChunks.mockReturnValue(
      Array.from({ length: 81 }, (_, k) => ({ file: `note-${k}`, text: `Body ${k}.` }))
    )
    process.env.DUIN_CONSTRUCT_CONCURRENCY = '1'
    process.env.DUIN_CONSTRUCT_DEADLINE_MS = '1' // only the first batch is consumed
    h.chatStream.mockImplementation(
      async (_messages: unknown, _m, _t, cb: {
        onChunk: (c: string) => void
        onDone: (f: string, t: unknown, r: unknown, c: { finishReason: string | null }) => void
      }) => {
        await new Promise((r) => setTimeout(r, 10)) // outlive the deadline
        const json = okJson([]) // completed cleanly, found nothing
        cb.onChunk(json)
        cb.onDone(json, undefined, undefined, { finishReason: 'stop' })
      }
    )

    const res = await constructBrain()

    expect(res!.status).toBe('kept-cache') // data correctly NOT written
    expect(readCacheEntityCount(vault)).toBe(5) // prior intact
    expect(readCursor(vault)).toBe(1) // …but the next run moves on to the following slice
  })

  it('splits a truncating batch instead of re-sending it, and keeps both halves', async () => {
    process.env.DUIN_CONSTRUCT_BATCH_ATTEMPTS = '3' // the old code would have burned all three here
    truncateAtOrAbove(40) // only the full 40-note batch0 overruns; 20 notes fit

    const res = await constructBrain()
    if (!res) throw new Error('expected a ConstructResult, got null')

    const seen = promptsSeen()
    // The defect, pinned: the identical 40-note request must be asked exactly ONCE.
    expect(seen.filter((ids) => ids.length >= 40)).toHaveLength(1)

    // It was halved, and the halves cover batch0 exactly — no note lost, none duplicated.
    const halves = seen.filter((ids) => ids.length === 20)
    expect(halves).toHaveLength(2)
    expect([...halves[0], ...halves[1]].sort()).toEqual(
      Array.from({ length: 40 }, (_, k) => `note-${k}`).sort()
    )

    // All 41 notes therefore contribute, and the build persists rather than being dropped.
    expect(res.entities).toBe(41)
    expect(readCacheEntityCount(vault)).toBe(41)
  })

  it('a half that still truncates is split again, and its sibling is not held back', async () => {
    truncateAtOrAbove(20) // 40 truncates, so do the 20-note halves; 10 fits

    const res = await constructBrain()
    if (!res) throw new Error('expected a ConstructResult, got null')

    const seen = promptsSeen()
    expect(seen.filter((ids) => ids.length >= 40)).toHaveLength(1)
    expect(seen.filter((ids) => ids.length === 20)).toHaveLength(2)
    expect(seen.filter((ids) => ids.length === 10)).toHaveLength(4) // both halves subdivided
    expect(res.entities).toBe(41)
  })

  // The guard on my own fix. Depth alone is the wrong bound: when truncation has nothing to do
  // with size, halving never converges, and an unbounded-by-calls recursion would fire 31
  // full-budget calls where the old blind retry fired 3 — trading a bug for a bigger bill.
  it('bounds the split by CALL BUDGET when halving never converges, and keeps the prior cache', async () => {
    seedPrior(vault, 5)
    process.env.DUIN_CONSTRUCT_SPLIT_CALLS = '4'
    truncateAtOrAbove(1) // nothing ever completes, at any size

    const res = await constructBrain()
    if (!res) throw new Error('expected a ConstructResult, got null')

    // Nothing survived → not persisted, and the good prior is untouched.
    expect(res.status).toBe('model-error')
    expect(readCacheEntityCount(vault)).toBe(5)

    // batch0: 1 full call + at most 4 split calls. batch1 is a single note, so it cannot be
    // split at all — 1 call. Bounded well under the 31 an unbudgeted depth-4 recursion would make.
    expect(h.chatStream.mock.calls.length).toBeLessThanOrEqual(6)
  })

  it('a single-note batch cannot be split, so it is dropped rather than re-sent', async () => {
    seedPrior(vault, 5)
    truncateAtOrAbove(1)
    process.env.DUIN_CONSTRUCT_SPLIT_CALLS = '8'

    await constructBrain()
    const seen = promptsSeen()
    // note-40 is batch1 and is alone: asked once, never repeated, never subdivided.
    expect(seen.filter((ids) => ids.length === 1 && ids[0] === 'note-40')).toHaveLength(1)
  })
})
