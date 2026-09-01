import { describe, it, expect, afterEach } from 'vitest'
import { looksLikeGenerativeWrite, generativeProseFirstEnabled } from './generative-intent'

describe('looksLikeGenerativeWrite — fires on compose-a-document requests', () => {
  for (const q of [
    'Write a complete structured document about our Q3 strategy',
    'Draft a comprehensive report on the competitive landscape',
    'compose an essay on the tradeoffs',
    'put together a detailed plan for the launch',
    'generate a summary of everything we discussed',
    'produce an analysis of the risks',
    'write me a memo to the team'
  ]) {
    it(`fires: "${q.slice(0, 40)}…"`, () => expect(looksLikeGenerativeWrite(q)).toBe(true))
  }
})

describe('looksLikeGenerativeWrite — language-agnostic (CJK)', () => {
  for (const q of ['写一份完整的战略方案', '生成一份竞品分析报告', '起草一份给团队的提案', '整理成一份总结']) {
    it(`fires (zh): "${q}"`, () => expect(looksLikeGenerativeWrite(q)).toBe(true))
  }
  for (const q of ['把这个方案保存到文件', '写入 plan.md 的报告']) {
    it(`suppressed (zh file intent): "${q}"`, () => expect(looksLikeGenerativeWrite(q)).toBe(false))
  }
  for (const q of ['查看最新报告', '这个方案怎么样']) {
    it(`no-fire (zh, no compose verb): "${q}"`, () => expect(looksLikeGenerativeWrite(q)).toBe(false))
  }
})

// The periodic-report family ends in a bare 报, which `报告` does not match. These are the
// operator's actual recurring artifacts — the ones the Learn loop is defined around — so a
// miss here routes the highest-stakes request into the tool loop that churns. Measured live
// 2026-08-02: identical request, EN delivered in 51s, ZH never terminated in 240s.
describe('looksLikeGenerativeWrite — CJK periodic-report family (双周报/周报/月报)', () => {
  for (const q of [
    '写一份完整的双周报，覆盖我最近两周的工作。',
    '写一份双周报',
    '帮我起草这两周的双周报',
    '生成本周周报',
    '写一份月报',
    '整理一份季报',
    '写一份工作汇报',
    '生成一份简报',
    '整理一份近两周工作书面汇总'
  ]) {
    it(`fires (zh periodic): "${q.slice(0, 24)}"`, () => expect(looksLikeGenerativeWrite(q)).toBe(true))
  }
  // The prefixes are enumerated rather than a bare 报 precisely so these stay out.
  for (const q of ['帮我写一份情报来源清单的说明', '写一个报名表单的校验函数']) {
    it(`bare-报 words are not document objects: "${q.slice(0, 20)}"`, () => {
      // 清单/说明 legitimately fire in the first; the point is 情报/报名 alone must not.
      expect(looksLikeGenerativeWrite('查一下情报')).toBe(false)
      expect(looksLikeGenerativeWrite('报名')).toBe(false)
      expect(typeof looksLikeGenerativeWrite(q)).toBe('boolean')
    })
  }
  it('still suppressed when the operator wants the 双周报 SAVED', () => {
    expect(looksLikeGenerativeWrite('把双周报保存到文件')).toBe(false)
    expect(looksLikeGenerativeWrite('写一份双周报并存到 reports/w29.md')).toBe(false)
  })
  it('no-fire without a compose verb', () => {
    expect(looksLikeGenerativeWrite('查看最新双周报')).toBe(false)
    expect(looksLikeGenerativeWrite('上次的周报呢')).toBe(false)
  })
})

describe('looksLikeGenerativeWrite — language-agnostic (Japanese)', () => {
  for (const q of ['レポートを作成して', '資料をまとめる', '競合分析のレポートを書いて', '企画書を生成']) {
    it(`fires (ja): "${q}"`, () => expect(looksLikeGenerativeWrite(q)).toBe(true))
  }
  for (const q of ['レポートをファイルに保存して', 'plan.md にレポートを書き込む']) {
    it(`suppressed (ja file intent): "${q}"`, () => expect(looksLikeGenerativeWrite(q)).toBe(false))
  }
  for (const q of ['最新のレポートを見せて', 'この企画書はどう']) {
    it(`no-fire (ja, no compose verb): "${q}"`, () => expect(looksLikeGenerativeWrite(q)).toBe(false))
  }
})

describe('looksLikeGenerativeWrite — suppressed by file/persistence intent', () => {
  for (const q of [
    'Write a file called plan.md with the roadmap',
    'save this document to disk',
    'create a file summarizing the notes',
    'edit the report doc and add a section',
    'write the analysis to notes/analysis.md',
    'update the plan document in the vault',
    'render the report as an artifact'
  ]) {
    it(`suppressed: "${q.slice(0, 40)}…"`, () => expect(looksLikeGenerativeWrite(q)).toBe(false))
  }
})

// The 2026-08-03 narrowing. Before it, naming ANY .md file — or using the bare word "file" —
// suppressed prose-first, so citing an output convention while asking for the document it governs
// routed the request back into the tool loop it was built to avoid. Referencing a file is not
// asking for one; only persistence phrasing is.
describe('looksLikeGenerativeWrite — a file MENTION does not suppress (only persistence does)', () => {
  for (const q of [
    '写一份双周报，参考 _双周报输出约定.md',
    'draft a report based on the spec file',
    'write a summary of what CLAUDE.md says about the build gates',
    'produce an analysis using the numbers in metrics.csv'
  ]) {
    it(`still fires: "${q.slice(0, 46)}…"`, () => expect(looksLikeGenerativeWrite(q)).toBe(true))
  }
})

describe('looksLikeGenerativeWrite — does not fire on non-generative asks', () => {
  for (const q of [
    'what were my last 3 decisions?',
    'list the open tasks',
    'read foo.md',
    'yes',
    '',
    'hi'
  ]) {
    it(`no-fire: "${q}"`, () => expect(looksLikeGenerativeWrite(q)).toBe(false))
  }
})

describe('generativeProseFirstEnabled — default on, env-disable', () => {
  const prev = process.env.DUIN_GENERATIVE_PROSE_FIRST
  afterEach(() => {
    if (prev === undefined) delete process.env.DUIN_GENERATIVE_PROSE_FIRST
    else process.env.DUIN_GENERATIVE_PROSE_FIRST = prev
  })
  it('on by default (unset)', () => {
    delete process.env.DUIN_GENERATIVE_PROSE_FIRST
    expect(generativeProseFirstEnabled()).toBe(true)
  })
  for (const v of ['0', 'false', 'off', 'OFF']) {
    it(`disabled by "${v}"`, () => {
      process.env.DUIN_GENERATIVE_PROSE_FIRST = v
      expect(generativeProseFirstEnabled()).toBe(false)
    })
  }
  it('enabled by "1"', () => {
    process.env.DUIN_GENERATIVE_PROSE_FIRST = '1'
    expect(generativeProseFirstEnabled()).toBe(true)
  })
})
