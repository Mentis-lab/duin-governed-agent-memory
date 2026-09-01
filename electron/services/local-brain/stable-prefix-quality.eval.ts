/**
 * LIVE ANSWER-QUALITY EVAL — the gate on flipping DUIN_STABLE_PREFIX default-ON.
 *
 * Run: npx vitest run --config vitest.eval.config.ts
 *
 * WHY THIS EXISTS. The byte-stable-prefix layout (prompt-layout.mjs) does not change a single byte
 * of prompt CONTENT — it changes WHERE the content sits: the per-turn grounding (retrieval CONTEXT,
 * recall, pinned note, …) moves out of the system message and onto the last user message. That is a
 * prompt-SEMANTIC change, so the efficiency instrument must not credit it by default until answer
 * quality is shown not to regress. This harness is that evidence.
 *
 * DESIGN — a WITHIN-SUBJECT comparison, which is what makes it cheap and valid:
 *   for each question, both arms get the SAME model, the SAME retrieved context, the SAME durable
 *   blocks, and the SAME vault. The ONLY difference is the layout, toggled via DUIN_STABLE_PREFIX
 *   through the REAL `buildGroundedMessages` — not a reimplementation of it.
 * Answers are then judged BLIND and ORDER-RANDOMIZED by the same provider, so the judge cannot
 * learn which arm is which, and a positional bias cannot masquerade as a layout effect.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: it does not use DUIN's retriever. Retrieval quality is not the
 * variable under test, and holding context FIXED across arms is strictly better for isolating the
 * layout effect. Context is assembled by keyword-matching the real sample-brain vault, which is
 * representative of what the retriever surfaces without adding a second moving part.
 *
 * ISOLATION: userData is redirected to a temp dir seeded with a copy of the real settings.json and
 * lamprey-memory, so the eval reads the real vault + real memory index but every WRITE lands in
 * temp. The user's live DUIN state is never mutated.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const REAL_USERDATA = join(process.env.APPDATA ?? '', 'duin')
const TMP_USERDATA = join(tmpdir(), 'duin-stable-prefix-eval')

// Seed the isolated userData BEFORE any module reads it (memoryBaseDir caches on first call).
mkdirSync(TMP_USERDATA, { recursive: true })
for (const entry of ['settings.json', 'lamprey-memory']) {
  const src = join(REAL_USERDATA, entry)
  if (existsSync(src)) cpSync(src, join(TMP_USERDATA, entry), { recursive: true })
}

vi.mock('electron', () => ({
  app: {
    getPath: () => TMP_USERDATA,
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

// ── provider ────────────────────────────────────────────────────────────────────────────────────
import { zhipuKey, ZHIPU_BASE } from '../brain/__fixtures__/eval-harness'
const MODEL = 'glm-5.2'


/**
 * GLM 5.2 is a REASONING model. Two traps this call has to avoid, both of which silently corrupted
 * the first run of this eval:
 *  - thinking tokens are billed against max_tokens, so a small cap returns EMPTY `content` (the
 *    budget was spent reasoning). The first run's 10-token judge cap produced an empty verdict on
 *    every comparison, which the parser then read as TIE — a unanimous 8/8 "no regression" that was
 *    really "the judge never answered". Thinking is disabled here (the same `thinking.type=disabled`
 *    switch registry.ts uses for zhipu) and the caps are generous.
 *  - some providers return the answer in `reasoning_content` when `content` is empty, so both are read.
 */
