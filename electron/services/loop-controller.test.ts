import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  checkCeilings,
  computeNextFire,
  estimateTokens,
  buildIterationPrompt,
  runLoopIteration,
  MIN_INTERVAL_SECONDS,
  DEFAULT_INTERVAL_SECONDS,
  type LoopStoreSeam,
  type LoopIterationDeps
} from './loop-controller'
import { applyLoopCompleteTask, type LoopToolStore } from './loop-tool-logic'
import type { Loop, BacklogItem, LoopRun } from './loop-store'

// This suite exercises the DEFAULT (merit-autonomy OFF) iteration contract — the path the code
// documents as "byte-identical to pre-merit behaviour". DUIN_MERIT_AUTONOMY is an operator-armed
// enforcement flag; when it is set in the ambient shell (it is durably armed on some dev machines)
// meritAutonomyEnabled() flips true and EVERY iteration routes through the staging/hold path,
// breaking these default-path assertions (items land awaiting-ratification/in_progress instead of
// done). Neutralise it for the suite so the tests are hermetic to what the operator has armed.
// The flag-ON behaviour is covered separately by loop-controller-merit.test.ts / -staging.test.ts.
const OLD_MERIT_AUTONOMY = process.env.DUIN_MERIT_AUTONOMY
beforeAll(() => {
  delete process.env.DUIN_MERIT_AUTONOMY
})
afterAll(() => {
  if (OLD_MERIT_AUTONOMY === undefined) delete process.env.DUIN_MERIT_AUTONOMY
  else process.env.DUIN_MERIT_AUTONOMY = OLD_MERIT_AUTONOMY
})

// LP-3 — these tests inject a fake store + runTurn + clock, so the ceiling /
// stop-authority / backlog-drain logic runs WITHOUT a DB. No native binding,
// no skip — this is real coverage of the controller core.

function makeLoop(over: Partial<Loop> = {}): Loop {
  return {
    id: 'loop-1',
    conversationId: 'conv-1',
    mode: 'interval',
    status: 'running',
    instruction: 'Keep the build green',
    model: 'deepseek-chat',
    intervalSeconds: 300,
    maxIterations: null,
    maxWallclockMs: null,
    tokenBudget: null,
    iteration: 0,
    tokensUsed: 0,
    startedAt: 1000,
    lastIterationAt: null,
    nextFireAt: 0,
    stopReason: null,
    costSpent: 0,
    costBudgetUsd: null,
    stallCount: 0,
    lastStateHash: null,
    rollingSummary: null,
    artifactDir: null,
    lastGitSha: null,
    providerChain: null,
    currentProvider: null,
    lastDigestAt: null,
    goalId: null,
    goalConversationId: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...over
  }
}

function makeItem(over: Partial<BacklogItem> = {}): BacklogItem {
  return {
    id: 'b1',
    loopId: 'loop-1',
    position: 0,
    task: 'do a thing',
    status: 'pending',
    result: null,
    createdAt: 0,
    startedAt: null,
    finishedAt: null,
    ...over
  }
}

function makeFakeStore(loop: Loop, backlogItems: BacklogItem[]) {
  const loops = new Map<string, Loop>([[loop.id, { ...loop }]])
  let backlog = backlogItems.map((b) => ({ ...b }))
  const runs: LoopRun[] = []
  const seam: LoopStoreSeam = {
    getLoop: (id) => loops.get(id) ?? null,
    updateLoop: (id, patch) => {
      const cur = loops.get(id)
      if (!cur) return null
      const next = { ...cur, ...patch } as Loop
      loops.set(id, next)
      return next
    },
    nextBacklogItem: (loopId) =>
      backlog
        .filter((b) => b.loopId === loopId && b.status === 'pending')
        .sort((a, b) => a.position - b.position)[0] ?? null,
    updateBacklogItem: (id, patch) => {
      backlog = backlog.map((b) => (b.id === id ? ({ ...b, ...patch } as BacklogItem) : b))
      return backlog.find((b) => b.id === id) ?? null
    },
    countBacklog: (loopId, status) =>
      backlog.filter((b) => b.loopId === loopId && (status ? b.status === status : true)).length,
    listRecentDone: (loopId, limit) =>
      backlog
        .filter((b) => b.loopId === loopId && b.status === 'done')
        .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
        .slice(0, limit),
    recordLoopRun: (input) => {
      const run: LoopRun = {
        id: `run-${runs.length}`,
        loopId: input.loopId,
        iteration: input.iteration,
        backlogId: input.backlogId ?? null,
        startedAt: input.startedAt ?? 0,
        finishedAt: null,
        status: 'running',
        tokensUsed: null,
        createdAt: 0
      }
      runs.push(run)
      return run
    },
    finishLoopRun: (id, patch) => {
      const run = runs.find((r) => r.id === id)
      if (run) Object.assign(run, patch)
      return run ?? null
    },
    listDueLoops: (now) =>
      [...loops.values()].filter(
        (l) => l.status === 'running' && (l.nextFireAt == null || l.nextFireAt <= now)
      )
  }
  const appendPending = (tasks: string[]): void => {
    const base = backlog.length
    tasks.forEach((task, i) =>
      backlog.push(makeItem({ id: `g${base + i}`, position: base + i, task, status: 'pending' }))
    )
  }
  return { seam, loops, runs, getBacklog: () => backlog, appendPending }
}

describe('checkCeilings (pure)', () => {
  it('continues when no caps set', () => {
    expect(checkCeilings(makeLoop(), 5000).stop).toBe(false)
  })
  it('stops at max iterations', () => {
    const d = checkCeilings(makeLoop({ iteration: 5, maxIterations: 5 }), 5000)
    expect(d).toMatchObject({ stop: true, reason: 'max-iterations', status: 'done' })
  })
  it('stops at max wall-clock', () => {
    const d = checkCeilings(makeLoop({ startedAt: 1000, maxWallclockMs: 500 }), 1600)
    expect(d).toMatchObject({ stop: true, reason: 'max-wallclock' })
  })
  it('stops at token budget', () => {
    const d = checkCeilings(makeLoop({ tokensUsed: 200, tokenBudget: 150 }), 5000)
    expect(d).toMatchObject({ stop: true, reason: 'token-budget' })
  })
  it('ignores a zero/null token budget', () => {
    expect(checkCeilings(makeLoop({ tokensUsed: 9999, tokenBudget: 0 }), 5000).stop).toBe(false)
    expect(checkCeilings(makeLoop({ tokensUsed: 9999, tokenBudget: null }), 5000).stop).toBe(false)
  })
})

