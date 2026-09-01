import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  enqueue,
  dequeue,
  reconcile,
  remainingMs,
  isExpired,
  buildAnswer,
  isTextEntryTarget,
  queuePositionLabel,
  otherIndex,
  type AskUserAwaitingEvent,
  type AskUserQueueEntry
} from './ask-user-queue'

// U11 — the agent-question modal lost answers four ways. The renderer env is
// node-only (no jsdom), so the logic is asserted directly and the component's
// use of it is source-locked (ToolApprovalModal.wiring.test.ts pattern).

const root = join(__dirname, '..', '..', '..')
const read = (p: string): string => readFileSync(join(root, p), 'utf-8')

const T0 = 1_700_000_000_000

function ev(id: string, over: Partial<AskUserAwaitingEvent> = {}): AskUserAwaitingEvent {
  return {
    requestId: id,
    question: `question ${id}`,
    header: id,
    options: [{ label: 'alpha' }, { label: 'beta' }],
    multiSelect: false,
    timeoutMs: 30_000,
    askedAt: T0,
    ...over
  }
}

describe('queue — two concurrent questions (U11a)', () => {
  // AskUserRuntime is a Map and has a second producer (workflows.ts). The
  // renderer held ONE useState slot, so question 2 destroyed question 1 and
  // its caller blocked until timeout.
  it('keeps both questions instead of overwriting the first', () => {
    const q = enqueue(enqueue([], ev('a')), ev('b'))
    expect(q.map((e) => e.requestId)).toEqual(['a', 'b'])
  })

  it('shows "1 of 2" and reveals the second after the first is answered', () => {
    let q = enqueue(enqueue([], ev('a')), ev('b'))
    expect(queuePositionLabel(0, q.length)).toBe('1 of 2')
    q = dequeue(q, 'a')
    expect(q.map((e) => e.requestId)).toEqual(['b'])
    // One left: nothing to disambiguate, so no chip.
    expect(queuePositionLabel(0, q.length)).toBeNull()
  })

  it('does not duplicate a re-broadcast of the same requestId', () => {
    const q = enqueue(enqueue([], ev('a')), ev('a'))
    expect(q).toHaveLength(1)
  })

  it('lets a live event replace a hydrated stub, gaining the real options', () => {
    const stub = reconcile([], [{ requestId: 'a', question: 'q', header: 'h', askedAt: T0 }])
    expect(stub[0].options).toEqual([])
    const q = enqueue(stub, ev('a'))
    expect(q).toHaveLength(1)
    expect(q[0].options.map((o) => o.label)).toEqual(['alpha', 'beta'])
    expect(q[0].hydrated).toBeUndefined()
  })
})

describe('reconcile against ask-user:list', () => {
  it('re-adds questions the renderer never saw (reload mid-ask)', () => {
    const q = reconcile([], [{ requestId: 'z', question: 'still waiting?', header: 'z', askedAt: T0 }])
    expect(q).toHaveLength(1)
    expect(q[0].hydrated).toBe(true)
    // Unknown deadline — must not be rendered as a countdown, and must not be
    // treated as already expired.
    expect(q[0].timeoutMs).toBeNull()
    expect(remainingMs(q[0], T0 + 10_000_000)).toBeNull()
    expect(isExpired(q[0], T0 + 10_000_000)).toBe(false)
  })

  it('drops local entries the runtime no longer holds', () => {
    const local = enqueue([], ev('gone'))
    expect(reconcile(local, [])).toEqual([])
  })

  it('a hydrated stub still has a usable free-text path', () => {
    const [stub] = reconcile([], [{ requestId: 'z', question: 'q', header: 'z', askedAt: T0 }])
    expect(otherIndex(stub)).toBe(0)
    const answer = buildAnswer({
      entry: stub,
      focusIdx: 0,
      picked: new Set(),
      otherText: 'typed recovery answer',
      notes: ''
    })
    expect(answer).toEqual({ kind: 'single', label: 'typed recovery answer', header: 'z' })
  })
})

describe('expiry (U11b)', () => {
  const entry: AskUserQueueEntry = { ...ev('a'), timeoutMs: 30_000 }

  it('counts down against the ask time, not a mount-relative timer', () => {
    expect(remainingMs(entry, T0)).toBe(30_000)
    expect(remainingMs(entry, T0 + 10_000)).toBe(20_000)
  })

  it('is expired at and past the deadline, and never goes negative', () => {
    expect(isExpired(entry, T0 + 29_999)).toBe(false)
    expect(isExpired(entry, T0 + 30_000)).toBe(true)
    expect(remainingMs(entry, T0 + 90_000)).toBe(0)
  })
})

