// Durable per-event journal for one /agui turn.
//
// THE HOLE THIS CLOSES. The turn loop kept its entire history in memory: `RunState` is an explicit
// no-I/O ring (bounded at 2000 frames / 4MB) inside a 64-entry in-process Map that is dropped when
// the run ends. Every terminal emit is additionally guarded on `!turnAbort.signal.aborted`. So
// hitting Stop — or losing the client — after twenty minutes of tool work left NO record that the
// turn ever happened: no transcript, no tool results, no round count, nothing to resume from or
// diagnose with. That was the single largest durability gap on the chat path.
//
// THE CONSTRAINT THAT SHAPES THIS FILE. The one seam every frame passes through (`sseFrame`) is
// also the hot path for every content delta, and it runs on the Electron MAIN thread, which also
// serves window input. A synchronous append — let alone an fsync — per delta would re-create the
// page-open freezes that the 2026-08 perf work spent weeks removing. So:
//   · high-volume deltas (TEXT_MESSAGE_CONTENT, REASONING) are NEVER journalled individually —
//     their content is reconstructable from the accumulated answer, which IS journalled at the
//     terminal, so nothing meaningful is lost;
//   · everything else is buffered in memory and flushed ASYNCHRONOUSLY, so the hot path costs one
//     array push and nothing else;
//   · every operation is best-effort: a journal failure can never fail, delay, or alter a turn.
//
// Written to userData, never into the vault — a vault write would re-arm the notes-watcher and
// rebuild the feedback loop that background-work-gate.ts exists to prevent.

import { app } from 'electron'
import { appendFile, mkdir, readdir, readFile, stat, rm } from 'fs/promises'
import { join } from 'path'

/** Frame types whose per-event volume makes them unjournalable on the hot path. Their content is
 *  recovered from the terminal record's accumulated answer. */
const HIGH_VOLUME = new Set(['TEXT_MESSAGE_CONTENT', 'REASONING'])

/** Flush once the buffer reaches this many records, so a long tool-heavy turn lands incrementally
 *  instead of holding everything until the end (the point is surviving an abrupt end). */
const FLUSH_AT = 25

/** Journals older than this are pruned at startup. A turn journal is a diagnostic, not an archive. */
const RETAIN_MS = 7 * 24 * 60 * 60 * 1000

/** `DUIN_TURN_JOURNAL=0` disables journalling entirely. */
export function journalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DUIN_TURN_JOURNAL !== '0'
}

/** PURE. Should this frame be journalled individually? */
export function shouldJournalFrame(type: unknown): boolean {
  return typeof type === 'string' && type.length > 0 && !HIGH_VOLUME.has(type)
}

export interface TurnJournal {
  /** Buffer one frame. Cheap by contract — called from the SSE hot path. */
  note(frame: Record<string, unknown>): void
  /** Final record + flush. Never throws. */
  close(outcome: Record<string, unknown>): Promise<void>
}

const NOOP: TurnJournal = { note: () => {}, close: async () => {} }

function journalDir(): string {
  return join(app.getPath('userData'), 'agui-journal')
}

/**
 * Open a journal for one turn. Returns a no-op journal when disabled or when the electron `app`
 * is unavailable (vitest, headless), so callers need no branch of their own.
 */
