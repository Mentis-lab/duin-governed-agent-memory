// Detect a chat turn that ends by ANNOUNCING an action ("Let me search for
// it:") without actually calling a tool — the "no follow-up message" dead-end.
// The /agui tool loop uses this to nudge the model ONCE to act or finish
// instead of ending the turn on a bare statement of intent. Pure + unit-tested.
export function looksLikeIncompleteIntent(text: string): boolean {
  const t = (text || '').trim()
  if (!t) return false
  // A message ending in a bare colon is almost always "here's what I'll do:"
  // with nothing after it. Legitimate answers rarely end on a colon. The fullwidth
  // colon is the same sentence in the operator's other language.
  if (t.endsWith(':') || t.endsWith('：')) return true
  // Judge the FINAL SENTENCE, not the final characters of the whole message.
  //
  // The patterns below are anchored to the end of their input across a character
  // class that EXCLUDES `.!?`, so against a whole message they could only ever fire
  // on an unpunctuated trailing clause. A fluent model punctuates. The real turn
  // that exposed this ended:
  //
  //   "Resuming — the file write got cut off mid-section 16. Let me complete the
  //    full document and write it to disk."
  //
  // — a textbook unfulfilled intent that scored false purely because of the closing
  // period. The loop then took `break // the answer is complete` and the operator
  // got a 109-character promise instead of the document (2026-08-05). Splitting to
  // the last sentence first makes the gate read the announcement, not the punctuation.
  const last = finalSentence(t)
  if (!last) return false
  // A closing question hands the turn back to the operator on purpose. That IS a
  // complete answer ("Want me to create it?"), not an intent left dangling.
  if (/[?？]$/.test(last)) return false
  const clause = last.replace(/[.!?。！？]+$/, '')
  return EN_INTENT.test(clause) || CJK_INTENT.test(clause)
}

/** The last sentence of `t`. Splits on ASCII terminators that are followed by
 *  whitespace (so "x.md." or "v1.2" stays whole), on CJK terminators (which are
 *  not followed by whitespace), and on hard line breaks. */
function finalSentence(t: string): string {
  const parts = t.split(/(?<=[.!?])\s+|(?<=[。！？])|\n+/)
  for (let i = parts.length - 1; i >= 0; i--) {
    const s = parts[i]?.trim()
    if (s) return s
  }
  return ''
}

// Announcing-an-action openers. "let me know" and "I'll let you know" are ordinary
// sign-offs rather than unfulfilled intents, so each is excluded by lookahead.
const EN_INTENT =
  /\b(let me(?!\s+know\b)|i['’]?ll(?!\s+let\s+you\s+know\b)|i will|let['’]?s|one moment|hold on|give me a (?:sec|second|moment)|searching|looking (?:it|that|this) up|checking|i'?m going to|i'?m about to)\b[^.!?\n]{0,80}$/i

// The same gate in Chinese. A gate that reads natural-language MEANING has to fire
// in both scripts the operator writes in, or the nudge silently applies to half
// their turns — the identical asymmetry that made correction capture deaf to CJK.
// No \b anywhere: Han has no word boundaries, so a boundary assertion between two
// Han characters can never match.
const CJK_INTENT =
  /(我来|让我|我去|我先|我这就|我马上|马上|稍等|等一下|我正在|正在|我要|我将|我帮你|帮你(查|搜|看|找)|(查|搜|看|找)一下)[^。！？.!?\n]{0,80}$/