describe('buildAnswer — multi-select "Other..." (U11c)', () => {
  const multi: AskUserQueueEntry = { ...ev('a', { multiSelect: true }) }

  it('carries the typed answer when Other... is picked', () => {
    // The whole defect: clicking "Other..." used to only move focus, so this
    // came back with no trace of what the user typed.
    const answer = buildAnswer({
      entry: multi,
      focusIdx: 2,
      picked: new Set([2]),
      otherText: 'my own answer',
      notes: ''
    })
    expect(answer).toEqual({ kind: 'multi', labels: ['my own answer'], header: 'a' })
  })

  it('combines real options with Other..., in presentation order', () => {
    const answer = buildAnswer({
      entry: multi,
      focusIdx: 0,
      picked: new Set([2, 0]),
      otherText: 'extra',
      notes: 'note text'
    })
    expect(answer).toEqual({
      kind: 'multi',
      labels: ['alpha', 'extra'],
      header: 'a',
      notes: 'note text'
    })
  })

  it('ignores a picked-but-empty Other... rather than sending a blank label', () => {
    expect(
      buildAnswer({ entry: multi, focusIdx: 2, picked: new Set([2]), otherText: '   ', notes: '' })
    ).toBeNull()
  })

  it('returns null when nothing is picked, so Send is a no-op', () => {
    expect(
      buildAnswer({ entry: multi, focusIdx: 0, picked: new Set(), otherText: '', notes: '' })
    ).toBeNull()
  })
})

describe('buildAnswer — single select', () => {
  const single: AskUserQueueEntry = { ...ev('a') }

  it('sends the focused option', () => {
    expect(
      buildAnswer({ entry: single, focusIdx: 1, picked: new Set(), otherText: '', notes: '' })
    ).toEqual({ kind: 'single', label: 'beta', header: 'a' })
  })

  it('requires text before Other... can be sent', () => {
    expect(
      buildAnswer({ entry: single, focusIdx: 2, picked: new Set(), otherText: '', notes: '' })
    ).toBeNull()
  })

  it('refuses an out-of-range focus instead of throwing', () => {
    expect(
      buildAnswer({ entry: single, focusIdx: 99, picked: new Set(), otherText: '', notes: '' })
    ).toBeNull()
    expect(
      buildAnswer({ entry: single, focusIdx: -1, picked: new Set(), otherText: '', notes: '' })
    ).toBeNull()
  })
})

describe('isTextEntryTarget — the Space guard (U11c)', () => {
  it('claims the notes input, so Space types instead of toggling an option', () => {
    expect(isTextEntryTarget({ tagName: 'INPUT' })).toBe(true)
    expect(isTextEntryTarget({ tagName: 'TEXTAREA' })).toBe(true)
    expect(isTextEntryTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true)
  })

  it('matches the Enter branch by also consulting closest()', () => {
    expect(isTextEntryTarget({ tagName: 'SPAN', closest: () => ({}) })).toBe(true)
    expect(isTextEntryTarget({ tagName: 'SPAN', closest: () => null })).toBe(false)
  })

  it('does not claim option buttons or non-elements', () => {
    expect(isTextEntryTarget({ tagName: 'BUTTON' })).toBe(false)
    expect(isTextEntryTarget(null)).toBe(false)
    expect(isTextEntryTarget('input')).toBe(false)
  })
})

describe('AskUserModal wiring (source-lock)', () => {
  const src = read('src/components/chat/AskUserModal.tsx')

  it('holds a queue, not a single question slot', () => {
    expect(src).toMatch(/enqueue\(/)
    expect(src).toMatch(/dequeue\(/)
    expect(src).toMatch(/queuePositionLabel\(/)
  })

  it('hydrates in-flight questions from ask-user:list on mount', () => {
    expect(src).toMatch(/askUser\.list\(/)
    expect(src).toMatch(/reconcile\(/)
  })

  it('checks the { matched } flag instead of discarding the respond result', () => {
    expect(src).toMatch(/matched/)
  })

  it('renders an expired state rather than accepting a resolved question', () => {
    expect(src).toMatch(/isExpired\(/)
  })

  it('builds the answer through buildAnswer, so multi-select Other... is carried', () => {
    expect(src).toMatch(/buildAnswer\(/)
  })

  it('guards the Space branch the same way the Enter branch is guarded', () => {
    expect(src).toMatch(/isTextEntryTarget\(/)
    // The raw unguarded shape must be gone.
    expect(src).not.toMatch(/e\.key === ' '\)\s*\{\s*e\.preventDefault\(\)\s*setPicked/)
  })

  it('does not cancel a blocking question on a backdrop click (U11d)', () => {
    // Isolate the dialog element's own attributes: everything from the
    // aria-label up to the end of that opening tag.
    const m = src.match(/aria-label=(?:"Question from agent"|\{t\('Question from agent'\)\})[\s\S]*?>/)
    expect(m).not.toBeNull()
    expect(m![0]).not.toMatch(/onClick/)
  })
})
