// verify-observations.ts — PURE parsers that turn a background brain-task's reply
// text into the observations the 2BRAIN verify gate + DoD gate consume at commit:
//   - citedNotes / orphanCitations → the "no-orphan-claims" DoD criterion + the
//     verify gate's grounding check (a cited note that doesn't exist is a hallucinated
//     provenance claim).
//   - coveredTracks → the "covers-active-tracks" DoD criterion for a covering task.
//
// PURE: no I/O. The note-existence check is injected (`exists`) so the caller supplies
// the real vault lookup and this module stays unit-testable. Kept OUT of any module
// that imports electron so it loads under vitest (the test-load trap).

/** Extract note references cited in free text: `[foo.md]`, `(path/to/foo.md)`, or
 *  `` `foo.md` ``. Deduped, trimmed. Only .md references (a provenance citation). */
export function parseCitedNotes(text: string): string[] {
  if (!text) return []
  const out = new Set<string>()
  const re = /[[(`]\s*([^[\]()`\n]{1,200}?\.md)\s*[\])`]/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const ref = m[1].trim()
    if (ref) out.add(ref)
  }
  return [...out]
}

/** Of the cited notes, those that do NOT resolve to a real note via the injected
 *  `exists`. CONSERVATIVE by design: a citation `exists` cannot confirm is treated
 *  as PRESENT (not an orphan), because a false orphan would needlessly re-run the
 *  task. Only a citation `exists` positively rejects is flagged. */
export function orphanCitations(citedNotes: string[], exists: (ref: string) => boolean): string[] {
  const orphans: string[] = []
  for (const ref of citedNotes) {
    let ok: boolean
    try {
      ok = exists(ref)
    } catch {
      ok = true // lookup failed ⇒ can't prove orphan ⇒ don't flag (fail-safe-open)
    }
    if (!ok) orphans.push(ref)
  }
  return orphans
}

/** Which of `trackKeys` the reply text covers (case-insensitive substring). A track
 *  key like "ProjectA" / "PartnerCo" / "Tooling" appearing anywhere in the output counts as covered.
 *  Lenient on purpose: a false "missed track" only costs a re-run, but we still want
 *  a genuinely dropped track to surface. */
export function coveredTracksIn(text: string, trackKeys: string[]): string[] {
  if (!text) return []
  const lower = text.toLowerCase()
  const covered: string[] = []
  for (const k of trackKeys) {
    if (k && lower.includes(k.toLowerCase())) covered.push(k)
  }
  return covered
}

/** Does the loop instruction describe a COVERING task (digest / summary / roll-up /
 *  overview across tracks)? Only then does covers-active-tracks apply. */
export function expectsCoverage(instruction: string | null | undefined): boolean {
  return /\b(digest|summary|summari[sz]e|roll.?up|overview|recap|across (all )?(the )?tracks|all tracks|every track)\b/i.test(
    instruction ?? ''
  )
}
