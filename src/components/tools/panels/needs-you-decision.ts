import type { NoticeKind } from '@/stores/notices-store'

// One question, asked in one place: can this owed row be decided where it is shown?
//
// It exists because the answer decides whether the row is a dead end. An owed notice is
// never aged out and markRead does not clear it, so a row that offers no decision and whose
// subject is already gone leads the inbox and Home forever. That happened: a keyless-review
// card outlived the belief it was raised for, and Home read it as "a decision is waiting on
// you" while the Learning panel it pointed at had nothing to ratify. Rows that answer false
// here get the Dismiss verb.

export interface OwedRow {
  actionId?: string
  kind: NoticeKind
  /** A staged self-tune matched this row's actionId (rsi:pending). */
  hasStagedRsi: boolean
  /** Beliefs behind the keyless-review card, which is what its Ratify/Veto act on. */
  awaitingCount: number
}

/** True when the row carries its own decision. Pure: the panel renders from this answer. */
export function hasInlineDecision(row: OwedRow): boolean {
  if (row.hasStagedRsi) return true
  if (row.kind === 'loop' && !!row.actionId) return true
  if (row.actionId === 'govern:keyless-review') return row.awaitingCount > 0
  return false
}