describe('computeNextFire (pure)', () => {
  it('interval = now + interval seconds', () => {
    expect(computeNextFire({ mode: 'interval', intervalSeconds: 120 }, 1000)).toBe(1000 + 120_000)
  })
  it('interval clamps to the runaway floor', () => {
    expect(computeNextFire({ mode: 'interval', intervalSeconds: 1 }, 1000)).toBe(
      1000 + MIN_INTERVAL_SECONDS * 1000
    )
  })
  it('interval falls back to the default when unset', () => {
    expect(computeNextFire({ mode: 'interval', intervalSeconds: null }, 0)).toBe(
      DEFAULT_INTERVAL_SECONDS * 1000
    )
  })
  it('autonomous fires at the floor', () => {
    expect(computeNextFire({ mode: 'autonomous', intervalSeconds: null }, 0, 30)).toBe(30_000)
  })
})

describe('estimateTokens / buildIterationPrompt (pure)', () => {
  it('estimates ~4 chars/token', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
  })
  it('prompt includes instruction, task, iteration, and remaining count', () => {
    const p = buildIterationPrompt(makeLoop(), makeItem({ task: 'ship it' }), {
      iteration: 3,
      remaining: 2
    })
    expect(p).toContain('Keep the build green')
    expect(p).toContain('ship it')
    expect(p).toContain('iteration 3')
    expect(p).toContain('2 task(s) remain')
    expect(p).toContain('loop_complete_task')
  })
})

describe('runLoopIteration (injected seam, runs fully)', () => {
  function deps(store: ReturnType<typeof makeFakeStore>, over: Partial<LoopIterationDeps> = {}): LoopIterationDeps {
    return {
      store: store.seam,
      runTurn: async () => ({ tokensUsed: 10 }),
      clock: () => 5000,
      ...over
    }
  }

  it('drains a 3-item backlog over 3 iterations, then stops backlog-empty', async () => {
    const store = makeFakeStore(makeLoop({ iteration: 0 }), [
      makeItem({ id: 'b1', position: 0, task: 'A' }),
      makeItem({ id: 'b2', position: 1, task: 'B' }),
      makeItem({ id: 'b3', position: 2, task: 'C' })
    ])
    const d = deps(store)
    const outcomes: string[] = []
    for (let i = 0; i < 5; i++) {
      const loop = store.seam.getLoop('loop-1')!
      if (loop.status !== 'running') break
      const o = await runLoopIteration(loop, d)
      outcomes.push(o.reason ?? (o.stopped ? 'stopped' : 'continue'))
    }
    const final = store.seam.getLoop('loop-1')!
    expect(final.status).toBe('done')
    expect(final.stopReason).toBe('backlog-empty')
    expect(final.iteration).toBe(3)
    expect(store.getBacklog().every((b) => b.status === 'done')).toBe(true)
    expect(outcomes[outcomes.length - 1]).toBe('backlog-empty')
  })

  it('stops pre-flight at max iterations without running a turn', async () => {
    const store = makeFakeStore(makeLoop({ iteration: 3, maxIterations: 3 }), [makeItem()])
    let ran = false
    const o = await runLoopIteration(store.seam.getLoop('loop-1')!, deps(store, { runTurn: async () => { ran = true; return {} } }))
    expect(ran).toBe(false)
    expect(o).toMatchObject({ ran: false, stopped: true, reason: 'max-iterations' })
    expect(store.seam.getLoop('loop-1')!.status).toBe('done')
  })

  it('stops post-iteration at the token budget', async () => {
    const store = makeFakeStore(makeLoop({ tokensUsed: 0, tokenBudget: 15 }), [
      makeItem({ id: 'b1', position: 0 }),
      makeItem({ id: 'b2', position: 1 })
    ])
    const o = await runLoopIteration(store.seam.getLoop('loop-1')!, deps(store, { runTurn: async () => ({ tokensUsed: 20 }) }))
    expect(o).toMatchObject({ ran: true, stopped: true, reason: 'token-budget' })
    const final = store.seam.getLoop('loop-1')!
    expect(final.status).toBe('done')
    expect(final.tokensUsed).toBe(20)
  })

  it('marks the item error and keeps the loop running when a turn throws', async () => {
    const store = makeFakeStore(makeLoop(), [
      makeItem({ id: 'b1', position: 0 }),
      makeItem({ id: 'b2', position: 1 })
    ])
    const o = await runLoopIteration(
      store.seam.getLoop('loop-1')!,
      deps(store, { runTurn: async () => { throw new Error('provider 500') } })
    )
    expect(o).toMatchObject({ ran: true, stopped: false, error: 'provider 500' })
    const item = store.getBacklog().find((b) => b.id === 'b1')!
    expect(item.status).toBe('error')
    expect(item.result).toContain('provider 500')
    const loop = store.seam.getLoop('loop-1')!
    expect(loop.status).toBe('running')
    expect(loop.iteration).toBe(1)
    expect(loop.nextFireAt).not.toBeNull()
  })

  it('schedules the next fire on a continuing iteration', async () => {
    const store = makeFakeStore(makeLoop({ intervalSeconds: 120 }), [
      makeItem({ id: 'b1', position: 0 }),
      makeItem({ id: 'b2', position: 1 })
    ])
    const o = await runLoopIteration(store.seam.getLoop('loop-1')!, deps(store))
    expect(o).toMatchObject({ ran: true, stopped: false })
    expect(store.seam.getLoop('loop-1')!.nextFireAt).toBe(5000 + 120_000)
  })
})

