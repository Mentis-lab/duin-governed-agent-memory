import { readFile } from 'fs/promises'

// HTML → visible text for indexing. HTML is increasingly a primary AI OUTPUT
// (decks, tutorials, explainers), so a saved .html should be searchable and
// graph-linkable by what it SAYS, not its markup. We strip scripts/styles/tags
// and decode entities so the index stores rendered text; the raw .html stays on
// disk for viewing/editing. Regex-based on purpose — zero deps, fully offline.

const NAMED_ENTITIES: Record<string, string> = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&apos;': "'", '&#39;': "'", '&mdash;': '—', '&ndash;': '–', '&hellip;': '…'
}

function decodeEntities(s: string): string {
  let out = s.replace(/&[a-z]+;|&#39;/gi, (m) => NAMED_ENTITIES[m.toLowerCase()] ?? m)
  out = out.replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
  out = out.replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)))
  return out
}

export function htmlToText(html: string): { text: string; title: string } {
  // Remove comments + non-content elements entirely.
  let s = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, ' ')

  // Pull a title before the tags are gone: <title>, else first <h1>.
  const titleTag = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
  const h1 = s.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]

  // Turn block-level boundaries into newlines so the text stays readable.
  s = s.replace(/<(\/)?(p|div|section|article|h[1-6]|li|ul|ol|tr|table|header|footer|main|nav|blockquote|pre|br)[^>]*>/gi, '\n')
  s = s.replace(/<[^>]+>/g, ' ')
  // Models sometimes truncate HTML mid-tag (`…<h1 style="col`); strip the dangling
  // opener so it doesn't leak `<h1` into the indexed text.
  s = s.replace(/<[^>]*$/g, ' ')
  s = decodeEntities(s)
  s = s.replace(/[ \t\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()

  const rawTitle = (titleTag || h1 || '').replace(/<[^>]+>/g, ' ')
  const title = decodeEntities(rawTitle).replace(/\s+/g, ' ').trim()
  return { text: s, title }
}

export async function loadHtml(path: string): Promise<{ text: string; mime: string; title: string }> {
  const raw = await readFile(path, 'utf-8')
  const { text, title } = htmlToText(raw)
  return { text, mime: 'text/html', title }
}
