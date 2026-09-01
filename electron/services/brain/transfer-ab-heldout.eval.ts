/**
 * LIVE MOAT EVAL — what was the circular rubric worth?
 *
 * Run: npx vitest run --config vitest.eval.config.ts electron/services/brain/transfer-ab-heldout.eval.ts
 *
 * WHY THIS EXISTS. Until 2026-08-01 `makeTransferDeps` handed the blind judge
 * `buildOperatorGrounding()` — the GROUNDED arm's own prompt — as its scoring rubric. It ran daily
 * from 2026-07-25 and reported 31-1 for the moat. That is what the construction predicts, not what
 * it discovered. `5d452c1` replaced it with a HELD-OUT rubric (human rulings only, and the endorsed
 * facts are withheld from the grounded arm).
 *
 * This measures the size of that bias, by grading ONE set of answers TWICE:
 *   HELD-OUT  the shipped fix — rubric = selectHumanRubric(), grounded arm loses those facts
 *   CIRCULAR  the pre-fix behaviour — rubric = the grounded arm's full grounding, nothing withheld
 *
 * The two arms share the SAME answers and the SAME slot assignment, so the ONLY difference is the
 * judge's rubric. Answer-model variance is exactly zero between arms; the delta is the bias.
 *
 * FIDELITY. Real operator model (scratch COPY of the live store — same 9 promoted+human /
 * 6 vetoed+human rulings, rubric size 15), real buildOperatorGrounding (operator block + style
 * fingerprint + calibration rates), real selectHumanRubric/withoutFacts, real
 * DEFAULT_TRANSFER_QUERIES, real runTransferAB loop, real aggregateFitLift. The ONE substitution is
 * the HTTP transport: chatOnce needs the Electron keychain, so answers and judgments go to the same
 * Zhipu endpoint registry.ts would reach, with the same model and params.
 *
 * DETERMINISM. The slot coin is seeded per (query, index) rather than Math.random, so the grounded
 * answer sits in the same slot for both arms and a re-run reproduces the assignment.
 *
 * ISOLATION: userData is a COPY in a scratch dir. Never opens the live store, never appends to
 * transfer-ab-history.jsonl (that is the daily tick's file — this is a measurement, not a run of
 * record). Nothing here writes live state.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { readFileSync, appendFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const SCRATCH = process.env.DUIN_EVAL_SCRATCH ?? join(tmpdir(), 'duin-eval-scratch')
const UD = join(SCRATCH, 'ud')
const VAULT = join(SCRATCH, 'vault')

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

import {
  runTransferAB,
  aggregateFitLift,
  buildOperatorGrounding,
  selectHumanRubric,
  withoutFacts,
  DEFAULT_TRANSFER_QUERIES,
  type Preference,
  type TransferDeps,
  type FitVerdict
} from './transfer-ab'
import { getOperatorFacts, setOperatorModelPath } from './operator-model'

import { zhipuKey, ZHIPU_BASE } from './__fixtures__/eval-harness'
const MODEL = 'glm-4.5-airx'
const LOG = join(SCRATCH, 'transfer-ab-heldout-eval.log')

function say(line: string): void {
  console.log(line)
  try {
    appendFileSync(LOG, line + '\n')
  } catch {
    /* best-effort */
  }
}


let apiCalls = 0
let rateLimitHits = 0
let lastCallAt = 0

/** glm-4.5-airx trips this account's rate limit under rapid sequential calls (429
 *  "您的账户已达到速率限制"). Space calls out and back off hard — a throttled run that finishes
 *  beats a fast one that dies at query 14. */
const MIN_GAP_MS = 900
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function throttle(): Promise<void> {
  const wait = lastCallAt + MIN_GAP_MS - Date.now()
  if (wait > 0) await sleep(wait)
  lastCallAt = Date.now()
}

