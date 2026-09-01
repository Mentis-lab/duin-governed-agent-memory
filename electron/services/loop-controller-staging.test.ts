import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))

// Control the capability rung + keep getCapability benign (null ⇒ no ceiling scaling,
// since the test loop has null caps). This is the ONLY external input that decides
// whether output is held.
const classifyMock = vi.fn<() => 'run' | 'stage' | 'hold'>()
vi.mock('./ans/capability-ledger', () => ({
  classify: () => classifyMock(),
  getCapability: () => null,
  recordFeedback: vi.fn()
}))

import { runLoopIteration, type LoopStoreSeam, type LoopIterationDeps } from './loop-controller'
import { currentSha, stagedRef, type ExecSeam } from './longrun/artifact-checkpoint'
import type { Loop, BacklogItem, LoopRun } from './loop-store'

const pexec = promisify(execFile)
const realExec: ExecSeam = async (cmd, args, opts) => {
  try {
    const { stdout, stderr } = await pexec(
      cmd,
      ['-c', 'user.email=t@duin.local', '-c', 'user.name=DUIN Test', ...args],
      { cwd: opts?.cwd }
    )
    return { stdout, stderr, code: 0 }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number }
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? String(e), code: err.code ?? 1 }
  }
}
const revCount = async (dir: string): Promise<number> =>
  Number((await realExec('git', ['rev-list', '--count', 'HEAD'], { cwd: dir })).stdout.trim())
