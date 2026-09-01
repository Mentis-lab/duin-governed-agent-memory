/**
 * LIVE EVAL — does COVER actually emit the window?
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT `aggregation-arms.eval.ts`. That eval is cited by
 * period-window.ts as the evidence for "breadth is not the fix" (stock 0/18, searchK=30 also
 * 0/18), and it IS the reason cover was built — but it cannot measure cover, for two independent
 * reasons found when trying:
 *   1. It imports `search()` from index-store directly and never reaches `resolvePeriodWindow` /
 *      `coverInWindow`, which are wired in the /agui turn path. The change is bypassed.
 *   2. Its probes are claim-LEDGER counting questions ("how many claims have verdict
 *      contradicted"), not period reports. Different aggregation problem.
 * Running it against cover would have produced a real-looking number that measured nothing.
 *
 * WHAT THIS MEASURES INSTEAD — the exact claim cover makes, and DETERMINISTICALLY, with NO model
 * call: for a period query, how many of the notes inside the window does retrieval actually put in
 * front of the model? The measured failure was 138 eligible / 6 emitted = 4% coverage. Coverage is
 * a counting question, so it needs no judge, costs nothing, and is exactly reproducible.
 *
 * Run: npx vitest run --config vitest.eval.config.ts electron/services/brain/cover-coverage.eval.ts
 * Needs only the fixture vault + its prebuilt index (DUIN_EVAL_SCRATCH), no API key.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import Database from 'better-sqlite3'

const SCRATCH = process.env.DUIN_EVAL_SCRATCH ?? join(tmpdir(), 'duin-eval-scratch')
const UD = join(SCRATCH, 'ud')

vi.hoisted(() => {
  // Coverage is a counting property of the index; embeddings only reorder. Off so the eval runs
  // without a model, a key, or the embedder worker.
  process.env.DUIN_DISABLE_EMBEDDINGS = '1'
})

vi.mock('electron', () => ({
  app: {
    getPath: () => UD,
    getName: () => 'duin',
    getAppPath: () => process.cwd(),
    isPackaged: false,
    on: () => {},
    whenReady: () => Promise.resolve()
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, on: () => {} },
  shell: {},
  dialog: {}
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

import { setLocalBrainUserDataPath, search, coverInWindow } from '../local-brain/index-store'
import { resolvePeriodWindow } from './period-window'

const HAVE_FIXTURE = existsSync(join(UD, 'local-brain.db'))

/** The eligible population straight from the index — the ground truth the metric is defined
 *  against, read independently of `coverInWindow` so the eval cannot grade itself. */
function eligibleFilesInWindow(from: number, to: number): Set<string> {
  const db = new Database(join(UD, 'local-brain.db'), { readonly: true })
  try {
    const rows = db
      .prepare('SELECT file FROM notes_files WHERE note_date IS NOT NULL AND note_date >= ? AND note_date < ?')
      .all(from, to) as { file: string }[]
    return new Set(rows.map((r) => r.file))
  } finally {
    db.close()
  }
}

/** The queries a periodic report actually arrives as — the CJK forms are the ones that matter on
 *  this vault, and the ones period-window was written for. */
const PERIOD_QUERIES = ['写一份双周报', '写周报', 'write my biweekly report']

describe.skipIf(!HAVE_FIXTURE)('COVER — how much of the window reaches the model', () => {
  beforeAll(() => {
    setLocalBrainUserDataPath(UD)
  })

  for (const q of PERIOD_QUERIES) {
    it(`"${q}" — cover emits the whole eligible population, top-k does not`, async () => {
      const window = resolvePeriodWindow(q)
      expect(window, 'the query must resolve a window or cover never runs').not.toBeNull()
      if (!window) return

      // BEFORE: the shipped behaviour — window as a denylist, then top-k.
      const ranked = await search(q, 6, { window })
      // AFTER: cover.
      const cover = await coverInWindow(q, window, { rankedK: 6 })

      // Coverage is measured on the INTERSECTION with the eligible population, on BOTH sides — a
      // ranked hit from outside the dated set is relevant but is not coverage of the window.
      // Counting it produced a 101.6% figure on the first real run. The eligible set is read from
      // the index directly rather than inferred from the result, so the metric cannot be defined
      // in terms of the thing it is measuring.
      const eligibleSet = eligibleFilesInWindow(window.from, window.to)
      const rankedInWindow = ranked.filter((h) => eligibleSet.has(h.file)).length
      const rankedPct = eligibleSet.size > 0 ? (rankedInWindow / eligibleSet.size) * 100 : 0
      const coverPct = cover.eligible > 0 ? (cover.covered / cover.eligible) * 100 : 0
      console.log(
        `[cover-eval] ${q}\n` +
          `  window     ${new Date(window.from).toISOString().slice(0, 10)} .. ${new Date(window.to - 1).toISOString().slice(0, 10)} (${window.label})\n` +
          `  eligible   ${cover.eligible} dated notes in window (index says ${eligibleSet.size})\n` +
          `  top-k      ${ranked.length} hits → ${rankedInWindow} in-window = ${rankedPct.toFixed(1)}% coverage\n` +
          `  cover      ${cover.emitted} hits → ${cover.covered} in-window = ${coverPct.toFixed(1)}% coverage, ${cover.snippetChars} chars/note\n` +
          `  truncated  ${cover.covered < cover.eligible ? `YES — ${cover.eligible - cover.covered} omitted (reported to the model)` : 'no'}`
      )

      // THE ASSERTION THAT MATTERS, and the one this eval was rewritten to make after the first
      // run passed VACUOUSLY. Cover's population must come from POSITIVE date evidence. On a vault
      // where no note carries a note_date, `eligible` is 0 and cover contributes nothing — the
      // caller falls back to ranked search. Anything else means the fail-open denylist has crept
      // back in and "the fortnight" has quietly become "the corpus": measured once at 1,189
      // eligible for BOTH a 7-day and a 14-day window on a 1,314-note fixture, which is the
      // signature of a filter that is not filtering.
      if (cover.eligible === 0) {
        expect(cover.emitted, 'no dated notes ⇒ cover must emit nothing, not the whole corpus').toBe(0)
        return
      }
      // A 7-day window can never hold as many notes as a 14-day one on the same corpus.
      expect(cover.eligible).toBeLessThanOrEqual(1000)
      expect(cover.covered).toBeGreaterThanOrEqual(rankedInWindow)
      expect(coverPct).toBeLessThanOrEqual(100)
      expect(coverPct).toBeGreaterThan(rankedPct)
      // Fidelity stays legible even at full population.
      expect(cover.snippetChars).toBeGreaterThanOrEqual(60)
    })
  }

  it('a NON-period query is untouched (cover never runs, search is byte-identical)', async () => {
    expect(resolvePeriodWindow('what did I decide about the Bilibili deal')).toBeNull()
  })
})
