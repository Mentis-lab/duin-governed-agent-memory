// draft_reply (native) — draft the next message the operator would send a contact, grounded in the swept
// conversation note, in the contact's language, advancing the open thread. Port of draft_reply
// (server.py:6784). WRITES NOTHING (returns a draft for review — it does NOT send; sending is
// send-message). Model call injected.

import { readFileSync } from 'fs'
import { join } from 'path'

export type GenerateFn = (prompt: string) => Promise<string>

const SUMMARY_RE = />\s*\*\*概要[：:]\*\*\s*(.+)/
const SECTION_RE = /\n#{2,}[^\n]*(?:议题|待补|进展|下一步|跟进|未决|待办|next|open)[^\n]*\n([\s\S]+?)(?=\n#{2,}|$)/gi
const INLINE_FIELD_RE = /\{\{[^}]*\}\}/g
const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g

/** Extract the substantive conversation context (概要 + 议题/待补/进展/下一步 …) from a swept note,
 *  wikilinks flattened; falls back to the first 1800 chars. Port of the ctx-building in draft_reply. */
export function extractConversationContext(note: string): string {
  const parts: string[] = []
  const sm = SUMMARY_RE.exec(note)
  if (sm) parts.push(sm[1].trim())
  SECTION_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SECTION_RE.exec(note)) !== null) {
    parts.push(m[0].replace(INLINE_FIELD_RE, '').slice(0, 700))
  }
  const joined = parts.join('\n\n').replace(WIKILINK_RE, '$1').trim()
  return joined || note.slice(0, 1800)
}

/** Build the draft prompt — verbatim from server.py:6799-6807. */
export function buildDraftPrompt(person: string, owed: string, thread: string, ctx: string): string {
  const real = thread
    ? `\nTHEIR RECENT ACTUAL MESSAGES (chronological, '→you' = they said it to you):\n${thread}\n`
    : ''
  return (
    // COLD-START A4: the prompt named the author. It now says "the operator", so a second user's
    // drafts are written as THEM rather than as someone they have never met.
    'You are drafting the NEXT short message the OPERATOR will send this contact. Write what the ' +
    'operator would actually send — warm but professional, concrete, moving the thread forward. ' +
    'If RECENT ACTUAL MESSAGES ' +
    'are provided, REPLY TO THE LAST ONE specifically. Match the contact\'s LANGUAGE (中文 for Chinese ' +
    'contacts, 日本語 for Japanese, English for English). 2-4 sentences, no preamble, no salutation-heavy ' +
    'fluff, no signature. Return ONLY the message text.\n\n' +
    `CONTACT: ${person}\n` + (owed ? `OPEN ITEM the operator owes them: ${owed}\n` : '') + real +
    `\nBACKGROUND CONTEXT:\n${ctx.slice(0, 2200)}`
  )
}

export interface DraftReplyResult {
  ok: boolean
  error?: string
  draft?: string
}

/**
 * Draft the next message to a contact from their swept conversation note. Port of draft_reply.
 * `profile` is a vault-relative path to the conversation note.
 */
export async function draftReply(
  vaultDir: string,
  profile: string,
  person: string,
  owed: string,
  thread: string,
  deps: { generate: GenerateFn }
): Promise<DraftReplyResult> {
  let note: string
  try {
    note = readFileSync(join(vaultDir, ...((profile || '').replace(/^\/+/, '').split('/'))), 'utf-8')
  } catch {
    note = ''
  }
  if (!note) return { ok: false, error: 'no conversation context' }
  const ctx = extractConversationContext(note)
  const raw = (await deps.generate(buildDraftPrompt(person, owed, thread, ctx))).trim()
  return { ok: !!raw, draft: raw }
}
