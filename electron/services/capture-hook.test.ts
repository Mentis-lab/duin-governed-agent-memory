import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import {
  detectCorrection,
  extractCorrection,
  buildCaptureRow,
  significance,
  runCaptureHook,
  __resetCaptureMemo
} from './capture-hook'

const ASSISTANT = 'Lead with wins — leadership scans for momentum first, then risks as decision items.'

describe('detectCorrection — precision gate', () => {
  it('skips a turn with no prior assistant output', () => {
    expect(detectCorrection(null, 'No, lead with risks').hit).toBe(false)
    expect(detectCorrection('', 'No, lead with risks').reason).toBe('no-prior-assistant')
  })
  it('skips machine-injected turns', () => {
    expect(detectCorrection(ASSISTANT, 'connectivity test — are you online').hit).toBe(false)
    expect(detectCorrection(ASSISTANT, 'system: role prompt for the engine').reason).toBe('machine-injected')
  })
  it('skips loop-admin turns', () => {
    expect(detectCorrection(ASSISTANT, 'approve all but the rest is fine').reason).toBe('loop-admin')
  })
  it('skips a bare factual fix with no reasoning or rule', () => {
    expect(detectCorrection(ASSISTANT, 'no, 2024').hit).toBe(false)
    expect(detectCorrection(ASSISTANT, 'no, 2024').reason).toBe('bare-fix')
  })
  it('skips a plain follow-up question (no correction signal)', () => {
    expect(detectCorrection(ASSISTANT, 'can you expand on the second point?').hit).toBe(false)
  })
  it('skips ordinary instructions that merely contain a bare imperative word', () => {
    // "don't"/"stop" alone are not corrections without a lead or a reasoning/rule clause.
    expect(detectCorrection(ASSISTANT, "Don't forget to commit the changes please").hit).toBe(false)
    expect(detectCorrection(ASSISTANT, 'Stop the dev server and rerun the tests').hit).toBe(false)
  })
  it('skips a leading acknowledgment that pivots into a new question', () => {
    expect(detectCorrection(ASSISTANT, 'Right, so what about the budget breakdown?').hit).toBe(false)
  })
  it('still fires when a weak imperative carries a reasoning clause', () => {
    const r = detectCorrection(ASSISTANT, 'Never send that to leadership, because it reads as noise.')
    expect(r.hit).toBe(true)
    expect(r.polarity).toBe('correction')
  })
})

describe('detectCorrection — real signals', () => {
  it('fires on a reasoned override as a correction', () => {
    const r = detectCorrection(ASSISTANT, 'No — always lead with risks, because leadership reads the top line for exposure first.')
    expect(r.hit).toBe(true)
    expect(r.polarity).toBe('correction')
  })
  it('fires on an endorsement as positive', () => {
    const r = detectCorrection(ASSISTANT, 'Yes, exactly — that framing was the move, keep doing that.')
    expect(r.hit).toBe(true)
    expect(r.polarity).toBe('positive')
  })
})

// ──────────────────── language parity (PLANNING §0.0 · item 3.0) ────────────────────
// THE measured defect: driving a real correction through the sanctioned UI path on
// 2026-07-28 moved `messages` 155→159 and `corrections.jsonl` by +0. Probing
// detectCorrection directly gave 6/6 Chinese DROPPED vs 4/4 English CAPTURED, because
// every gate was ASCII-only and built on `\b`, which does not exist between Han
// characters. These are the exact five pairs from that table. Each pair is the SAME
// judgment expressed twice; the loop must not hear one and go deaf to the other.
const ASSISTANT_ZH = '《北澜》二测时间点是 8–10 月，约 2 万人级别测试。'

const PAIRS: { name: string; zh: string; en: string }[] = [
  {
    name: 'negation + corrected value + standing rule (the real dropped turn)',
    zh: '不对，你说错了。二测应该是 2026 年 8 月，不是你说的时间。以后回答这类问题请先查 OKR Tracker 再回答。',
    en: "No, you're wrong. The second beta should be August 2026, not the date you gave. From now on check the OKR Tracker before answering this kind of question."
  },
  {
    name: 'blunt negation + rule',
    zh: '错了。以后请先查 OKR Tracker 再回答。',
    en: 'Wrong. From now on check the OKR Tracker before you answer.'
  },
  {
    name: 'should-be correction with a reason',
    zh: '应该是 2026 年 8 月，因为发行档期定在暑期。',
    en: 'It should be August 2026, because the release window is set for the summer.'
  },
  {
    name: 'standing rule',
    zh: '以后所有双周报都要先写风险。',
    en: 'From now on every biweekly report should lead with risks.'
  },
  {
    name: 'endorsement',
    zh: '对，就是这样',
    en: 'Yes, exactly'
  }
]

