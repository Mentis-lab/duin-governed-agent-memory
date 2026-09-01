// `[[wikilink]]` → markdown link, for the note READ view.
//
// The editor has understood wikilinks for a while (CodeMirror + onOpenWikilink),
// but the read view renders through ReactMarkdown, and markdown has no notion of
// `[[…]]` — so a viewed note showed its links as literal bracket text. This
// rewrites them into ordinary links carrying a `wikilink:` scheme, which the
// renderer intercepts and routes to the same resolver the editor uses.
//
// PURE + code-aware: fenced blocks and inline code are passed through untouched,
// because `[[i]]` inside a code sample is code, not a link.

/** Matches a fenced block (``` or ~~~, any info string) or an inline-code span,
 *  so those regions can be skipped wholesale. */
const CODE_SPANS = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g

/** `[[Target]]`, `[[Target|Alias]]`, `[[Target#Section]]`, `[[Target#Section|Alias]]`.
 *  Non-greedy and newline-free so an unclosed `[[` cannot swallow the document. */
const WIKILINK = /\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g

export const WIKILINK_SCHEME = 'wikilink:'

/** Rewrite wikilinks in `md` into `[label](wikilink:target)`. */
export function linkifyWikilinks(md: string): string {
  if (!md || md.indexOf('[[') === -1) return md
  // Split on code regions; odd indices are the captured code and pass through.
  return md
    .split(CODE_SPANS)
    .map((part, i) => {
      if (i % 2 === 1) return part
      return part.replace(WIKILINK, (_all, target: string, alias?: string) => {
        const t = target.trim()
        if (!t) return _all
        const label = (alias ?? t).trim()
        // encodeURIComponent so spaces, CJK and '#' survive the href round trip.
        return `[${label}](${WIKILINK_SCHEME}${encodeURIComponent(t)})`
      })
    })
    .join('')
}

/** The target behind a `wikilink:` href, or null for an ordinary link. */
export function wikilinkTarget(href: string | undefined): string | null {
  if (!href || !href.startsWith(WIKILINK_SCHEME)) return null
  const raw = href.slice(WIKILINK_SCHEME.length)
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}