/** A single non-streaming completion. Mirrors what chatOnce would send for this descriptor. */
function chat(key: string) {
  return async (system: string, user: string, maxTokens = 900): Promise<string> => {
    let lastErr = ''
    for (let attempt = 0; attempt < 7; attempt++) {
      await throttle()
      apiCalls++
      try {
        const res = await fetch(`${ZHIPU_BASE}chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model: MODEL,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user }
            ],
            thinking: { type: 'disabled' },
            max_tokens: maxTokens
          })
        })
        if (!res.ok) {
          lastErr = `HTTP ${res.status}`
          if (res.status === 429 || res.status >= 500) {
            if (res.status === 429) rateLimitHits++
            // exponential, starting well above the burst window: 4s, 8s, 16s, 32s, 64s, 128s
            await sleep(4000 * 2 ** attempt)
            continue
          }
          throw new Error(`${lastErr}: ${(await res.text()).slice(0, 300)}`)
        }
        const json = (await res.json()) as {
          choices?: { message?: { content?: string; reasoning_content?: string } }[]
        }
        const m = json.choices?.[0]?.message ?? {}
        return m.content || m.reasoning_content || ''
      } catch (err) {
        lastErr = (err as Error).message
        await sleep(2000 * (attempt + 1))
      }
    }
    throw new Error(`provider failed after retries: ${lastErr}`)
  }
}

/** Deterministic slot coin — same assignment for both arms and across re-runs. */
function seededCoin(query: string, index: number): boolean {
  let h = 2166136261
  const s = `${index}:${query}`
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) & 1) === 0
}

const parsePreference = (raw: string): Preference => {
  const t = raw.trim().toLowerCase()
  if (/^a\b/.test(t)) return 'A'
  if (/^b\b/.test(t)) return 'B'
  if (/\btie\b/.test(t)) return 'tie'
  return 'inconclusive'
}

describe('transfer-ab — held-out vs circular rubric', () => {
  const key = zhipuKey(UD)
  beforeAll(() => {
    setOperatorModelPath(UD) // takes the userData DIR, not the file path
  })

  it('grades one set of answers under both rubrics and reports the bias', async () => {
    if (!key) {
      say('SKIP — no zhipu key in scratch ud/keys.json')
      return
    }
    const send = chat(key)
    const facts = getOperatorFacts()
    const rubric = selectHumanRubric(facts)
    const fullGrounding = buildOperatorGrounding(VAULT)
    const heldOutGrounding = withoutFacts(fullGrounding, rubric.endorsedFacts)

    say('='.repeat(78))
    say(`transfer-ab held-out eval · ${new Date().toISOString()}`)
    say(`operator facts: ${facts.length}`)
    say(`rubric: ${rubric.endorsedFacts.length} endorsed + ${rubric.rejectedFacts.length} rejected = ${rubric.size}`)
    say(`grounding: full ${fullGrounding.length} chars → held-out ${heldOutGrounding.length} chars ` +
        `(withheld ${fullGrounding.length - heldOutGrounding.length})`)
    say(`queries: ${DEFAULT_TRANSFER_QUERIES.length}`)
    expect(rubric.text).not.toBe('') // enough human rulings to grade with

    // The held-out rubric must not leak into the grounded arm — assert, do not assume.
    for (const f of rubric.endorsedFacts) expect(heldOutGrounding).not.toContain(`- ${f}`)

    // ── phase 1: generate answers ONCE (grounded uses the held-out grounding — the shipped arm) ──
    const answers = new Map<string, { grounded: string; cold: string }>()
    for (const q of DEFAULT_TRANSFER_QUERIES) {
      const grounded = await send(
        `You are assisting a specific operator. Honor their profile, taste, and calibration when you answer:\n\n${heldOutGrounding}`,
        q
      )
      const cold = await send('Answer the request normally.', q)
      answers.set(q, { grounded, cold })
      say(`  answered: ${q.slice(0, 62)}…  (g=${grounded.length}c cold=${cold.length}c)`)
    }

    // ── phase 2: judge the SAME answers under each rubric ──
    const judgeWith = (rubricText: string, label: string): TransferDeps => ({
      grounding: () => heldOutGrounding,
      answer: (q, g) => (g === null ? (answers.get(q)?.cold ?? '') : (answers.get(q)?.grounded ?? '')),
      coin: seededCoin,
      async judge(query, a, b) {
        const raw = await send(
          'Two assistants answered the same operator request. Using the operator ' +
            (label === 'HELD-OUT' ? 'rulings' : 'profile') +
            ' below as the rubric, decide which answer FITS THIS OPERATOR better (their voice, ' +
            'priorities, and taste). Reply with exactly "A", "B", or "tie" — no explanation.\n\n' +
            rubricText,
          `REQUEST: ${query}\n\n--- ANSWER A ---\n${a}\n\n--- ANSWER B ---\n${b}`,
          16
        )
        return parsePreference(raw)
      }
    })

    const heldOut = await runTransferAB(DEFAULT_TRANSFER_QUERIES, judgeWith(rubric.text, 'HELD-OUT'))
    // CIRCULAR reproduces the pre-fix judge exactly: rubric === the grounded arm's own prompt.
    const circular = await runTransferAB(DEFAULT_TRANSFER_QUERIES, judgeWith(fullGrounding, 'CIRCULAR'))

    const line = (name: string, r: { withMoatWins: number; coldWins: number; ties: number; inconclusive: number; decided: number; fitLift: number | null; verdict: string }): void =>
      say(
        `  ${name.padEnd(9)} moat ${String(r.withMoatWins).padStart(2)} · cold ${String(r.coldWins).padStart(2)} · ` +
          `tie ${String(r.ties).padStart(2)} · inconc ${String(r.inconclusive).padStart(2)} · ` +
          `decided ${String(r.decided).padStart(2)} · fitLift ${r.fitLift === null ? 'null' : String(r.fitLift).padStart(3)} · ${r.verdict}`
      )

    say('-'.repeat(78))
    line('HELD-OUT', heldOut)
    line('CIRCULAR', circular)

    // Per-query disagreement — where the rubric alone flipped the verdict.
    let flips = 0
    for (const h of heldOut.verdicts) {
      const c = circular.verdicts.find((x) => x.query === h.query)
      if (c && c.verdict !== h.verdict) {
        flips++
        say(`  FLIP  circular=${c.verdict.padEnd(11)} heldout=${h.verdict.padEnd(11)} :: ${h.query.slice(0, 54)}…`)
      }
    }
    say(`  rubric-only verdict flips: ${flips}/${heldOut.verdicts.length}`)
    const biasPp =
      ((circular.withMoatWins - circular.coldWins) - (heldOut.withMoatWins - heldOut.coldWins))
    say(`  BIAS (circular fitLift − held-out fitLift): ${biasPp} comparisons`)
    say(`  api calls: ${apiCalls} (429 retries: ${rateLimitHits})`)
    say('='.repeat(78))

    // The eval's own guard: both arms graded the same answers, so samples must match.
    expect(heldOut.samples).toBe(DEFAULT_TRANSFER_QUERIES.length)
    expect(circular.samples).toBe(DEFAULT_TRANSFER_QUERIES.length)
    // Sanity: aggregate is a pure function of the verdicts it was given.
    expect(aggregateFitLift(heldOut.verdicts.map((v) => v.verdict) as FitVerdict[]).fitLift).toBe(heldOut.fitLift)
  })
})