describe('detectCorrection — language parity (the operator is not only heard in English)', () => {
  for (const p of PAIRS) {
    it(`same verdict in both scripts — ${p.name}`, () => {
      const zh = detectCorrection(ASSISTANT_ZH, p.zh)
      const en = detectCorrection(ASSISTANT, p.en)
      expect(
        zh.hit,
        `ZH ${zh.hit ? 'captured' : `DROPPED (${zh.reason})`} while EN ${en.hit ? 'captured' : `dropped (${en.reason})`}`
      ).toBe(en.hit)
      expect(zh.polarity, 'polarity must match across scripts').toBe(en.polarity)
    })
  }

  it('captures the Chinese correction the ledger measured as dropped', () => {
    const r = detectCorrection(ASSISTANT_ZH, PAIRS[0].zh)
    expect(r.hit).toBe(true)
    expect(r.polarity).toBe('correction')
  })

  it('hears a Chinese endorsement as positive rather than as silence', () => {
    const r = detectCorrection(ASSISTANT_ZH, '对，就是这样')
    expect(r.hit).toBe(true)
    expect(r.polarity).toBe('positive')
  })

  // The fix must widen the gate, not remove it: ordinary Chinese instructions and
  // questions are still not operator judgment.
  it('still refuses ordinary Chinese instructions and questions', () => {
    expect(detectCorrection(ASSISTANT_ZH, '帮我把这段翻译成英文').hit).toBe(false)
    expect(detectCorrection(ASSISTANT_ZH, '这个功能默认是关闭的吗？').hit).toBe(false)
    expect(detectCorrection(ASSISTANT_ZH, '再写一版更短的').hit).toBe(false)
  })

  // The SECOND language barrier, independent of the regexes: the bare-fix gate drops a
  // correction under 6 "words", and a whitespace `\S+` count scores an entire Chinese
  // sentence as ONE token. Bilingual regexes alone still leave short ZH corrections dying
  // here.
  it('measures Chinese significance by codepoint, not by whitespace runs', () => {
    // 16 Han characters, zero spaces: one token by the old measure, 8 by this one.
    expect(significance('不对，报告标题应该用中文，不要用英文')).toBe(8)
    // CJK punctuation must not survive as a phantom Latin token.
    expect(significance('不对，是 8 月')).toBe(3) // ceil(4 Han / 2) + "8"
    expect(significance('from now on send the weekly report')).toBe(7) // pure Latin is unchanged
    expect(significance('OKR Tracker 再查一次')).toBe(4) // 2 latin + ceil(4 Han / 2)
    expect(significance('')).toBe(0)
  })

  it('a short Chinese correction survives the bare-fix gate exactly as its English twin does', () => {
    const zh = detectCorrection(ASSISTANT_ZH, '不对，报告标题应该用中文，不要用英文')
    const en = detectCorrection(ASSISTANT, 'No, the report title should be in Chinese, not in English')
    expect(zh.hit, `ZH ${zh.reason}`).toBe(true)
    expect(zh.hit).toBe(en.hit)
    expect(zh.polarity).toBe(en.polarity)
  })

  it('keeps dropping a genuinely bare fix in BOTH scripts (the gate still bites)', () => {
    const zh = detectCorrection(ASSISTANT_ZH, '不对，是 8 月')
    const en = detectCorrection(ASSISTANT, 'No, it is August')
    expect(zh.reason).toBe('bare-fix')
    expect(en.reason).toBe('bare-fix')
    expect(zh.hit).toBe(en.hit)
  })

  it('the standing-rule pair named in the item survives in both scripts', () => {
    const zh = detectCorrection(ASSISTANT_ZH, '以后都用飞书发周报')
    const en = detectCorrection(ASSISTANT, 'from now on send the weekly report on Feishu')
    expect(zh.hit).toBe(true)
    expect(zh.hit).toBe(en.hit)
    expect(zh.polarity).toBe(en.polarity)
  })

  it('extracts a Chinese standing rule into candidate_rule, stopping at 。not running on', () => {
    const ex = extractCorrection('以后所有双周报都要先写风险。其他的按老样子。', 'correction')
    expect(ex.candidate_rule).toContain('以后所有双周报都要先写风险')
    expect(ex.candidate_rule).not.toContain('其他的')
  })
})

describe('extractCorrection — captures the why', () => {
  it('splits override from reasoning', () => {
    const ex = extractCorrection(
      'No, lead with risks not wins. At our stage leadership reads the top line for exposure first, so a buried risk is found too late to act.',
      'correction'
    )
    expect(ex.correction.toLowerCase()).toContain('lead with risks')
    expect(ex.why.length).toBeGreaterThan(0)
    expect(ex.why.toLowerCase()).toContain('exposure')
  })
  it('pulls an explicit standing rule into candidate_rule', () => {
    const ex = extractCorrection('Always lead with risks, never with wins.', 'correction')
    expect(ex.candidate_rule.toLowerCase()).toContain('always lead with risks')
  })
  it('captures the first explicit rule when several are stated', () => {
    const ex = extractCorrection('No — never open with accomplishments. Always lead with risks.', 'correction')
    expect(ex.candidate_rule.toLowerCase()).toContain('never open with accomplishments')
  })
})

