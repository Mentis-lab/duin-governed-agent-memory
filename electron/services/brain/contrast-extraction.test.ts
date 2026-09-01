import { describe, it, expect } from 'vitest'
import {
  contrastPair,
  buildContrastPrompt,
  contrastiveAbstraction,
  parseRule,
  type ContrastChat,
  type SuccessTraceLike,
  type CorrectionTraceLike
} from './contrast-extraction'

const good = (query: string, answer: string): SuccessTraceLike => ({ query, answer })
const bad = (aiOutput: string, correction: string, why: string): CorrectionTraceLike => ({ aiOutput, correction, why })

describe('contrastPair', () => {
  it('pairs a success with the topic-overlapping correction, drops an unrelated success', () => {
    const successes = [
      good('wafer calibration report', 'wafer calibration for proteantecs'), // shares wafer+calibration
      good('deploy scripts', 'powershell deploy pipeline') // unrelated
    ]
    const corrections = [bad('wrong wafer number', 'wafer calibration must be included', 'calibration matters')]
    const pairs = contrastPair(successes, corrections)
    expect(pairs).toHaveLength(1)
    expect(pairs[0].good.query).toBe('wafer calibration report')
    expect(pairs[0].overlap).toBeGreaterThanOrEqual(2)
  })

  it('picks the BEST-overlap correction when several match', () => {
    const successes = [good('wafer calibration report accuracy', 'proteantecs wafer calibration accuracy')]
    const corrections = [
      bad('x', 'wafer thing', 'note'), // shares only wafer (1)
      bad('y', 'wafer calibration accuracy fix', 'because accuracy') // shares wafer+calibration+accuracy (3)
    ]
    const pairs = contrastPair(successes, corrections)
    expect(pairs).toHaveLength(1)
    expect(pairs[0].bad.correction).toBe('wafer calibration accuracy fix')
    expect(pairs[0].overlap).toBeGreaterThanOrEqual(3)
  })

  it('returns nothing for empty inputs or no ≥2-token overlap', () => {
    expect(contrastPair([], [bad('a', 'b', 'c')])).toEqual([])
    expect(contrastPair([good('alpha beta', 'gamma delta')], [])).toEqual([])
    expect(contrastPair([good('alpha beta gamma', 'delta')], [bad('zzz', 'unrelated words here', 'reason')])).toEqual([])
  })
})

describe('buildContrastPrompt', () => {
  it('includes the good answer + the bad triad + a JSON-only instruction', () => {
    const p = buildContrastPrompt({
      good: good('q', 'the endorsed answer'),
      bad: bad('the bad output', 'the fix', 'the reasoning'),
      overlap: 2
    })
    expect(p).toContain('the endorsed answer')
    expect(p).toContain('the bad output')
    expect(p).toContain('the fix')
    expect(p).toContain('the reasoning')
    expect(p).toMatch(/JSON/)
    expect(p).toMatch(/"rule"/)
    expect(p).not.toContain('简体中文') // English pair → no language pin (byte-identical default)
  })

  it('pins the rule language to the correction/reasoning language', () => {
    const zh = buildContrastPrompt({
      good: good('q', 'the endorsed answer'),
      bad: bad('错误输出', '应当引用来源', '因为可信度'),
      overlap: 2
    })
    expect(zh).toContain('简体中文')

    const ja = buildContrastPrompt({
      good: good('q', 'the endorsed answer'),
      bad: bad('間違った出力', '出典を引用すべき', '信頼性のため'),
      overlap: 2
    })
    expect(ja).toContain('日本語')
  })
})

describe('parseRule', () => {
  it('extracts a rule string, tolerating surrounding prose', () => {
    expect(parseRule('here you go: {"rule":"Always cite sources."} done')).toBe('Always cite sources.')
  })
  it('returns null for null / NONE / non-JSON', () => {
    expect(parseRule('{"rule":null}')).toBeNull()
    expect(parseRule('{"rule":"NONE"}')).toBeNull()
    expect(parseRule('no json here')).toBeNull()
    expect(parseRule('{bad json')).toBeNull()
  })
})

describe('contrastiveAbstraction', () => {
  const pairs = [
    { good: good('wafer q', 'wafer a'), bad: bad('wafer bad', 'wafer fix', 'wafer why'), overlap: 2 },
    { good: good('deploy q', 'deploy a'), bad: bad('deploy bad', 'deploy fix', 'deploy why'), overlap: 2 }
  ]

  it('abstracts each pair into a rule via the injected LLM', async () => {
    const chat: ContrastChat = async (prompt) => ({
      text: prompt.includes('wafer') ? '{"rule":"Include wafer calibration."}' : '{"rule":"Use the full deploy path."}',
      finishReason: 'stop'
    })
    const r = await contrastiveAbstraction(pairs, { chat, model: 'flash' })
    expect(r.rules.sort()).toEqual(['Include wafer calibration.', 'Use the full deploy path.'])
    expect(r.consumed).toBe(2)
    expect(r.status).toBe('ok')
  })

  it('is a no-op when no model is configured (key-gated off)', async () => {
    const chat: ContrastChat = async () => ({ text: '{"rule":"x"}', finishReason: 'stop' })
    const r = await contrastiveAbstraction(pairs, { chat, model: null })
    expect(r).toEqual({ rules: [], consumed: 0, status: 'no-model' })
  })

  it('skips a truncated (finishReason=length) reply', async () => {
    const chat: ContrastChat = async () => ({ text: '{"rule":"partial', finishReason: 'length' })
    expect((await contrastiveAbstraction(pairs, { chat, model: 'flash' })).rules).toEqual([])
  })

  it('skips a declined ({"rule":null}) or throwing pair, keeps the others', async () => {
    const chat: ContrastChat = async (prompt) => {
      if (prompt.includes('wafer')) throw new Error('engine down')
      return { text: '{"rule":"Use the full deploy path."}', finishReason: 'stop' }
    }
    const r = await contrastiveAbstraction(pairs, { chat, model: 'flash' })
    expect(r.rules).toEqual(['Use the full deploy path.'])
  })
})