const refExists = async (dir: string, ref: string): Promise<boolean> => {
  const r = await realExec('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: dir })
  return r.code === 0 && r.stdout.trim().length > 0
}

function makeLoop(dir: string, over: Partial<Loop> = {}): Loop {
  return {
    id: 'loop-1', conversationId: 'c1', mode: 'autonomous', status: 'running',
    instruction: 'work', model: 'deepseek-chat', intervalSeconds: null, maxIterations: null,
    maxWallclockMs: null, tokenBudget: null, iteration: 0, tokensUsed: 0, startedAt: 1000,
    lastIterationAt: null, nextFireAt: 0, stopReason: null, costSpent: 0, costBudgetUsd: null,
    stallCount: 0, lastStateHash: null, rollingSummary: null, artifactDir: dir, lastGitSha: null,
    providerChain: null, currentProvider: null, lastDigestAt: null, goalId: null, goalConversationId: null, createdAt: 1000, updatedAt: 1000,
    ...over
  }
}
function makeItem(over: Partial<BacklogItem> = {}): BacklogItem {
  return { id: 'b1', loopId: 'loop-1', position: 0, task: 'produce output', status: 'pending',
    result: null, createdAt: 0, startedAt: null, finishedAt: null, ...over }
}
function makeStore(loop: Loop, items: BacklogItem[]) {
  const loops = new Map([[loop.id, { ...loop }]])
  let backlog = items.map((b) => ({ ...b }))
  const runs: LoopRun[] = []
  const seam: LoopStoreSeam = {
    getLoop: (id) => loops.get(id) ?? null,
    updateLoop: (id, patch) => { const c = loops.get(id); if (!c) return null; const n = { ...c, ...patch } as Loop; loops.set(id, n); return n },
    nextBacklogItem: (lid) => backlog.filter((b) => b.loopId === lid && b.status === 'pending').sort((a, b) => a.position - b.position)[0] ?? null,
    updateBacklogItem: (id, patch) => { backlog = backlog.map((b) => (b.id === id ? ({ ...b, ...patch } as BacklogItem) : b)); return backlog.find((b) => b.id === id) ?? null },
    countBacklog: (lid, status) => backlog.filter((b) => b.loopId === lid && (status ? b.status === status : true)).length,
    listRecentDone: (lid, limit) => backlog.filter((b) => b.loopId === lid && b.status === 'done').slice(0, limit),
    recordLoopRun: (input) => { const r: LoopRun = { id: `run-${runs.length}`, loopId: input.loopId, iteration: input.iteration, backlogId: input.backlogId ?? null, startedAt: input.startedAt ?? 0, finishedAt: null, status: 'running', tokensUsed: null, createdAt: 0 }; runs.push(r); return r },
    finishLoopRun: (id, patch) => { const r = runs.find((x) => x.id === id); if (r) Object.assign(r, patch); return r ?? null },
    listDueLoops: () => [...loops.values()]
  }
  return { seam, loops, getBacklog: () => backlog }
}

describe('runLoopIteration — governor 4a output holding (real git)', () => {
  let dir: string
  const OLD = process.env.DUIN_MERIT_AUTONOMY

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'duin-loopstage-'))
    await realExec('git', ['init', '-q'], { cwd: dir })
    writeFileSync(join(dir, 'seed.txt'), 'seed\n')
    await realExec('git', ['add', '-A'], { cwd: dir })
    await realExec('git', ['commit', '-q', '-m', 'initial'], { cwd: dir })
    classifyMock.mockReset()
  })
  afterEach(() => {
    if (OLD === undefined) delete process.env.DUIN_MERIT_AUTONOMY
    else process.env.DUIN_MERIT_AUTONOMY = OLD
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  // runTurn simulates the agentic turn producing durable output in the artifact dir.
  const producingTurn = () => async () => { writeFileSync(join(dir, 'OUT.md'), 'work product\n'); return { tokensUsed: 10 } }
  function deps(store: ReturnType<typeof makeStore>, over: Partial<LoopIterationDeps> = {}): LoopIterationDeps {
    const events: { channel: string; payload: unknown }[] = []
    return {
      store: store.seam, runTurn: producingTurn(), exec: realExec, clock: () => 5000,
      emit: (channel, payload) => { events.push({ channel, payload }) },
      __events: events,
      ...over
    } as LoopIterationDeps & { __events: typeof events }
  }

  it('FLAG ON + stage rung ⇒ output HELD: item awaiting-ratification, branch NOT advanced, loop:staged, paused', async () => {
    process.env.DUIN_MERIT_AUTONOMY = '1'
    classifyMock.mockReturnValue('stage')
    const store = makeStore(makeLoop(dir), [makeItem()])
    const before = await revCount(dir)
    const d = deps(store)

    const o = await runLoopIteration(store.seam.getLoop('loop-1')!, d)

    expect(o).toMatchObject({ ran: true, stopped: true, reason: 'awaiting-ratification', staged: true })
    // Backlog item is HELD, not done.
    expect(store.getBacklog()[0].status).toBe('awaiting-ratification')
    // The artifact branch did NOT advance and the work is NOT in the tree — genuinely held.
    expect(await revCount(dir)).toBe(before)
    expect(existsSync(join(dir, 'OUT.md'))).toBe(false)
    // The work is parked on the side ref for later ratify.
    expect(await refExists(dir, stagedRef('b1'))).toBe(true)
    // Loop paused, awaiting the human.
    expect(store.loops.get('loop-1')!.status).toBe('paused')
    expect(store.loops.get('loop-1')!.stopReason).toBe('awaiting-ratification')
    // loop:staged surfaced with the backlog id.
    const staged = (d as unknown as { __events: { channel: string; payload: { backlogId?: string } }[] }).__events.find((e) => e.channel === 'loop:staged')
    expect(staged?.payload.backlogId).toBe('b1')
  })

  it('FLAG OFF ⇒ byte-identical: output LANDS (item done, branch advanced, no staged ref)', async () => {
    delete process.env.DUIN_MERIT_AUTONOMY
    classifyMock.mockReturnValue('stage') // rung is irrelevant when the flag is off
    const store = makeStore(makeLoop(dir), [makeItem()])
    const before = await revCount(dir)

    await runLoopIteration(store.seam.getLoop('loop-1')!, deps(store))

    expect(store.getBacklog()[0].status).toBe('done')
    expect(await revCount(dir)).toBe(before + 1) // landed
    expect(existsSync(join(dir, 'OUT.md'))).toBe(true)
    expect(await refExists(dir, stagedRef('b1'))).toBe(false)
  })

  it('FLAG ON + run rung (earned reflexive) ⇒ output LANDS normally', async () => {
    process.env.DUIN_MERIT_AUTONOMY = '1'
    classifyMock.mockReturnValue('run')
    const store = makeStore(makeLoop(dir), [makeItem()])
    const before = await revCount(dir)

    await runLoopIteration(store.seam.getLoop('loop-1')!, deps(store))

    expect(store.getBacklog()[0].status).toBe('done')
    expect(await revCount(dir)).toBe(before + 1)
    expect(await refExists(dir, stagedRef('b1'))).toBe(false)
  })

  it('FLAG ON + stage rung, but an item already awaits ratification ⇒ does NOT stack (pauses, no turn)', async () => {
    process.env.DUIN_MERIT_AUTONOMY = '1'
    classifyMock.mockReturnValue('stage')
    // b1 is already held; b2 is pending. The loop must not stage b2 onto the same base.
    const store = makeStore(makeLoop(dir), [
      makeItem({ id: 'b1', position: 0, status: 'awaiting-ratification' }),
      makeItem({ id: 'b2', position: 1, status: 'pending' })
    ])
    const before = await revCount(dir)

    const o = await runLoopIteration(store.seam.getLoop('loop-1')!, deps(store))

    expect(o).toMatchObject({ ran: false, stopped: true, reason: 'awaiting-ratification' })
    expect(store.getBacklog().find((b) => b.id === 'b2')!.status).toBe('pending') // untouched
    expect(await revCount(dir)).toBe(before)
    expect(existsSync(join(dir, 'OUT.md'))).toBe(false) // no turn ran
  })

  it('FLAG ON + hold rung ⇒ the turn never runs (autonomy-not-earned), nothing produced', async () => {
    process.env.DUIN_MERIT_AUTONOMY = '1'
    classifyMock.mockReturnValue('hold')
    const store = makeStore(makeLoop(dir), [makeItem()])
    const before = await revCount(dir)

    const o = await runLoopIteration(store.seam.getLoop('loop-1')!, deps(store))

    expect(o).toMatchObject({ ran: false, stopped: true, reason: 'autonomy-not-earned' })
    expect(store.getBacklog()[0].status).toBe('pending') // untouched
    expect(await revCount(dir)).toBe(before)
    expect(existsSync(join(dir, 'OUT.md'))).toBe(false) // the turn was never invoked
  })
})