export function openTurnJournal(runId: string, meta: Record<string, unknown> = {}): TurnJournal {
  if (!journalEnabled()) return NOOP
  let dir: string
  let file: string
  try {
    dir = journalDir()
    file = join(dir, `${runId}.jsonl`)
  } catch {
    return NOOP // no app/userData (tests, headless) — journalling is not worth a branch upstream
  }

  const buf: string[] = []
  let seq = 0
  let flushing: Promise<void> = Promise.resolve()
  let dirReady = false

  const line = (rec: Record<string, unknown>): string => {
    try {
      return JSON.stringify({ seq: ++seq, at: Date.now(), ...rec })
    } catch {
      // A frame carrying a circular or non-serializable payload must not take the turn down.
      return JSON.stringify({ seq, at: Date.now(), type: 'unserializable' })
    }
  }

  /** Chained so appends can never interleave and reorder the file. Always resolves. */
  const flush = (): Promise<void> => {
    if (buf.length === 0) return flushing
    const chunk = buf.splice(0, buf.length).join('\n') + '\n'
    flushing = flushing
      .then(async () => {
        if (!dirReady) {
          await mkdir(dir, { recursive: true })
          dirReady = true
        }
        await appendFile(file, chunk, 'utf8')
      })
      .catch(() => {
        /* best-effort: a full disk or a locked file must never surface into the turn */
      })
    return flushing
  }

  buf.push(line({ type: 'TURN_START', runId, ...meta }))

  return {
    note(frame) {
      try {
        if (!shouldJournalFrame(frame?.type)) return
        buf.push(line(frame))
        if (buf.length >= FLUSH_AT) void flush()
      } catch {
        /* never throw into sseFrame */
      }
    },
    async close(outcome) {
      try {
        buf.push(line({ type: 'TURN_END', ...outcome }))
        await flush()
      } catch {
        /* best-effort */
      }
    }
  }
}

/** One turn's summary, as recovered from its journal file. */
export interface TurnJournalSummary {
  runId: string
  at: number
  threadId?: unknown
  model?: unknown
  /** From the TURN_END record; absent when the process died before it could be written. */
  end?: Record<string, unknown>
  /** Journalled (non-delta) frame count — a rough measure of how much the turn did. */
  frames: number
  /** True when there is no TURN_END: the app was killed mid-turn. The most interesting case. */
  incomplete: boolean
}

/**
 * Read back the most recent turn journals, newest first.
 *
 * A journal nobody can read is the defect this whole change set exists to remove — writing one and
 * leaving it undiscoverable would repeat it. Served by `GET /debug/turns` and cheap by design: it
 * reads at most `limit` files and only their first and last records matter.
 */
export async function readRecentTurns(limit = 20): Promise<TurnJournalSummary[]> {
  const out: TurnJournalSummary[] = []
  try {
    const dir = journalDir()
    const names = (await readdir(dir)).filter((n) => n.endsWith('.jsonl'))
    const dated: { name: string; mtime: number }[] = []
    for (const name of names) {
      try {
        dated.push({ name, mtime: (await stat(join(dir, name))).mtimeMs })
      } catch {
        /* vanished under us */
      }
    }
    dated.sort((a, b) => b.mtime - a.mtime)
    for (const { name } of dated.slice(0, Math.max(1, limit))) {
      try {
        const rows = (await readFile(join(dir, name), 'utf8'))
          .split('\n')
          .filter(Boolean)
          .map((l) => {
            try {
              return JSON.parse(l) as Record<string, unknown>
            } catch {
              return null // a torn tail from a kill mid-write is expected, not an error
            }
          })
          .filter((r): r is Record<string, unknown> => r !== null)
        if (rows.length === 0) continue
        const start = rows[0]
        const end = rows.at(-1)?.type === 'TURN_END' ? rows.at(-1) : undefined
        out.push({
          runId: name.replace(/\.jsonl$/, ''),
          at: Number(start.at ?? 0),
          threadId: start.threadId,
          model: start.model,
          end,
          frames: rows.length,
          incomplete: !end
        })
      } catch {
        /* an unreadable journal is skipped, never fatal */
      }
    }
  } catch {
    /* no directory yet */
  }
  return out
}

/**
 * Delete journals older than the retention window. Best-effort, fire-and-forget: called once at
 * brain start so the directory cannot grow without bound. Returns how many were removed (tests).
 */
export async function pruneTurnJournals(now: number = Date.now()): Promise<number> {
  let removed = 0
  try {
    const dir = journalDir()
    const names = await readdir(dir)
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const p = join(dir, name)
      try {
        const s = await stat(p)
        if (now - s.mtimeMs > RETAIN_MS) {
          await rm(p, { force: true })
          removed++
        }
      } catch {
        /* a file that vanished under us is already the desired state */
      }
    }
  } catch {
    /* no directory yet — nothing to prune */
  }
  return removed
}
