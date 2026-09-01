import { describe, it, expect } from 'vitest'
import { looksLikeIncompleteIntent } from './incomplete-intent'

describe('looksLikeIncompleteIntent', () => {
  it('flags a turn that announces an action but stops (the reported bug)', () => {
    expect(looksLikeIncompleteIntent('Let me search for it:')).toBe(true)
    expect(looksLikeIncompleteIntent("I'll create that note for you")).toBe(true)
    expect(looksLikeIncompleteIntent('One moment while I look')).toBe(true)
    expect(looksLikeIncompleteIntent('Sure — searching your notes')).toBe(true)
    expect(looksLikeIncompleteIntent('Here is what I found:')).toBe(true)
    expect(looksLikeIncompleteIntent("I'm going to write the file")).toBe(true)
  })

  // REGRESSION PIN (2026-08-05). Every case above ends WITHOUT sentence punctuation,
  // which is what let the original gate pass its own suite while missing the failure
  // in the field: it anchored to end-of-string across a class excluding `.!?`, so a
  // properly punctuated announcement could never match. A fluent model punctuates.
  // The first string here is verbatim from the session that dead-ended — the loop
  // scored it "complete" and the operator got a 109-character promise, not a document.
  it('flags a PUNCTUATED announcement — the sentence, not the period, decides', () => {
    expect(
      looksLikeIncompleteIntent(
        'Resuming — the file write got cut off mid-section 16. Let me complete the full document and write it to disk.'
      )
    ).toBe(true)
    expect(looksLikeIncompleteIntent("I'll write this to disk now.")).toBe(true)
    expect(looksLikeIncompleteIntent('Let me write the full document now.')).toBe(true)
    expect(looksLikeIncompleteIntent("I'm going to write the file.")).toBe(true)
    expect(looksLikeIncompleteIntent('我这就把完整文档写到磁盘上。')).toBe(true)
  })

  it('does NOT flag a complete answer', () => {
    expect(looksLikeIncompleteIntent('It is not in your notes. Want me to create it?')).toBe(false)
    expect(looksLikeIncompleteIntent('Done — I wrote the note to DUIN/00 Inbox/x.md.')).toBe(false)
    expect(looksLikeIncompleteIntent('The top priority this week is the 北澜 playtest.')).toBe(false)
    expect(looksLikeIncompleteIntent('Yes.')).toBe(false)
    // "let me know" is a normal sign-off, not an unfulfilled intent to act.
    expect(looksLikeIncompleteIntent('I could not find it — let me know if you want a new note.')).toBe(false)
    expect(looksLikeIncompleteIntent('I could not find it. Let me know')).toBe(false)
    // Reading the last SENTENCE rather than the last 60 characters widens what the
    // gate sees, so the ordinary sign-offs it must stay quiet on are pinned too.
    expect(looksLikeIncompleteIntent("I'll let you know if anything changes.")).toBe(false)
    expect(looksLikeIncompleteIntent('文件已经写入 DUIN/Dev/x.md 了。')).toBe(false)
  })

  // Bilingual pins: the SAME turn in both scripts must get the SAME verdict. Without
  // these the gate can silently regress to firing on latin turns only, which is the
  // exact asymmetry that made correction capture deaf to Chinese.
  it('flags an announced-but-unfulfilled action in Chinese, same as in English', () => {
    expect(looksLikeIncompleteIntent('我来帮你查一下')).toBe(true)
    expect(looksLikeIncompleteIntent('让我搜一下你的笔记')).toBe(true)
    expect(looksLikeIncompleteIntent('稍等，我这就去找')).toBe(true)
    // A fullwidth colon ends the same "here is what I will do:" sentence.
    expect(looksLikeIncompleteIntent('我找到了以下内容：')).toBe(true)
  })

  it('does NOT flag a complete Chinese answer', () => {
    expect(looksLikeIncompleteIntent('笔记里没有这条记录。要我新建一条吗？')).toBe(false)
    expect(looksLikeIncompleteIntent('已经写好了。')).toBe(false)
    expect(looksLikeIncompleteIntent('是的。')).toBe(false)
  })

  it('handles empty / whitespace safely', () => {
    expect(looksLikeIncompleteIntent('')).toBe(false)
    expect(looksLikeIncompleteIntent('   \n  ')).toBe(false)
  })
})