describe('buildCaptureRow — schema + no source field', () => {
  it('produces a Correction row with a non-empty why and no source', () => {
    const row = buildCaptureRow(
      ASSISTANT,
      'No — always lead with risks, not wins. At our stage leadership reads the top line for exposure first, and a buried risk is found too late to act.',
      { session: 's1', today: '2026-07-03' }
    )
    expect(row).not.toBeNull()
    expect(row!.polarity).toBe('correction')
    expect(row!.why.length).toBeGreaterThan(0)
    expect(row!.skill).toBe('capture-hook')
    expect(row!.ts).toBe('2026-07-03')
    expect('source' in row!).toBe(false)
  })
  it('returns null for a non-capture turn', () => {
    expect(buildCaptureRow(ASSISTANT, 'thanks, that helps')).toBeNull()
  })
})

// The PRODUCTION entry point, exercised the way electron/ipc/chat.ts:357 calls it
// (`runCaptureHook(lastAssistant, content, { session })`). The unit tests above prove the
// gates match; this proves the arrow the app actually fires now carries a Chinese
// correction all the way to the POST body — the step between "the regex matches" and
// "corrections.jsonl moves". The live ledger is the reason this matters: 166 rows, and the
// real 2026-07-28 Chinese correction is not among them.
describe('runCaptureHook — the arrow chat.ts fires', () => {
  beforeEach(() => {
    __resetCaptureMemo()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('posts a correction row for a Chinese turn that previously produced nothing', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = []
    vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) })
      return { ok: true, status: 200 }
    })

    const r = await runCaptureHook(
      '《北澜》二测时间点是 8–10 月，约 2 万人级别测试。',
      '不对，你说错了。二测应该是 2026 年 8 月，不是你说的时间。以后回答这类问题请先查 OKR Tracker 再回答。',
      { session: 'zh-1', today: '2026-08-03' }
    )

    expect(r.posted, `capture did not fire: ${r.reason}`).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toMatch(/\/learn\/correction$/)
    expect(calls[0].body.polarity).toBe('correction')
    expect(String(calls[0].body.candidate_rule)).toContain('以后')
    expect('source' in calls[0].body).toBe(false) // operator-only stream
  })

  it('still posts nothing for an ordinary Chinese instruction', async () => {
    const calls: unknown[] = []
    vi.stubGlobal('fetch', async () => {
      calls.push(1)
      return { ok: true, status: 200 }
    })
    const r = await runCaptureHook('《北澜》二测时间点是 8–10 月。', '帮我把这段翻译成英文')
    expect(r.posted).toBe(false)
    expect(calls).toHaveLength(0)
  })

  // ONE TURN, ONE ROW. Capture now fires from two seams in the same process — ipc/chat.ts before
  // the turn runs, recall-efficacy's /agui tick after the answer completes. The guard keys on the
  // OPERATOR'S TURN TEXT because that is the only thing the two seams provably share byte for
  // byte: they read the prior answer from different stores and label `session` differently.
  it('the same turn fired twice posts ONCE, even when session and ai_output differ', async () => {
    const calls: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', async (_u: string, init: { body: string }) => {
      calls.push(JSON.parse(init.body) as Record<string, unknown>)
      return { ok: true, status: 200 }
    })
    const msg = "No, that's wrong — it should be August, because the tracker is the source of truth."

    const a = await runCaptureHook(ASSISTANT, msg, { session: 'conv-42' })
    const b = await runCaptureHook(ASSISTANT + '\n', msg, { session: 'thread-42' })

    expect(a.posted).toBe(true)
    expect(b.posted).toBe(false)
    expect(b.reason).toBe('duplicate-turn')
    expect(calls).toHaveLength(1)
  })

  // Suppression is for rows that LANDED. A rejected post captured nothing, so holding the claim
  // would let one 500 silence the other seam and lose the judgment entirely.
  it('a REJECTED post releases the claim so the other seam can still land the row', async () => {
    let ok = false
    const calls: unknown[] = []
    vi.stubGlobal('fetch', async () => {
      calls.push(1)
      const res = { ok, status: ok ? 200 : 500 }
      ok = true // the first attempt fails, the retry succeeds
      return res
    })
    const msg = "No, that's wrong — it should be August, because the tracker is the source of truth."

    const first = await runCaptureHook(ASSISTANT, msg, { session: 'c1' })
    expect(first.posted).toBe(false)
    expect(first.reason).toBe('http-500')

    const second = await runCaptureHook(ASSISTANT, msg, { session: 'c2' })
    expect(second.posted, 'a failed post blocked the retry').toBe(true)
    expect(calls).toHaveLength(2)
  })
})
