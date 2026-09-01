import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { extractConversationContext, buildDraftPrompt, draftReply } from './draft-reply-native'

describe('draft-reply — extractConversationContext (PURE)', () => {
  it('pulls the 概要 + 下一步 sections and flattens wikilinks', () => {
    const note = [
      '# 张三', '联系人信息表...', '',
      '> **概要：** 讨论了 [[北澜|北澜项目]] 的渠道',
      '', '## 下一步', '- 确认 TapTap 联运 {{duinTaskId:: x}}', '', '## 联系方式', '- phone'
    ].join('\n')
    const ctx = extractConversationContext(note)
    expect(ctx).toContain('讨论了 北澜 的渠道') // wikilink flattened
    expect(ctx).toContain('确认 TapTap 联运') // section kept, inline field stripped
    expect(ctx).not.toContain('{{duinTaskId')
  })

  it('falls back to the first 1800 chars when no sections match', () => {
    const note = 'just plain prose with nothing structured'
    expect(extractConversationContext(note)).toBe(note)
  })
})

describe('draft-reply — buildDraftPrompt (PURE)', () => {
  it('embeds contact, owed item, thread, and context', () => {
    const p = buildDraftPrompt('张三', 'the SOW', '张三: hi →you', 'background stuff')
    // Cold-start A4: the prompt no longer names the author — it addresses "the operator", so a
    // second user's drafts are written as them.
    expect(p).toContain('the OPERATOR will send this contact')
    expect(p).not.toMatch(/\bRG\b/)
    expect(p).toContain('CONTACT: 张三')
    expect(p).toContain('OPEN ITEM the operator owes them: the SOW')
    expect(p).toContain("THEIR RECENT ACTUAL MESSAGES")
    expect(p).toContain('BACKGROUND CONTEXT:\nbackground stuff')
  })

  it('omits the owed/thread lines when empty', () => {
    const p = buildDraftPrompt('张三', '', '', 'ctx')
    expect(p).not.toContain('OPEN ITEM')
    expect(p).not.toContain('THEIR RECENT ACTUAL MESSAGES')
  })
})

describe('draft-reply — draftReply', () => {
  let vault: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-dr-'))
    mkdirSync(join(vault, 'People'), { recursive: true })
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('errors when the conversation note is missing/empty', async () => {
    expect(await draftReply(vault, 'People/nope.md', '张三', '', '', { generate: async () => 'x' })).toEqual({ ok: false, error: 'no conversation context' })
  })

  it('drafts a reply from the note context', async () => {
    writeFileSync(join(vault, 'People', '张三.md'), '> **概要：** 渠道讨论\n\n## 下一步\n- 确认联运')
    const out = await draftReply(vault, 'People/张三.md', '张三', '联运确认', '', { generate: async (p) => (p.includes('渠道讨论') ? '张三你好，联运细节我这边确认后周五给你。' : '') })
    expect(out.ok).toBe(true)
    expect(out.draft).toBe('张三你好，联运细节我这边确认后周五给你。')
  })

  it('ok:false when the model returns empty', async () => {
    writeFileSync(join(vault, 'People', '张三.md'), '> **概要：** x')
    expect(await draftReply(vault, 'People/张三.md', '张三', '', '', { generate: async () => '   ' })).toEqual({ ok: false, draft: '' })
  })
})