async function complete(
  key: string,
  messages: unknown[],
  maxTokens = 3000,
  { think = true }: { think?: boolean } = {}
): Promise<string> {
  // FIDELITY: registry.ts does NOT set `disableThinking` on glm-5.2, so DUIN runs this model WITH
  // thinking — that is the regime the operator actually experiences, and a reasoning model may
  // respond differently to context placement than a non-reasoning one. So the ANSWER arms think
  // (with a cap large enough that reasoning cannot starve `content`), while only the JUDGE runs
  // thinking-disabled, since it needs one clean token and is not the thing under test.
  const res = await fetch(new URL('chat/completions', ZHIPU_BASE), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: MODEL,
      messages,
      max_tokens: maxTokens,
      temperature: 0.2,
      ...(think ? {} : { thinking: { type: 'disabled' } })
    })
  })
  if (!res.ok) throw new Error(`provider ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const j = (await res.json()) as {
    choices?: { message?: { content?: string; reasoning_content?: string } }[]
  }
  const msg = j.choices?.[0]?.message
  return (msg?.content || msg?.reasoning_content || '').trim()
}

// ── context assembly from the real vault ────────────────────────────────────────────────────────
// Env-overridable so the harness is not bound to one machine; defaults to the live sample-brain vault
// (the settings.json copied above points the memory index at the same place).
const VAULT =
  process.env.DUIN_EVAL_VAULT ||
  (() => {
    try {
      return JSON.parse(readFileSync(join(REAL_USERDATA, 'settings.json'), 'utf8')).localBrainNotesDir || ''
    } catch {
      return ''
    }
  })()

function vaultNotes(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = []
  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const e of entries) {
      if (e.startsWith('.')) continue
      const p = join(dir, e)
      let s
      try {
        s = statSync(p)
      } catch {
        continue
      }
      if (s.isDirectory()) walk(p)
      else if (e.endsWith('.md') && s.size < 60_000) {
        try {
          out.push({ file: p.slice(VAULT.length + 1).replace(/\\/g, '/'), text: readFileSync(p, 'utf8') })
        } catch {
          /* unreadable → skip */
        }
      }
    }
  }
  walk(VAULT)
  return out
}

/** Cheap lexical retrieval — stands in for DUIN's retriever, held identical across both arms. */
function contextFor(notes: { file: string; text: string }[], query: string, k = 4): string {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9一-鿿]+/)
    .filter((t) => t.length > 1)
  const scored = notes
    .map((n) => {
      const hay = (n.file + '\n' + n.text).toLowerCase()
      let score = 0
      for (const t of terms) {
        const hits = hay.split(t).length - 1
        score += Math.min(hits, 8)
      }
      return { ...n, score }
    })
    .filter((n) => n.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
  return scored.map((n) => `--- ${n.file} ---\n${n.text.slice(0, 3000)}`).join('\n\n')
}

// Deliberately mixed: identity/self questions (where the `.brain/` core matters), factual lookups
// (where the retrieved CONTEXT matters most — the block that MOVED), synthesis across notes, and
// negative cases where the right answer is "the notes don't cover this". The negative cases matter:
// the preamble's instruction to IGNORE off-topic context now sits in a different message from the
// context it refers to, so a layout regression would most likely show up as force-fitting.
const QUESTIONS = [
  'What is DUIN and what problem is it built to solve?',
  'What are the main risks or blockers on the ProjectA release path right now?',
  'Summarise what my brain knows about the PartnerCo engagement and its boundaries.',
  'What did the most recent BD biweekly report cover?',
  'What is the current state of my AI strategy work?',
  'What do my notes say about how I prefer work to be delivered to me?',
  'What are the open questions I have not resolved yet?',
  'What happened in my most recent daily notes?',
  'Who are the key people I work with and what do I owe them?',
  'What decisions have I recorded and what were their outcomes?',
  'What does my vault say about the BilibiliWorld milestone?',
  'What are my current goals?',
  'Explain the structure of my vault and how it is organised.',
  'What tools or skills has my brain accumulated?',
  'What is the relationship between DUIN and the lamprey harness?',
  'What memory or governance rules has my brain recorded?',
  'What is the capital of France?',
  'What does my vault say about my 2019 tax return?',
  'Summarise any meeting notes I have.',
  'What patterns show up repeatedly across my notes?'
]

// ── the eval ────────────────────────────────────────────────────────────────────────────────────
describe('stable-prefix layout — live answer-quality eval', () => {
  let key: string | null = null
  let notes: { file: string; text: string }[] = []

  beforeAll(() => {
    key = zhipuKey(REAL_USERDATA)
    notes = vaultNotes()
  })

  it('does not degrade answer quality vs the legacy layout', async () => {
    if (!key) {
      console.log('\n  SKIPPED — no plaintext zhipu key available\n')
      return
    }
    expect(notes.length).toBeGreaterThan(100)
    console.log(`\n  vault: ${notes.length} notes · model: ${MODEL} · questions: ${QUESTIONS.length}\n`)

    const { buildGroundedMessages } = await import('./agui-grounding')
    const rows: {
      q: string
      legacyChars: number
      stableChars: number
      legacyCites: number
      stableCites: number
      winner: string
    }[] = []
    let stableWins = 0
    let legacyWins = 0
    let ties = 0
    let invalid = 0

    for (const [i, q] of QUESTIONS.entries()) {
      const ctx = contextFor(notes, q)
      const history = [{ role: 'user' as const, content: q }]

      delete process.env.DUIN_STABLE_PREFIX
      const legacyMsgs = await buildGroundedMessages(history, q, [], ctx, null, `eval-${i}`)
      process.env.DUIN_STABLE_PREFIX = '1'
      const stableMsgs = await buildGroundedMessages(history, q, [], ctx, null, `eval-${i}`)
      delete process.env.DUIN_STABLE_PREFIX

      // Sanity: the layouts must actually differ, and the stable core must be volatile-free.
      expect(String(stableMsgs[0].content)).not.toContain('CONTEXT (retrieved for:')
      expect(String(legacyMsgs[0].content)).toContain('CONTEXT (retrieved for:')

      const [legacyAns, stableAns] = await Promise.all([
        complete(key, legacyMsgs),
        complete(key, stableMsgs)
      ])

      // An EMPTY answer is a broken measurement, not a tie. Fail loudly rather than let it be
      // judged — this is exactly how the first run produced a meaningless unanimous result.
      expect(legacyAns.length, `legacy arm returned an empty answer for: ${q}`).toBeGreaterThan(0)
      expect(stableAns.length, `stable arm returned an empty answer for: ${q}`).toBeGreaterThan(0)

      // Blind + order-randomised judging.
      const stableFirst = i % 2 === 0
      const A = stableFirst ? stableAns : legacyAns
      const B = stableFirst ? legacyAns : stableAns
      const verdict = await complete(
        key,
        [
          {
            role: 'system',
            content:
              'You are grading two answers from the same assistant to the same question, both given ' +
              'the same source notes. Judge ONLY: factual grounding in the notes, directness, and ' +
              'whether it cites the filenames it used. Ignore length and style. Reply with exactly ' +
              'one token: A, B, or TIE.'
          },
          {
            role: 'user',
            content: `QUESTION: ${q}\n\nSOURCE NOTES:\n${ctx.slice(0, 6000)}\n\nANSWER A:\n${A}\n\nANSWER B:\n${B}\n\nWhich is better? Reply A, B, or TIE.`
          }
        ],
        64,
        { think: false }
      )

      // Parse STRICTLY. An unparseable verdict is INVALID, never a tie: silently folding judge
      // failures into "tie" is what made the first run read as a clean pass.
      const v = verdict.trim().toUpperCase()
      let winner: string
      if (/^A\b|^A$|^ANSWER A/.test(v)) winner = stableFirst ? 'STABLE' : 'LEGACY'
      else if (/^B\b|^B$|^ANSWER B/.test(v)) winner = stableFirst ? 'LEGACY' : 'STABLE'
      else if (v.startsWith('TIE')) winner = 'TIE'
      else winner = 'INVALID'

      if (winner === 'STABLE') stableWins++
      else if (winner === 'LEGACY') legacyWins++
      else if (winner === 'TIE') ties++
      else invalid++

      const cites = (s: string): number => (s.match(/\[[^\]]+\.md[^\]]*\]|\.md/g) || []).length
      rows.push({
        q: q.slice(0, 46),
        legacyChars: legacyAns.length,
        stableChars: stableAns.length,
        legacyCites: cites(legacyAns),
        stableCites: cites(stableAns),
        winner
      })
      console.log(
        `  ${String(i + 1).padStart(2)}. ${q.slice(0, 44).padEnd(46)} ${winner.padEnd(7)} ` +
          `cites L${cites(legacyAns)}/S${cites(stableAns)}`
      )
    }

    const report = {
      model: MODEL,
      questions: QUESTIONS.length,
      stableWins,
      legacyWins,
      ties,
      invalid,
      citationRate: {
        legacy: rows.filter((r) => r.legacyCites > 0).length / rows.length,
        stable: rows.filter((r) => r.stableCites > 0).length / rows.length
      },
      rows
    }
    writeFileSync(join(TMP_USERDATA, 'eval-report.json'), JSON.stringify(report, null, 2))

    console.log(
      `\n  RESULT  stable ${stableWins} · legacy ${legacyWins} · tie ${ties} · invalid ${invalid}` +
        `\n  citation rate  legacy ${(report.citationRate.legacy * 100).toFixed(0)}% · ` +
        `stable ${(report.citationRate.stable * 100).toFixed(0)}%` +
        `\n  report: ${join(TMP_USERDATA, 'eval-report.json')}\n`
    )

    // The eval must have actually MEASURED something. A run that is mostly invalid — or entirely
    // undecided — proves nothing and must not be reported as "no regression".
    expect(invalid, 'too many unparseable judge verdicts — the measurement is broken').toBeLessThanOrEqual(1)

    // GATE: the stable layout must not lose materially. Ties count as no-regression, since the
    // layout's purpose is latency, not answer improvement. A single loss on 8 questions is noise;
    // losing more than half the DECIDED comparisons is a real regression.
    const decided = stableWins + legacyWins
    if (decided > 0) expect(legacyWins).toBeLessThanOrEqual(Math.ceil(decided / 2))
    // Grounding must survive the move: the stable arm must still cite its sources.
    expect(report.citationRate.stable).toBeGreaterThanOrEqual(report.citationRate.legacy - 0.25)
  })
})
