// server.ts — the failover walk and the bench header, asserted at the SOURCE level.
//
// handleAgui has no driveable harness under vitest (it needs the index store, grounding and a
// live SSE response; server-load.test.ts only proves the module graph evaluates). The walk's hop
// selection and exhaustion text are pure and unit-tested in providers/router.test.ts; what is left
// to lock here is the WIRING in server.ts — that every learning site is behind the bench flag,
// that the journal carries it, and that the round loop calls the helpers rather than a private
// re-implementation. Source-text locks are the pattern this repo uses for exactly this class
// (default-app-settings parity, extraction-default parity): a guard that names the line that
// must move with the code. Weaker than driving the turn; stronger than nothing, and honest.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const src = readFileSync(join(__dirname, 'server.ts'), 'utf-8')
const count = (needle: string): number => src.split(needle).length - 1

describe('bench header (D3) — an evaluation turn teaches nothing', () => {
  it('the decision is the contract helper, gated on the exec token', () => {
    expect(src).toContain('const bench = isBenchRequest(req.headers, execOk)')
    // decided BEFORE the journal opens (the TURN_START record carries it)
    expect(src.indexOf('const bench = isBenchRequest')).toBeLessThan(src.indexOf('openTurnJournal(rid'))
  })

  it('both learn sites (keyless answer + streamed answer) are skipped on a bench turn', () => {
    expect(src).toContain('if (bench || (modelId && resolveModel(modelId)?.hidden === true)) {')
    expect(src).toContain('if (bench || resolveModel(activeModel)?.hidden === true) {')
    // and learnFromTurn is called ONLY inside those two guarded blocks
    expect(count('void learnFromTurn(query')).toBe(2)
  })

  it('the turn-beat sites (grade at turn-open + store at both exits) and the govern debounce never fire on a bench turn', () => {
    expect(count('if (turnBeatsEnabled() && !bench) {')).toBe(3)
    expect(count('if (!bench) governTick()')).toBe(2)
    expect(count('turnBeatsEnabled()) {')).toBe(0) // no unguarded twin left behind
  })

  it('the journal says so: TURN_START and TURN_END both carry `bench`, so /debug/turns shows it', () => {
    expect(src).toContain("openTurnJournal(rid, { threadId: parsed.threadId ?? null, model: parsed.model ?? null, bench })")
    expect(src).toMatch(/const turnOutcome = \{[\s\S]*?\bbench,[\s\S]*?\n {2}\}/)
    expect(src).toContain('void journal.close({ aborted: turnAbort.signal.aborted, ...turnOutcome })')
  })
})

describe('failover walk — the chain is walked through the router helpers and reported per hop', () => {
  it('the chat role resolves through resolveRole with the request pin (AUTO_ENGINE = no pin)', () => {
    expect(src).toContain("const pin = requested && requested !== AUTO_ENGINE ? requested : (envRoutePin('chat') ?? undefined)")
    expect(src).toContain("return resolveRole('chat', { pin })")
    expect(src).not.toContain('resolveAnswerModel(')
  })

  it('every hop is classified once, chosen by nextFailoverHop, and recorded with recovered:true / false', () => {
    expect(src).toContain('const classified = classifyProviderError({ message: failoverErr }, failedProvider, PROVIDERS[failedProvider].label)')
    expect(src).toContain('const fallback = nextFailoverHop({')
    expect(src).toContain('chain: engine?.chain ?? []')
    expect(src).toContain('recovered: true, nextModelId: fallback')
    expect(src).toContain('recovered: false')
    expect(count('emitRoleFailure(')).toBe(2)
  })

  it('emits one STEP per hop and one RUN_ERROR with the exhaustion message when the chain is spent', () => {
    expect(src).toContain('label: `engine ${attemptModel} failed: ${classified.reason} → trying ${fallback}`')
    expect(src).toContain('const msg = exhaustionMessage(')
    expect(src).toContain("if (!turnAbort.signal.aborted) sseFrame(res, { type: 'RUN_ERROR', message: msg })")
  })

  it('TURN_END carries engine, engineChain and recovered', () => {
    expect(src).toContain('turnOutcome.engine = errored && !acc ? null : activeModel')
    expect(src).toContain('turnOutcome.engineChain = [...engineTried]')
    expect(src).toContain('turnOutcome.recovered = !errored && activeModel !== modelId')
  })

  it('a requested pin that lost to health is said in the engine STEP, from the health record', () => {
    expect(src).toContain('requested ${requestedModel} unavailable: ${describeUnavailable(requestedModel)}')
  })
})

describe('boot: provider health probes are scheduled off the boot path', () => {
  it('startLocalBrain schedules the staggered probes and never awaits them', () => {
    const start = src.indexOf('export async function startLocalBrain')
    const body = src.slice(start)
    expect(body).toContain('scheduleBootProbes()')
    expect(body).not.toContain('await scheduleBootProbes')
  })
})
