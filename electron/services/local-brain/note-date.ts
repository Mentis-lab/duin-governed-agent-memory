// note-date — when is a note ABOUT, as distinct from when its bytes last changed.
//
// Retrieval had no answer to that question. The only temporal machinery was a recency BOOST over
// `mtime`, which ranks a note higher for being recently touched — useful, and not the same thing at
// all. A question scoped to a period ("my last two weeks") wants a FILTER over when the note is
// about, and a filter has nothing to filter on unless the date is persisted.
//
// `parseDateFromName` already existed inside graph-derive.ts, module-private, with one caller. It
// lives here now so the index and the graph cannot drift into two different ideas of a note's date —
// the same one-concept-one-owner reason the rest of this codebase keeps shared predicates central.
//
// PRECEDENCE, and why: frontmatter -> filename -> mtime. Frontmatter is the operator SAYING what the
// note is about, so it wins. A dated filename (2026-07-01-standup.md) is the same statement in a
// weaker form. mtime is a guess, and is recorded as such — a file touched by a bulk reformat has an
// mtime that says nothing about its subject. Which rule won is stored alongside the value, because a
// consumer that cannot tell a declared date from a guessed one will eventually treat them alike.

/** Which rule produced a note's date. `mtime` is a fallback, not a claim about content. */
export type NoteDateSource = 'frontmatter' | 'filename' | 'mtime'

export interface NoteDate {
  /** epoch ms, UTC midnight for declared dates; the raw stat value for `mtime`. */
  date: number
  src: NoteDateSource
}

/** A leading `YYYY-MM-DD` (or `_`/`.` separated) anywhere in the basename. */
export function parseDateFromName(f: string): number | null {
  const base = f.split('/').pop() ?? f
  const m = /(\d{4})[-_.](\d{2})[-_.](\d{2})/.exec(base)
  if (!m) return null
  const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`)
  return Number.isNaN(t) ? null : t
}

/** A `date:` (or `created:`) key in leading YAML frontmatter.
 *
 *  Deliberately NOT a YAML parser: this runs over every note on every reindex, and the shapes that
 *  matter are `date: 2026-07-01` and its quoted variants. Anything richer falls through to the next
 *  precedence rung rather than being half-understood — a wrong date is worse than no date, because
 *  a window silently excludes the note instead of visibly lacking one. */
export function parseDateFromFrontmatter(raw: string): number | null {
  if (!raw.startsWith('---')) return null
  const end = raw.indexOf('\n---', 3)
  if (end === -1) return null
  const fm = raw.slice(3, end)
  const m = /^[ \t]*(?:date|created)[ \t]*:[ \t]*['"]?(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/im.exec(fm)
  if (!m) return null
  const mo = m[2].padStart(2, '0')
  const d = m[3].padStart(2, '0')
  const t = Date.parse(`${m[1]}-${mo}-${d}T00:00:00Z`)
  return Number.isNaN(t) ? null : t
}

/** Resolve a note's date by precedence, recording which rule won.
 *
 *  Returns null ONLY when there is nothing at all to go on (no frontmatter, no dated filename, and
 *  no usable mtime). A null is stored as SQL NULL and means unknown — never back-filled with "now",
 *  and never treated as out-of-range by a window filter, because silently dropping undated notes
 *  would shrink the corpus in a way no one could see. */
export function resolveNoteDate(raw: string, relPath: string, mtime: number): NoteDate | null {
  const fm = parseDateFromFrontmatter(raw)
  if (fm !== null) return { date: fm, src: 'frontmatter' }
  const fn = parseDateFromName(relPath)
  if (fn !== null) return { date: fn, src: 'filename' }
  if (Number.isFinite(mtime) && mtime > 0) return { date: Math.round(mtime), src: 'mtime' }
  return null
}
