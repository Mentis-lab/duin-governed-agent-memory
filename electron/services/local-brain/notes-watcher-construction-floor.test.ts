// The construction FLOOR — the clock that was missing.
//
// Construction had exactly one producer: `scheduleReindex`'s tail, fired by a chokidar
// vault-file event. A vault nobody edits therefore stalls it forever. Measured on the
// live brain 2026-07-30: the cache was 10 days old while the extractor was perfectly
// healthy, which simultaneously froze Brain Health (it only runs after a construction
// rebuild) and pinned the graph's `entity`-kind share at 63%, because typed kinds are
// produced here and nowhere else.
//
// These tests pin the floor as a FLOOR and not a scheduler: stale rebuilds, fresh does
// not, and every disable path is honored. `scheduleConstructionRefresh` is observed
// through the line it logs, because it is module-private to the unit under test.
//
// 2026-08-25: the floor now ASKS background-work-gate first. Staleness alone is no longer a
// reason to spend — the operator rule is that automatic token-spending work runs only while
// the app is in use AND knowledge is actually moving. So each "it rebuilds" case establishes
// those two conditions, and a new case pins that an idle machine is left alone.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'


const builtAtMs = vi.fn<() => number | null>(() => null)

vi.mock('../brain/construct', () => ({ constructionBuiltAtMs: () => builtAtMs() }))
// Release M11: the floor also asks brain/cloud-consent. The rebuild cases below run CONSENTED;
// the dedicated case at the bottom withdraws consent and pins that the floor spends nothing.
const consent = vi.fn((): { ok: boolean; reason?: string; detail?: string } => ({ ok: true }))
vi.mock('../brain/cloud-consent', () => ({ automaticCloudWorkAllowed: () => consent() }))
vi.mock('../brain', () => ({
  buildBrain: vi.fn(async () => ({ entities: 0, edges: 0, status: 'noop' })),
  refreshNotesExtraction: vi.fn(async () => false)
}))
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))

const HOUR = 3_600_000
/** The floor's first check is deliberately deferred so it never races boot work. */
const SETTLE_MS = 3 * 60_000

