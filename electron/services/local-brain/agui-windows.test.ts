import { describe, it, expect } from 'vitest'
import { partitionAguiWindows, mapLimit, AGUI_READONLY_TOOLS, AGUI_PARALLEL_TOOLS } from './agui-windows'

const call = (name: string) => ({ function: { name } })

describe('partitionAguiWindows', () => {
  it('groups a contiguous run of read-only calls into one parallel window', () => {
    const w = partitionAguiWindows([call('read_file'), call('list_dir'), call('search_files')])
    expect(w).toEqual([{ kind: 'parallel', indices: [0, 1, 2] }])
  })

  it('emits a single read-only call as serial (no Promise.all overhead)', () => {
    const w = partitionAguiWindows([call('read_file')])
    expect(w).toEqual([{ kind: 'serial', index: 0 }])
  })

  it('a write breaks the run and stays serial + ordered', () => {
    const w = partitionAguiWindows([call('read_file'), call('write_file'), call('list_dir')])
    expect(w).toEqual([
      { kind: 'serial', index: 0 },
      { kind: 'serial', index: 1 },
      { kind: 'serial', index: 2 }
    ])
  })

  it('parallel run resumes after a serial barrier', () => {
    const w = partitionAguiWindows([
      call('read_file'),
      call('list_dir'), // 0,1 parallel
      call('run_command'), // 2 serial barrier
      call('search_files'),
      call('glob_files') // 3,4 parallel
    ])
    expect(w).toEqual([
      { kind: 'parallel', indices: [0, 1] },
      { kind: 'serial', index: 2 },
      { kind: 'parallel', indices: [3, 4] }
    ])
  })

  it('all-serial (mutating) round produces per-call serial windows in order', () => {
    const w = partitionAguiWindows([call('write_file'), call('edit_file'), call('delete_file')])
    expect(w).toEqual([
      { kind: 'serial', index: 0 },
      { kind: 'serial', index: 1 },
      { kind: 'serial', index: 2 }
    ])
  })

  it('empty round → no windows', () => {
    expect(partitionAguiWindows([])).toEqual([])
  })

  it('gated / mutating tools are NOT in the read-only set', () => {
    for (const t of ['run_command', 'start_command', 'delete_file', 'move_file', 'spawn_agent', 'write_file', 'edit_file', 'create_dir', 'write_todos', 'render_artifact', 'stop_command']) {
      expect(AGUI_READONLY_TOOLS.has(t)).toBe(false)
    }
  })

  it('every index appears exactly once, in order, across all windows', () => {
    const calls = [call('read_file'), call('write_file'), call('list_dir'), call('search_files'), call('run_command')]
    const w = partitionAguiWindows(calls)
    const flat = w.flatMap((win) => (win.kind === 'parallel' ? win.indices : [win.index]))
    expect(flat).toEqual([0, 1, 2, 3, 4])
  })

  it('spawn_agent is parallel-safe (fan-out) — a run of spawns groups into one window', () => {
    expect(AGUI_PARALLEL_TOOLS.has('spawn_agent')).toBe(true)
    expect(AGUI_READONLY_TOOLS.has('spawn_agent')).toBe(false) // not a read
    const w = partitionAguiWindows([call('spawn_agent'), call('spawn_agent'), call('spawn_agent')])
    expect(w).toEqual([{ kind: 'parallel', indices: [0, 1, 2] }])
  })

  it('spawn_agent windows can mix with reads and still break on a mutation', () => {
    const w = partitionAguiWindows([call('spawn_agent'), call('read_file'), call('write_file'), call('spawn_agent')])
    expect(w).toEqual([
      { kind: 'parallel', indices: [0, 1] },
      { kind: 'serial', index: 2 },
      { kind: 'serial', index: 3 }
    ])
  })
})

describe('mapLimit — bounded concurrency, order preserved', () => {
  it('preserves output order regardless of completion order', async () => {
    const delays = [30, 5, 20, 1]
    const out = await mapLimit(delays, 2, (d, i) => new Promise<number>((r) => setTimeout(() => r(i * 10), d)))
    expect(out).toEqual([0, 10, 20, 30])
  })

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0
    let peak = 0
    await mapLimit([1, 2, 3, 4, 5, 6], 2, async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return null
    })
    expect(peak).toBeLessThanOrEqual(2)
  })

  it('empty input → empty output', async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([])
  })
})