describe('LP-4 self-paced cadence + mid-turn model control', () => {
  it('honours a next-fire the model set during the turn (self_paced)', async () => {
    const store = makeFakeStore(makeLoop({ mode: 'self_paced', intervalSeconds: null }), [
      makeItem({ id: 'b1', position: 0 }),
      makeItem({ id: 'b2', position: 1 })
    ])
    const runTurn = async (): Promise<{ tokensUsed: number }> => {
      store.seam.updateLoop('loop-1', { nextFireAt: 5000 + 999_000 })
      return { tokensUsed: 1 }
    }
    const o = await runLoopIteration(store.seam.getLoop('loop-1')!, {
      store: store.seam,
      runTurn,
      clock: () => 5000
    })
    expect(o).toMatchObject({ ran: true, stopped: false })
    expect(store.seam.getLoop('loop-1')!.nextFireAt).toBe(5000 + 999_000)
  })

  it('terminates when the model stops the loop during the turn', async () => {
    const store = makeFakeStore(makeLoop({ mode: 'self_paced' }), [
      makeItem({ id: 'b1', position: 0 }),
      makeItem({ id: 'b2', position: 1 })
    ])
    const runTurn = async (): Promise<Record<string, never>> => {
      store.seam.updateLoop('loop-1', { status: 'stopped', stopReason: 'model-stop' })
      return {}
    }
    const o = await runLoopIteration(store.seam.getLoop('loop-1')!, {
      store: store.seam,
      runTurn,
      clock: () => 5000
    })
    expect(o).toMatchObject({ ran: true, stopped: true, reason: 'model-stop' })
    expect(store.seam.getLoop('loop-1')!.status).toBe('stopped')
  })
})

describe('LP-5 autonomous backlog mode', () => {
  function deps2(
    store: ReturnType<typeof makeFakeStore>,
    over: Partial<LoopIterationDeps> = {}
  ): LoopIterationDeps {
    return {
      store: store.seam,
      runTurn: async () => ({ tokensUsed: 1 }),
      clock: () => 5000,
      ...over
    }
  }

  it('grows the backlog mid-turn (loop_enqueue) then drains to done', async () => {
    const store = makeFakeStore(makeLoop({ mode: 'autonomous', intervalSeconds: null }), [
      makeItem({ id: 'b1', position: 0, task: 'seed' })
    ])
    let grew = false
    const runTurn = async (): Promise<{ tokensUsed: number }> => {
      if (!grew) {
        grew = true
        store.appendPending(['discovered-1', 'discovered-2'])
      }
      return { tokensUsed: 1 }
    }
    for (let i = 0; i < 10; i++) {
      const loop = store.seam.getLoop('loop-1')!
      if (loop.status !== 'running') break
      await runLoopIteration(loop, deps2(store, { runTurn }))
    }
    const final = store.seam.getLoop('loop-1')!
    expect(final.status).toBe('done')
    expect(final.stopReason).toBe('backlog-empty')
    expect(final.iteration).toBe(3) // seed + 2 discovered
    expect(store.getBacklog().every((b) => b.status === 'done')).toBe(true)
  })

  it('injects a progress ledger so settled work is visible to the model', async () => {
    const store = makeFakeStore(makeLoop({ mode: 'autonomous', intervalSeconds: null }), [
      makeItem({ id: 'b1', position: 0, task: 'first task' }),
      makeItem({ id: 'b2', position: 1, task: 'second task' })
    ])
    const prompts: string[] = []
    const runTurn = async (input: { promptBody: string }): Promise<{ tokensUsed: number }> => {
      prompts.push(input.promptBody)
      return { tokensUsed: 1 }
    }
    await runLoopIteration(store.seam.getLoop('loop-1')!, deps2(store, { runTurn }))
    await runLoopIteration(store.seam.getLoop('loop-1')!, deps2(store, { runTurn }))
    expect(prompts[0]).toContain('first task')
    expect(prompts[0]).not.toContain('Already done')
    expect(prompts[1]).toContain('Already done')
    expect(prompts[1]).toContain('first task')
  })

  it('runaway clamp: a continuing autonomous iteration fires no sooner than the floor', async () => {
    const store = makeFakeStore(makeLoop({ mode: 'autonomous', intervalSeconds: null }), [
      makeItem({ id: 'b1', position: 0 }),
      makeItem({ id: 'b2', position: 1 })
    ])
    const o = await runLoopIteration(store.seam.getLoop('loop-1')!, deps2(store, { minIntervalSeconds: 30 }))
    expect(o).toMatchObject({ ran: true, stopped: false })
    expect(store.seam.getLoop('loop-1')!.nextFireAt).toBe(5000 + 30_000)
  })
})

describe('LP-6 per-iteration stall watchdog', () => {
  it('aborts a stalled iteration without wedging the loop', async () => {
    const store = makeFakeStore(makeLoop({ mode: 'interval', intervalSeconds: 60 }), [
      makeItem({ id: 'b1', position: 0 }),
      makeItem({ id: 'b2', position: 1 })
    ])
    const runTurn = (input: { signal?: AbortSignal }): Promise<never> =>
      new Promise((_resolve, reject) => {
        input.signal?.addEventListener('abort', () => reject(new Error('aborted by watchdog')))
      })
    const o = await runLoopIteration(store.seam.getLoop('loop-1')!, {
      store: store.seam,
      runTurn,
      clock: () => 5000,
      iterationTimeoutMs: 20
    })
    expect(o).toMatchObject({ ran: true, stopped: false, timedOut: true })
    const item = store.getBacklog().find((b) => b.id === 'b1')!
    expect(item.status).toBe('error')
    expect(item.result).toContain('timed out')
    const loop = store.seam.getLoop('loop-1')!
    expect(loop.status).toBe('running')
    expect(loop.iteration).toBe(1)
    expect(loop.nextFireAt).toBe(5000 + 60_000)
  })

  it('a fast turn under the budget is unaffected', async () => {
    const store = makeFakeStore(makeLoop({ mode: 'interval', intervalSeconds: 60 }), [
      makeItem({ id: 'b1', position: 0 }),
      makeItem({ id: 'b2', position: 1 })
    ])
    const o = await runLoopIteration(store.seam.getLoop('loop-1')!, {
      store: store.seam,
      runTurn: async () => ({ tokensUsed: 5 }),
      clock: () => 5000,
      iterationTimeoutMs: 10_000
    })
    expect(o).toMatchObject({ ran: true, stopped: false })
    expect(o.timedOut).toBeUndefined()
    expect(store.getBacklog().find((b) => b.id === 'b1')!.status).toBe('done')
  })
})