/** Fresh module + fresh timers per test — the floor holds module-level timer state. */
async function loadFloor(env: Record<string, string | undefined> = {}) {
  const prior: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(env)) {
    prior[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  vi.resetModules()
  const mod = await import('./notes-watcher')
  // The gate must come from the SAME freshly-reset module graph the watcher just imported —
  // a top-level import would seed a different instance and the gate would still read "away".
  const gate = await import('../background-work-gate')
  gate.__resetBackgroundGate()
  /** The two conditions the gate requires, as a real working session would leave them. */
  const operatorIsWorking = (): void => {
    gate.notePresence()
    gate.noteMaterialChange({ path: 'notes/real.md', kind: 'created' })
  }
  return { mod, operatorIsWorking, restore: () => {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  } }
}

describe('construction floor', () => {
  let logs: string[]
  let restore: (() => void) | null = null

  beforeEach(() => {
    logs = []
    consent.mockReturnValue({ ok: true })
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')) })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    restore?.()
    restore = null
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  const scheduled = (l: string[]): boolean => l.some((s) => s.includes('construction refresh scheduled'))

  it('leaves a stale vault alone on a cloud model WITHOUT consent (release M11) — even with the operator present', async () => {
    builtAtMs.mockReturnValue(Date.now() - 25 * HOUR)
    consent.mockReturnValue({ ok: false, reason: 'no-cloud-consent', detail: 'no key saved after the disclosure' })
    const { mod, operatorIsWorking, restore: r } = await loadFloor({ DUIN_CONSTRUCTION_FLOOR_HOURS: '24' })
    restore = r
    operatorIsWorking()
    mod.startConstructionFloor(() => 'D:/vault')
    vi.advanceTimersByTime(SETTLE_MS)
    expect(scheduled(logs)).toBe(false)
    expect(logs.some((s) => s.includes('no-cloud-consent'))).toBe(true)
    mod.stopConstructionFloor()
  })

  it('forces a rebuild when construction is older than the floor', async () => {
    builtAtMs.mockReturnValue(Date.now() - 25 * HOUR)
    const { mod, operatorIsWorking, restore: r } = await loadFloor({ DUIN_CONSTRUCTION_FLOOR_HOURS: '24' })
    restore = r
    operatorIsWorking()
    mod.startConstructionFloor(() => 'D:/vault')
    vi.advanceTimersByTime(SETTLE_MS)
    expect(scheduled(logs)).toBe(true)
    expect(logs.some((s) => s.includes('25h') && s.includes('floor 24h'))).toBe(true)
    mod.stopConstructionFloor()
  })

  it('leaves a fresh construction alone — a rebuild costs real LLM calls', async () => {
    builtAtMs.mockReturnValue(Date.now() - 1 * HOUR)
    const { mod, operatorIsWorking, restore: r } = await loadFloor({ DUIN_CONSTRUCTION_FLOOR_HOURS: '24' })
    restore = r
    mod.startConstructionFloor(() => 'D:/vault')
    vi.advanceTimersByTime(SETTLE_MS)
    expect(scheduled(logs)).toBe(false)
    mod.stopConstructionFloor()
  })

  it('treats "never built" as maximally stale rather than as fresh', async () => {
    builtAtMs.mockReturnValue(null)
    const { mod, operatorIsWorking, restore: r } = await loadFloor({ DUIN_CONSTRUCTION_FLOOR_HOURS: '24' })
    restore = r
    operatorIsWorking()
    mod.startConstructionFloor(() => 'D:/vault')
    vi.advanceTimersByTime(SETTLE_MS)
    expect(scheduled(logs)).toBe(true)
    expect(logs.some((s) => s.includes('never built'))).toBe(true)
    mod.stopConstructionFloor()
  })

  it('does nothing without a notes dir — there is no vault to construct from', async () => {
    builtAtMs.mockReturnValue(null)
    const { mod, operatorIsWorking, restore: r } = await loadFloor({ DUIN_CONSTRUCTION_FLOOR_HOURS: '24' })
    restore = r
    mod.startConstructionFloor(() => null)
    vi.advanceTimersByTime(SETTLE_MS)
    expect(scheduled(logs)).toBe(false)
    mod.stopConstructionFloor()
  })

  it('arms no timer at all when DUIN_CONSTRUCTION_FLOOR_HOURS=0', async () => {
    builtAtMs.mockReturnValue(Date.now() - 999 * HOUR)
    const { mod, operatorIsWorking, restore: r } = await loadFloor({ DUIN_CONSTRUCTION_FLOOR_HOURS: '0' })
    restore = r
    mod.startConstructionFloor(() => 'D:/vault')
    vi.advanceTimersByTime(48 * HOUR)
    expect(scheduled(logs)).toBe(false)
  })

  // The defect this pins was live, not hypothetical. `constructBrain` has three clobber
  // guards that decline to persist and return `{entities: 0, status: 'built'}` — the same
  // shape as a real build — so a construction that keeps refusing to overwrite a good
  // cache never advances `builtAt`. A floor gated on age alone therefore re-fires a
  // full-vault LLM pass every 6h check, forever. Measured 2026-07-30: a forced rebuild
  // against a 247h-old cache returned exactly that and left the cache at its 07-20 mtime.
  it('does NOT rebuild a stale vault while the operator is away — staleness is not a reason to spend', async () => {
    // The exact case that made this gate necessary: an idle machine, a stale cache, and a
    // wall clock happily buying LLM passes nobody asked for.
    builtAtMs.mockReturnValue(Date.now() - 999 * HOUR)
    const { mod, operatorIsWorking, restore: r } = await loadFloor({ DUIN_CONSTRUCTION_FLOOR_HOURS: '24' })
    restore = r
    // deliberately NOT operatorIsWorking()
    mod.startConstructionFloor(() => 'D:/vault')
    vi.advanceTimersByTime(SETTLE_MS)
    expect(scheduled(logs)).toBe(false)
    expect(logs.some((s) => s.includes('operator-away'))).toBe(true)
    mod.stopConstructionFloor()
  })

  it('attempts at most once per floor period when builtAt never advances', async () => {
    const frozen = Date.now() - 247 * HOUR // never moves — construction keeps no-op'ing
    builtAtMs.mockReturnValue(frozen)
    const { mod, operatorIsWorking, restore: r } = await loadFloor({ DUIN_CONSTRUCTION_FLOOR_HOURS: '24' })
    restore = r
    operatorIsWorking()
    mod.startConstructionFloor(() => 'D:/vault')

    vi.advanceTimersByTime(SETTLE_MS)
    expect(logs.filter((s) => s.includes('forcing a rebuild'))).toHaveLength(1)

    // Many more checks inside the same 24h floor period — still exactly one attempt.
    vi.advanceTimersByTime(18 * HOUR)
    expect(logs.filter((s) => s.includes('forcing a rebuild'))).toHaveLength(1)

    // Clear the 24h floor period. Still no second attempt: the operator has been away the whole
    // time, and staleness alone is not a reason to spend.
    vi.advanceTimersByTime(6 * HOUR)
    expect(logs.filter((s) => s.includes('forcing a rebuild'))).toHaveLength(1)

    // They come back — NOW the floor is allowed to try again.
    operatorIsWorking()
    vi.advanceTimersByTime(30 * 60_000) // the next check lands inside the presence window
    expect(logs.filter((s) => s.includes('forcing a rebuild'))).toHaveLength(2)
    mod.stopConstructionFloor()
  })

  it('stops cleanly, so a shutdown cannot leave the interval running', async () => {
    builtAtMs.mockReturnValue(Date.now() - 25 * HOUR)
    const { mod, operatorIsWorking, restore: r } = await loadFloor({ DUIN_CONSTRUCTION_FLOOR_HOURS: '24' })
    restore = r
    operatorIsWorking()
    mod.startConstructionFloor(() => 'D:/vault')
    mod.stopConstructionFloor()
    vi.advanceTimersByTime(48 * HOUR)
    expect(scheduled(logs)).toBe(false)
  })
})
