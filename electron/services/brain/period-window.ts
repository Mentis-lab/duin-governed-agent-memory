// period-window — turn "写一份双周报" into the fortnight it is actually asking about.
//
// THE FAILURE THIS ADDRESSES. A periodic report is an AGGREGATION over a window, and retrieval
// answered it with a top-k ranking. Measured on the real vault: 138 notes fall inside a given
// fortnight and `searchK` returned 6 — 4% coverage — and because searchK is hard-clamped to 30,
// breadth could not close the gap either. The repo's own `aggregation-arms.eval` had already found
// stock DUIN 0/18 on aggregation and searchK=30 ALSO 0/18: "breadth is not the fix". The fix is
// eligibility, which is a filter, and a filter needs a window.
//
// PURE and dependency-free so it is unit-testable without a vault, a clock, or a model. `now` is
// injected for the same reason.

/** Half-open `[from, to)` in epoch ms. Matches index-store's DateWindow. */
export interface ResolvedWindow {
  from: number
  to: number
  /** Which phrase produced it — carried so a caller can say WHY it scoped the search. */
  label: string
}

const DAY = 86_400_000

/** The CJK periodic-report family. `报告` deliberately does NOT match these: 双周报 / 周报 / 月报 end
 *  in a bare 报, which is why the vault's highest-stakes recurring artifact used to fall through
 *  while the English "biweekly report" routed correctly. */
const PERIODIC = /(双周|半月|周|月|季度?|年)报|biweekly|bi-weekly|fortnight|weekly report|monthly report|quarterly report/i

/** Does this read as a request for a PERIODIC report?
 *
 *  Deliberately does NOT inherit generative-intent's FILE_SIGNAL suppression. "写双周报存到
 *  reports/w29.md" still wants period-scoped retrieval — that it ALSO wants a file written is a
 *  separate question about the output, not about which notes are eligible as input. */
export function looksLikePeriodicReport(query: string): boolean {
  return PERIODIC.test(query ?? '')
}

/** UTC midnight of the day containing `t`. Windows are day-granular because note_date is: a
 *  frontmatter or filename date carries no time, so sub-day precision would be invented. */
function startOfDay(t: number): number {
  const d = new Date(t)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

/** An explicit range the operator wrote out: `2026-06-08..2026-06-21`, `2026/06/08 - 2026/06/21`,
 *  or the CJK `2026年6月8日到6月21日` shape reduced to two parseable dates. */
function explicitRange(q: string): ResolvedWindow | null {
  const dates = [...q.matchAll(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/g)].map((m) =>
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  )
  if (dates.length < 2) return null
  const from = Math.min(dates[0], dates[1])
  const to = Math.max(dates[0], dates[1])
  // `to` is the last day the operator named, and they mean it INCLUSIVELY — so admit that whole day.
  return { from, to: to + DAY, label: 'explicit range' }
}

/**
 * Resolve the window a periodic-report query is asking about, or null when nothing resolves.
 *
 * Null is a real answer and the common one: it means "search unwindowed", which is today's
 * behaviour. This never guesses — a wrong window is worse than no window, because it silently
 * excludes the evidence rather than visibly failing to narrow.
 *
 * The windows END at today rather than at the last completed period boundary. Someone asking for a
 * 双周报 on a Wednesday wants the fortnight up to now, including this week — a report that stopped
 * at the last period boundary would omit the days they most need to write about.
 */
export function resolvePeriodWindow(query: string, now: number = Date.now()): ResolvedWindow | null {
  const q = query ?? ''
  if (!q.trim()) return null

  const explicit = explicitRange(q)
  if (explicit) return explicit

  if (!looksLikePeriodicReport(q)) return null

  const end = startOfDay(now) + DAY // through the end of today
  // Order matters: 双周 contains 周, and 半月 contains 月, so the longer periods are tested first.
  if (/双周|半月|biweekly|bi-weekly|fortnight/i.test(q)) return { from: end - 14 * DAY, to: end, label: '双周 / fortnight' }
  if (/季度?报|quarterly/i.test(q)) return { from: end - 91 * DAY, to: end, label: '季度 / quarter' }
  if (/年报|annual|yearly/i.test(q)) return { from: end - 365 * DAY, to: end, label: '年 / year' }
  if (/月报|monthly/i.test(q)) return { from: end - 30 * DAY, to: end, label: '月 / month' }
  if (/周报|weekly/i.test(q)) return { from: end - 7 * DAY, to: end, label: '周 / week' }
  return null
}