describe('BUG-1 turn-incomplete (a truncated turn is never committed as success)', () => {
  it('a null turn result → item error, loop ADVANCES (keeps running), escalate fired, NO commit', async () => {
    const store = makeFakeStore(makeLoop({ id: 'ti-a', artifactDir: '/art' }), [
      makeItem({ id: 'b1', loopId: 'ti-a', position: 0, task: 'do work' }),
      makeItem({ id: 'b2', loopId: 'ti-a', position: 1, task: 'more work' })
    ])
    const execCalls: string[][] = []
    const exec = async (_cmd: string, args: string[]) => {
      execCalls.push(args)
      if (args[0] === 'rev-parse') return { stdout: 'sha-head', stderr: '', code: 0 }
      return { stdout: '', stderr: '', code: 0 }
    }
    const journal = makeJournal([])
    const delivered: string[] = []
    const o = await runLoopIteration(store.seam.getLoop('ti-a')!, {
      store: store.seam,
      // runChatRound truncated (deadline / round-cap) → runHeadlessTurn → null.
      runTurn: async () => null,
      clock: () => 5000,
      exec,
      journalFs: journal.fs,
      deliver: async (body) => {
        delivered.push(body)
        return { ok: true }
      }
    })
    // Option 3: one over-budget item does NOT halt the loop — it advances and
    // notifies. The run keeps going (stopped:false) so a day-long build isn't
    // stalled by a single stuck item.
    expect(o).toMatchObject({ ran: true, stopped: false, error: 'turn-incomplete' })
    const item = store.getBacklog().find((b) => b.id === 'b1')!
    expect(item.status).toBe('error')
    expect(item.result).toContain('turn-incomplete')
    const loop = store.seam.getLoop('ti-a')!
    // The loop keeps running and schedules its next fire.
    expect(loop.status).not.toBe('paused')
    expect(loop.nextFireAt).not.toBeNull()
    // Iteration advances (bounds the loop toward maxIterations); lastGitSha is
    // untouched because nothing durable was committed.
    expect(loop.iteration).toBe(1)
    expect(loop.lastGitSha).toBeNull()
    // Escalation still fired to the operator (heads-up that an item was skipped).
    expect(delivered.length).toBe(1)
    expect(delivered[0]).toContain('turn-incomplete')
    // commitStep never ran (no `git commit`) and the item never went `done`.
    expect(execCalls.some((a) => a[0] === 'commit')).toBe(false)
    expect(item.status).not.toBe('done')
  })

  it('a normally-resolving turn still commits + marks the item done (no regression)', async () => {
    const store = makeFakeStore(makeLoop({ id: 'ti-b', artifactDir: '/art' }), [
      makeItem({ id: 'b1', loopId: 'ti-b', position: 0, task: 'do work' }),
      makeItem({ id: 'b2', loopId: 'ti-b', position: 1, task: 'more work' })
    ])
    const journal = makeJournal([])
    const o = await runLoopIteration(store.seam.getLoop('ti-b')!, {
      store: store.seam,
      runTurn: async () => ({ tokensUsed: 7 }),
      clock: () => 5000,
      exec: cleanGitExec('sha-head'),
      journalFs: journal.fs
    })
    expect(o).toMatchObject({ ran: true, stopped: false })
    expect(store.getBacklog().find((b) => b.id === 'b1')!.status).toBe('done')
    const loop = store.seam.getLoop('ti-b')!
    expect(loop.status).toBe('running')
    expect(loop.iteration).toBe(1)
    // The item is flagged done only AFTER a durable commit entry is journaled.
    expect(journal.lines.some((l) => JSON.parse(l).kind === 'commit')).toBe(true)
  })

  it('watchdog abort that RESOLVES (not throws) → same advance-and-notify handling', async () => {
    const store = makeFakeStore(makeLoop({ id: 'ti-c' }), [
      makeItem({ id: 'b1', loopId: 'ti-c', position: 0 }),
      makeItem({ id: 'b2', loopId: 'ti-c', position: 1 })
    ])
    const delivered: string[] = []
    // Unlike LP-6 (which REJECTS on abort → the catch/timeout advance path), this
    // turn RESOLVES null when aborted, landing in the success-path incomplete check.
    const runTurn = (input: { signal?: AbortSignal }): Promise<null> =>
      new Promise((resolve) => {
        input.signal?.addEventListener('abort', () => resolve(null))
      })
    const o = await runLoopIteration(store.seam.getLoop('ti-c')!, {
      store: store.seam,
      runTurn,
      clock: () => 5000,
      iterationTimeoutMs: 20,
      deliver: async (body) => {
        delivered.push(body)
        return { ok: true }
      }
    })
    // timedOut resolve-null path: advance + notify, loop keeps running.
    expect(o).toMatchObject({ ran: true, stopped: false })
    expect(store.getBacklog().find((b) => b.id === 'b1')!.status).toBe('error')
    const loop = store.seam.getLoop('ti-c')!
    expect(loop.status).not.toBe('paused')
    expect(loop.iteration).toBe(1)
    expect(delivered.some((b) => b.includes('turn-incomplete'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Long-run L2 / L4 / L7 / L8 integration — git/journal/disk seams wired in.
// These exercise the fail-closed + idempotent-resume + oscillation-detection
// paths added by the L1-L8 correctness fixes.
// ---------------------------------------------------------------------------

/** Add the optional inProgressBacklogItem seam the reconcile branch needs. */
function withInProgress(store: ReturnType<typeof makeFakeStore>): void {
  store.seam.inProgressBacklogItem = (loopId) =>
    store.getBacklog().find((b) => b.loopId === loopId && b.status === 'in_progress') ?? null
}

/** A path-agnostic in-memory journal fs seam. exists() is always true so the
 *  reconcile branch fires whenever exec + artifactDir are wired. */
function makeJournal(initialLines: string[] = []) {
  const lines = [...initialLines]
  const fs = {
    appendLine: (_p: string, line: string) => {
      lines.push(line)
    },
    readLines: (_p: string) => lines,
    exists: (_p: string) => true
  }
  return { fs, lines }
}

function commitJournalLine(over: Record<string, unknown>): string {
  return JSON.stringify({
    seq: 0,
    ts: 1,
    loopId: 'loop',
    itemId: null,
    kind: 'commit',
    gitSha: null,
    usage: null,
    cost: null,
    note: null,
    ...over
  })
}

/** A git exec seam: rev-parse → `head`, everything else clean/no-op (so
 *  commitStep takes its "tree already clean → return HEAD" no-op path). */
function cleanGitExec(head: string) {
  return async (_cmd: string, args: string[]) => {
    if (args[0] === 'rev-parse') return { stdout: head, stderr: '', code: 0 }
    return { stdout: '', stderr: '', code: 0 }
  }
}

describe('L2 idempotent resume (reconcile per-item)', () => {
  it('re-runs an in_progress item that has NO matching commit in the journal', async () => {
    const store = makeFakeStore(makeLoop({ id: 'l2-a', artifactDir: '/art' }), [
      makeItem({ id: 'b1', loopId: 'l2-a', position: 0, task: 'resume me', status: 'in_progress' })
    ])
    withInProgress(store)
    const journal = makeJournal([]) // exists, but empty → no commit landed
    const ran: string[] = []
    const o = await runLoopIteration(store.seam.getLoop('l2-a')!, {
      store: store.seam,
      runTurn: async (input) => {
        ran.push(input.promptBody)
        return { tokensUsed: 1 }
      },
      clock: () => 5000,
      exec: cleanGitExec('sha-x'),
      journalFs: journal.fs
    })
    // Reset to pending on reconcile, then pulled + run this same iteration.
    expect(ran.some((p) => p.includes('resume me'))).toBe(true)
    expect(store.getBacklog().find((b) => b.id === 'b1')!.status).toBe('done')
    expect(o).toMatchObject({ ran: true })
  })

  it('marks an in_progress item done (not re-run) when its commit IS at HEAD', async () => {
    const store = makeFakeStore(makeLoop({ id: 'l2-b', artifactDir: '/art' }), [
      makeItem({ id: 'b1', loopId: 'l2-b', position: 0, task: 'already landed', status: 'in_progress' })
    ])
    withInProgress(store)
    const journal = makeJournal([
      commitJournalLine({ loopId: 'l2-b', itemId: 'b1', gitSha: 'sha-1' })
    ])
    let ranCount = 0
    const o = await runLoopIteration(store.seam.getLoop('l2-b')!, {
      store: store.seam,
      runTurn: async () => {
        ranCount++
        return { tokensUsed: 1 }
      },
      clock: () => 5000,
      exec: cleanGitExec('sha-1'), // HEAD === the journaled commit sha
      journalFs: journal.fs
    })
    // Closed out by reconcile; no pending items remain → backlog-empty, no re-run.
    expect(ranCount).toBe(0)
    expect(store.getBacklog().find((b) => b.id === 'b1')!.status).toBe('done')
    expect(o).toMatchObject({ ran: false, stopped: true, reason: 'backlog-empty' })
  })

  it('RE-RUNS (not done) an in_progress item whose commit-at-HEAD was verify-rejected', async () => {
    // The commit entry lands at HEAD, but a verify-reject entry supersedes it — the
    // 2BRAIN gate withheld done. Reconcile must re-run it, not mark it done.
    const store = makeFakeStore(makeLoop({ id: 'l2-v', artifactDir: '/art' }), [
      makeItem({ id: 'b1', loopId: 'l2-v', position: 0, task: 'rejected last time', status: 'in_progress' })
    ])
    withInProgress(store)
    const journal = makeJournal([
      commitJournalLine({ loopId: 'l2-v', itemId: 'b1', gitSha: 'sha-1', kind: 'commit' }),
      commitJournalLine({
        loopId: 'l2-v',
        itemId: 'b1',
        gitSha: 'sha-1',
        kind: 'verify',
        note: 'verify-reject: memory write corrupted the store'
      })
    ])
    let ranCount = 0
    await runLoopIteration(store.seam.getLoop('l2-v')!, {
      store: store.seam,
      runTurn: async () => {
        ranCount++
        return { tokensUsed: 1 }
      },
      clock: () => 5000,
      exec: cleanGitExec('sha-1'), // HEAD === the committed sha
      journalFs: journal.fs
    })
    // Reconcile reset it to pending (verify-reject supersedes the commit) → re-run.
    expect(ranCount).toBe(1)
  })
})

describe('VERIFY (2BRAIN) — commit→done gates on a BRAIN-output receipt', () => {
  it('WITHHOLDS the done-flag when the turn corrupts the store (item stays in_progress)', async () => {
    const store = makeFakeStore(makeLoop({ id: 'v-a', artifactDir: '/art' }), [
      makeItem({ id: 'b1', loopId: 'v-a', position: 0, task: 'consolidate memory' })
    ])
    const journal = makeJournal([])
    const delivered: string[] = []
    const o = await runLoopIteration(store.seam.getLoop('v-a')!, {
      store: store.seam,
      runTurn: async () => ({ tokensUsed: 5 }),
      clock: () => 5000,
      exec: cleanGitExec('sha-v'),
      journalFs: journal.fs,
      deliver: async (body: string) => {
        delivered.push(body)
        return { ok: true }
      },
      // A corrupting write: coherence collapses across the turn.
      brainVerify: async () => ({ coherenceBefore: 60, coherenceAfter: 30 })
    })
    // The durable commit still landed, but the success attestation is refused.
    expect(o).toMatchObject({ ran: true, stopped: false, error: 'verify-failed' })
    expect(store.getBacklog().find((b) => b.id === 'b1')!.status).toBe('in_progress')
    expect(delivered.some((b) => /verify-failed/.test(b))).toBe(true)
    // A durable verify-reject record was journaled.
    expect(journal.lines.some((l) => /verify-reject/.test(l))).toBe(true)
  })

  it('PERSISTS the iteration/token/cost accounting and a future nextFireAt on verify-reject', async () => {
    // Regression: the verify-reject exit used to return without any updateLoop, so
    // iteration/tokensUsed/costSpent froze (maxIterations, tokenBudget and
    // costBudgetUsd could never trip) and nextFireAt stayed in the past — making
    // listDueLoops re-select the loop on every 30s tick forever.
    const store = makeFakeStore(
      makeLoop({ id: 'v-f', artifactDir: '/art', intervalSeconds: 3600, nextFireAt: 0 }),
      [
        makeItem({ id: 'b1', loopId: 'v-f', position: 0, task: 'cite a note' }),
        makeItem({ id: 'b2', loopId: 'v-f', position: 1, task: 'cite another', status: 'pending' })
      ]
    )
    const journal = makeJournal([])
    const o = await runLoopIteration(store.seam.getLoop('v-f')!, {
      store: store.seam,
      runTurn: async () => ({ tokensUsed: 7 }),
      clock: () => 5000,
      exec: cleanGitExec('sha-v'),
      journalFs: journal.fs,
      brainVerify: async () => ({ coherenceBefore: 60, coherenceAfter: 30 })
    })
    expect(o).toMatchObject({ ran: true, stopped: false, error: 'verify-failed' })
    const saved = store.loops.get('v-f')!
    expect(saved.iteration).toBe(1)
    expect(saved.tokensUsed).toBe(7)
    expect(saved.lastIterationAt).toBe(5000)
    // Rescheduled a real interval ahead — no longer due on the next tick.
    expect(saved.nextFireAt).toBe(5000 + 3600 * 1000)
    expect(store.seam.listDueLoops(5000).some((l) => l.id === 'v-f')).toBe(false)
    // The gate itself is unchanged: the item is still withheld from done.
    expect(store.getBacklog().find((b) => b.id === 'b1')!.status).toBe('in_progress')
  })

  it('returns the item to pending on verify-reject when the loop has NO artifactDir', async () => {
    // Backlog finding 20. The verify gate withholds `done` and leaves the item
    // in_progress "for reconcile to re-run" — but step 1.5's reconcile is gated on
    // loop.artifactDir, and no renderer path has ever sent one (grep src/ — zero
    // hits), so every UI-created loop has none. nextBacklogItem selects only
    // status='pending', so the item was stranded with no revival path, and the loop
    // then reported backlog-empty and marked itself done with the task unfinished.
    const store = makeFakeStore(makeLoop({ id: 'v-noart', artifactDir: null }), [
      makeItem({ id: 'b1', loopId: 'v-noart', position: 0, task: 'cite a note' })
    ])
    const o = await runLoopIteration(store.seam.getLoop('v-noart')!, {
      store: store.seam,
      runTurn: async () => ({ tokensUsed: 5 }),
      clock: () => 5000,
      brainVerify: async () => ({ coherenceBefore: 60, coherenceAfter: 30 })
    })
    expect(o).toMatchObject({ ran: true, stopped: false, error: 'verify-failed' })
    // Withheld from done — that half of the gate is unchanged...
    expect(store.getBacklog().find((b) => b.id === 'b1')!.status).not.toBe('done')
    // ...but re-runnable, rather than stranded in_progress forever.
    expect(store.getBacklog().find((b) => b.id === 'b1')!.status).toBe('pending')
    expect(store.seam.nextBacklogItem('v-noart')?.id).toBe('b1')
  })

  it('leaves an artifactDir loop to reconcile, so the two revival paths cannot race', async () => {
    // The counterpart guard: a loop WITH an artifact dir still gets the journal-based
    // reconcile decision, not a second one from the gate.
    const store = makeFakeStore(makeLoop({ id: 'v-art', artifactDir: '/art' }), [
      makeItem({ id: 'b1', loopId: 'v-art', position: 0, task: 'cite a note' })
    ])
    const journal = makeJournal([])
    await runLoopIteration(store.seam.getLoop('v-art')!, {
      store: store.seam,
      runTurn: async () => ({ tokensUsed: 5 }),
      clock: () => 5000,
      exec: cleanGitExec('sha-v'),
      journalFs: journal.fs,
      brainVerify: async () => ({ coherenceBefore: 60, coherenceAfter: 30 })
    })
    expect(store.getBacklog().find((b) => b.id === 'b1')!.status).toBe('in_progress')
  })

  it('marks done when the verify receipt passes', async () => {
    const store = makeFakeStore(makeLoop({ id: 'v-b', artifactDir: '/art' }), [
      makeItem({ id: 'b1', loopId: 'v-b', position: 0, task: 'clean consolidation' })
    ])
    const journal = makeJournal([])
    const o = await runLoopIteration(store.seam.getLoop('v-b')!, {
      store: store.seam,
      runTurn: async () => ({ tokensUsed: 5 }),
      clock: () => 5000,
      exec: cleanGitExec('sha-v'),
      journalFs: journal.fs,
      brainVerify: async () => ({ coherenceBefore: 60, coherenceAfter: 61 })
    })
    expect(store.getBacklog().find((b) => b.id === 'b1')!.status).toBe('done')
    // Backlog drained → the normal stop path, not a verify block.
    expect(o.error).not.toBe('verify-failed')
  })

  it('behaves exactly as before when no brainVerify seam is wired (backward-compat)', async () => {
    const store = makeFakeStore(makeLoop({ id: 'v-c', artifactDir: '/art' }), [
      makeItem({ id: 'b1', loopId: 'v-c', position: 0, task: 'ungoverned' })
    ])
    const journal = makeJournal([])
    await runLoopIteration(store.seam.getLoop('v-c')!, {
      store: store.seam,
      runTurn: async () => ({ tokensUsed: 5 }),
      clock: () => 5000,
      exec: cleanGitExec('sha-v'),
      journalFs: journal.fs
    })
    expect(store.getBacklog().find((b) => b.id === 'b1')!.status).toBe('done')
  })

  it('DoD-SEED: withholds done when the digest drops a seeded active track', async () => {
    const store = makeFakeStore(makeLoop({ id: 'v-d', artifactDir: '/art' }), [
      makeItem({ id: 'b1', loopId: 'v-d', position: 0, task: 'EOD digest across all tracks' })
    ])
    const journal = makeJournal([])
    const seeded: string[] = []
    const o = await runLoopIteration(store.seam.getLoop('v-d')!, {
      store: store.seam,
      runTurn: async () => ({ tokensUsed: 5 }),
      clock: () => 5000,
      exec: cleanGitExec('sha-v'),
      journalFs: journal.fs,
      emit: (ch: string) => {
        if (ch === 'loop:dod:seed') seeded.push(ch)
      },
      // Seeded at task start: the brain has 3 active tracks.
      seedDoD: () => ({
        acceptanceCriteria: [
          { kind: 'covers-active-tracks', requiredTracks: ['北澜', 'orbis', 'AIT'], describe: '' },
          { kind: 'no-orphan-claims', describe: '' }
        ],
        seededFromTracks: ['北澜', 'orbis', 'AIT']
      }),
      // Observed at commit: the digest only covered 2 of the 3 → DoD unmet.
      brainVerify: () => ({ coveredTracks: ['北澜', 'orbis'], orphanClaims: [] })
    })
    expect(seeded.length).toBe(1) // DoD was seeded at task start
    expect(o).toMatchObject({ ran: true, error: 'verify-failed' })
    expect(store.getBacklog().find((b) => b.id === 'b1')!.status).toBe('in_progress')
    expect(journal.lines.some((l) => /missed 1 active track/.test(l))).toBe(true)
  })

  it('DoD-SEED: marks done when the digest covers every seeded track', async () => {
    const store = makeFakeStore(makeLoop({ id: 'v-e', artifactDir: '/art' }), [
      makeItem({ id: 'b1', loopId: 'v-e', position: 0, task: 'EOD digest' })
    ])
    const journal = makeJournal([])
    await runLoopIteration(store.seam.getLoop('v-e')!, {
      store: store.seam,
      runTurn: async () => ({ tokensUsed: 5 }),
      clock: () => 5000,
      exec: cleanGitExec('sha-v'),
      journalFs: journal.fs,
      seedDoD: () => ({
        acceptanceCriteria: [
          { kind: 'covers-active-tracks', requiredTracks: ['北澜', 'orbis'], describe: '' },
          { kind: 'no-orphan-claims', describe: '' }
        ],
        seededFromTracks: ['北澜', 'orbis']
      }),
      brainVerify: () => ({ coveredTracks: ['北澜', 'orbis'], orphanClaims: [] })
    })
    expect(store.getBacklog().find((b) => b.id === 'b1')!.status).toBe('done')
  })

  // ── The tool the MODEL calls, on the path production actually takes. ────────
  // Every iteration prompt ends with "Complete this task, then call
  // loop_complete_task…" (buildIterationPrompt) and that native tool is enabled,
  // non-approval and reachable in any turn — so it fires MID-TURN, before
  // commitStep and before this gate. It used to write status:'done' itself,
  // which pre-empted both the verify gate (whose reject branch withholds `done`
  // by writing nothing) and the L2 reconcile (which finds interrupted work via
  // inProgressBacklogItem, i.e. status='in_progress' only). These two tests run
  // the real tool logic inside runTurn so the ordering invariant is proven where
  // it is actually exercised, not just in the tool's own unit test.
  function modelToolSeam(store: ReturnType<typeof makeFakeStore>, loopId: string): LoopToolStore {
    return {
      getActiveLoopForConversation: () => store.seam.getLoop(loopId),
      enqueueBacklog: () => [],
      inProgressBacklogItem: (lid) =>
        store.getBacklog().find((b) => b.loopId === lid && b.status === 'in_progress') ?? null,
      updateBacklogItem: (id, patch) => store.seam.updateBacklogItem(id, patch),
      updateLoop: (id, patch) => store.seam.updateLoop(id, patch)
    }
  }

  it('a mid-turn loop_complete_task must NOT pre-empt the gate (rejected item stays in_progress)', async () => {
    const store = makeFakeStore(makeLoop({ id: 'v-tool', artifactDir: '/art' }), [
      makeItem({ id: 'b1', loopId: 'v-tool', position: 0, task: 'consolidate memory' })
    ])
    withInProgress(store)
    const journal = makeJournal([])
    const tools = modelToolSeam(store, 'v-tool')
    const o = await runLoopIteration(store.seam.getLoop('v-tool')!, {
      store: store.seam,
      runTurn: async () => {
        applyLoopCompleteTask(tools, 'conv-1', 'looks done to me')
        return { tokensUsed: 5 }
      },
      clock: () => 5000,
      exec: cleanGitExec('sha-v'),
      journalFs: journal.fs,
      brainVerify: async () => ({ coherenceBefore: 60, coherenceAfter: 30 })
    })
    expect(o).toMatchObject({ ran: true, stopped: false, error: 'verify-failed' })
    const b1 = store.getBacklog().find((b) => b.id === 'b1')!
    expect(b1.status).toBe('in_progress')
    expect(b1.finishedAt).toBeNull()
    // Still visible to the L2 reconcile, which only matches in_progress — a
    // mid-turn `done` made the interrupted/rejected item invisible to it.
    expect(store.seam.inProgressBacklogItem!('v-tool')?.id).toBe('b1')
    // Never re-offered as settled work in the "Already done (do NOT repeat)" ledger.
    expect(store.seam.listRecentDone('v-tool', 5)).toHaveLength(0)
    // The model's outcome text is still recorded (the ledger keeps working).
    expect(b1.result).toBe('looks done to me')
  })

  it('the model outcome survives to the controller close-out on the passing path', async () => {
    const store = makeFakeStore(makeLoop({ id: 'v-tool-ok', artifactDir: '/art' }), [
      makeItem({ id: 'b1', loopId: 'v-tool-ok', position: 0, task: 'clean consolidation' })
    ])
    withInProgress(store)
    const journal = makeJournal([])
    const tools = modelToolSeam(store, 'v-tool-ok')
    await runLoopIteration(store.seam.getLoop('v-tool-ok')!, {
      store: store.seam,
      runTurn: async () => {
        applyLoopCompleteTask(tools, 'conv-1', 'shipped the fix')
        return { tokensUsed: 5 }
      },
      clock: () => 5000,
      exec: cleanGitExec('sha-v'),
      journalFs: journal.fs,
      brainVerify: async () => ({ coherenceBefore: 60, coherenceAfter: 61 })
    })
    const b1 = store.getBacklog().find((b) => b.id === 'b1')!
    expect(b1.status).toBe('done')
    expect(b1.result).toBe('shipped the fix')
    expect(b1.finishedAt).toBe(5000)
  })
})

describe('L8 gated-action fail-closed (approval unset)', () => {
  it('skips an irreversible item when no approval channel is wired, runs a reversible one', async () => {
    const store = makeFakeStore(makeLoop({ id: 'l8-a', mode: 'autonomous', intervalSeconds: null }), [
      makeItem({ id: 'b1', loopId: 'l8-a', position: 0, task: 'DELETE the prod bucket' }),
      makeItem({ id: 'b2', loopId: 'l8-a', position: 1, task: 'read the logs' })
    ])
    const ran: string[] = []
    const floor = (a: { summary: string }): 'read' | 'write-reversible' | 'irreversible' =>
      a.summary.startsWith('DELETE') ? 'irreversible' : 'read'
    const deps: LoopIterationDeps = {
      store: store.seam,
      runTurn: async (input) => {
        ran.push(input.promptBody)
        return { tokensUsed: 1 }
      },
      clock: () => 5000,
      irreversibilityFloor: floor // NOTE: approval intentionally NOT wired
    }
    const first = await runLoopIteration(store.seam.getLoop('l8-a')!, deps)
    const second = await runLoopIteration(store.seam.getLoop('l8-a')!, deps)

    expect(first).toMatchObject({ ran: false, stopped: false, reason: 'no-approval-channel' })
    const irr = store.getBacklog().find((b) => b.id === 'b1')!
    expect(irr.status).toBe('skipped')
    expect(irr.result).toBe('no-approval-channel')
    // The irreversible task never executed; the reversible one did.
    expect(ran.some((p) => p.includes('DELETE the prod bucket'))).toBe(false)
    expect(ran.some((p) => p.includes('read the logs'))).toBe(true)
    expect(second).toMatchObject({ ran: true })
    expect(store.getBacklog().find((b) => b.id === 'b2')!.status).toBe('done')
  })
})

describe('L7 pre-iteration disk guard', () => {
  it('pauses BEFORE the turn when free disk is below the floor (turn never runs)', async () => {
    const store = makeFakeStore(makeLoop({ id: 'l7-a', artifactDir: '/art' }), [
      makeItem({ id: 'b1', loopId: 'l7-a', position: 0, task: 'write a big file' })
    ])
    let ran = false
    const o = await runLoopIteration(store.seam.getLoop('l7-a')!, {
      store: store.seam,
      runTurn: async () => {
        ran = true
        return { tokensUsed: 1 }
      },
      clock: () => 5000,
      statfs: async () => ({ bavail: 1, bsize: 1 }), // ~1 byte free
      resourceThresholds: { diskMinBytes: 1_000_000, rssMaxBytes: 0 }
    })
    expect(ran).toBe(false)
    expect(o).toMatchObject({ ran: false, stopped: true, reason: 'disk-low' })
    const loop = store.seam.getLoop('l7-a')!
    expect(loop.status).toBe('paused')
    expect(loop.stopReason).toBe('disk-low')
    // The claimed item is reset so a resume re-runs it.
    expect(store.getBacklog().find((b) => b.id === 'b1')!.status).toBe('pending')
  })
})

describe('L4 oscillation (state-revisit) detection', () => {
  it('escalates as stalled when artifact state flips between two hashes', async () => {
    const store = makeFakeStore(makeLoop({ id: 'osc-a', artifactDir: '/art' }), [
      makeItem({ id: 'b1', loopId: 'osc-a', position: 0 }),
      makeItem({ id: 'b2', loopId: 'osc-a', position: 1 }),
      makeItem({ id: 'b3', loopId: 'osc-a', position: 2 }),
      makeItem({ id: 'b4', loopId: 'osc-a', position: 3 }),
      makeItem({ id: 'b5', loopId: 'osc-a', position: 4 })
    ])
    let stateVal = 'S0'
    const exec = async (_cmd: string, args: string[]) => {
      if (args[0] === 'rev-parse') return { stdout: 'sha-head', stderr: '', code: 0 }
      if (args[0] === 'ls-files') return { stdout: stateVal, stderr: '', code: 0 }
      return { stdout: '', stderr: '', code: 0 } // status clean, add/commit no-op
    }
    const deps: LoopIterationDeps = {
      store: store.seam,
      runTurn: async () => {
        stateVal = stateVal === 'A' ? 'B' : 'A' // oscillate A↔B every turn
        return { tokensUsed: 1 }
      },
      clock: () => 5000,
      exec,
      stallK: 0, // stall-count guard OFF — only the revisit cycle should escalate
      repeatWindow: 4
    }
    for (let i = 0; i < 5; i++) {
      const loop = store.seam.getLoop('osc-a')!
      if (loop.status !== 'running') break
      await runLoopIteration(loop, deps)
    }
    const final = store.seam.getLoop('osc-a')!
    expect(final.status).toBe('paused')
    expect(final.stopReason).toBe('stalled')
  })
})
