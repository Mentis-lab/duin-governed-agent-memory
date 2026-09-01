// `listPolicyUsage` — what a standing permission grant has actually DONE since you gave it.
//
// This EXECUTES the SQL. The sibling event-log.test.ts calls `__forceMemoryFallback()` in
// beforeEach, so it never runs a line of the real query — and the real query is where all the
// risk in this function lives: a `json_extract` on the payload column, a conditional SUM, and an
// actor_kind filter that is the difference between "this grant decided 47 calls for you" and
// "you answered 47 prompts yourself". Getting any of the three wrong produces a plausible number
// on a security surface, which is worse than no number. So it runs against a real engine
// (Node's built-in `node:sqlite`) behind a mocked `./database`, mirroring
// event-log-busy-latch-node.test.ts.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

const state = vi.hoisted(() => ({ db: null as unknown }))

vi.mock('./database', () => ({
  getDb: () => state.db,
  transactional: <T,>(fn: () => T): T => fn(),
  withWriteRetry: <T,>(fn: () => T): T => fn()
}))

import { __resetEventLog, listPolicyUsage, recordEvent } from './event-log'

// Mirrors schema-init.ts's `events` segment.
const SCHEMA = `
  CREATE TABLE events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    severity TEXT NOT NULL DEFAULT 'info',
    conversation_id TEXT, project_id TEXT, workspace_path TEXT,
    automation_id TEXT, tool_call_id TEXT, parent_event_id TEXT, correlation_id TEXT,
    actor_kind TEXT NOT NULL, actor_id TEXT, entity_kind TEXT, entity_id TEXT,
    payload_json TEXT NOT NULL, redaction TEXT NOT NULL DEFAULT 'metadata'
  );
`

function makeHandle(db: DatabaseSync): unknown {
  return {
    prepare(sql: string) {
      const stmt = db.prepare(sql)
      return {
        run: (...a: unknown[]) => ({ changes: Number(stmt.run(...(a as never[])).changes) }),
        all: (...a: unknown[]) => stmt.all(...(a as never[])),
        get: (...a: unknown[]) => stmt.get(...(a as never[]))
      }
    }
  }
}

/** One approval-gate decision, shaped exactly as permissions-store's emitApprovalEvent writes it. */
function approval(opts: {
  decision: 'allow' | 'deny'
  actorKind: 'user' | 'system'
  policyId?: string
  toolId?: string
}): void {
  recordEvent({
    type: opts.decision === 'allow' ? 'tool.call.approved' : 'tool.call.denied',
    actorKind: opts.actorKind,
    severity: opts.decision === 'allow' ? 'info' : 'warning',
    entityKind: 'tool',
    entityId: opts.toolId ?? 'shell_command',
    payload: { toolId: opts.toolId ?? 'shell_command', policyId: opts.policyId }
  })
}

let real: DatabaseSync

beforeEach(() => {
  __resetEventLog()
  real = new DatabaseSync(':memory:')
  real.exec(SCHEMA)
  state.db = makeHandle(real)
})

describe('listPolicyUsage', () => {
  it('counts the calls one policy decided on its own', () => {
    approval({ decision: 'allow', actorKind: 'system', policyId: 'p1' })
    approval({ decision: 'allow', actorKind: 'system', policyId: 'p1' })
    approval({ decision: 'allow', actorKind: 'system', policyId: 'p2' })

    const rows = listPolicyUsage()
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.policyId === 'p1')?.n).toBe(2)
    expect(rows.find((r) => r.policyId === 'p2')?.n).toBe(1)
  })

  it('EXCLUDES decisions a human made — the count means "acted for you"', () => {
    // The number a user reads as "this grant fired 3 times" must never include prompts
    // they answered themselves. emitApprovalEvent stamps policyId on the no-human branch
    // only; the actor filter is the second lock on the same door.
    approval({ decision: 'allow', actorKind: 'user', policyId: 'p1' })
    approval({ decision: 'allow', actorKind: 'user', policyId: 'p1' })
    approval({ decision: 'allow', actorKind: 'system', policyId: 'p1' })

    const rows = listPolicyUsage()
    expect(rows).toHaveLength(1)
    expect(rows[0].n).toBe(1)
  })

  it('reports denies separately — a policy silently BLOCKING work is not an idle one', () => {
    approval({ decision: 'allow', actorKind: 'system', policyId: 'p1' })
    approval({ decision: 'deny', actorKind: 'system', policyId: 'p1' })
    approval({ decision: 'deny', actorKind: 'system', policyId: 'p1' })

    const [row] = listPolicyUsage()
    expect(row.n).toBe(3)
    expect(row.denied).toBe(2)
  })

  it('ignores approval events that carry no policy (the human + full-access branches)', () => {
    approval({ decision: 'allow', actorKind: 'system' })
    approval({ decision: 'allow', actorKind: 'user' })
    expect(listPolicyUsage()).toEqual([])
  })

  it('ignores unrelated event types that happen to carry a policyId', () => {
    recordEvent({
      type: 'tool.call.completed',
      actorKind: 'system',
      payload: { policyId: 'p1' }
    })
    expect(listPolicyUsage()).toEqual([])
  })

  it('reports the MOST RECENT decision time, not the first', () => {
    approval({ decision: 'allow', actorKind: 'system', policyId: 'p1' })
    const first = listPolicyUsage()[0].lastAt
    // recordEvent stamps Date.now(); force a later row rather than sleeping.
    real
      .prepare(
        `INSERT INTO events (id, type, created_at, severity, actor_kind, payload_json)
         VALUES ('later', 'tool.call.approved', ?, 'info', 'system', '{"policyId":"p1"}')`
      )
      .run(first + 60_000)

    const [row] = listPolicyUsage()
    expect(row.n).toBe(2)
    expect(row.lastAt).toBe(first + 60_000)
  })

  it('is a GROUP BY, so it is not truncated by the list-row cap', () => {
    // MAX_LIST_LIMIT clamps listEvents to 1000 rows. A grant that fired more often than
    // that must still report its true total — the whole reason this is an aggregate and
    // not a count of listEvents().
    const rows: string[] = []
    for (let i = 0; i < 1200; i++) {
      rows.push(
        `('e${i}', 'tool.call.approved', ${1_000_000 + i}, 'info', 'system', '{"policyId":"p1"}')`
      )
    }
    real.exec(
      `INSERT INTO events (id, type, created_at, severity, actor_kind, payload_json) VALUES ${rows.join(',')}`
    )
    expect(listPolicyUsage()[0].n).toBe(1200)
  })

  it('returns nothing on an empty log rather than throwing', () => {
    expect(listPolicyUsage()).toEqual([])
  })
})
