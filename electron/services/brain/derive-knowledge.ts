// Knowledge derivations — the keyless, structural half of three DUIN native
// surfaces (Meetings · Outputs · Mental Models). Where the causal engines read
// a Store, these read the indexed notes DIRECTLY (allChunks → grouped by file)
// and classify each note by three case-insensitive signals: frontmatter `type`,
// a `#tag`, or a folder in the path. No LLM, no provider key — pure parsing, so
// a standalone user with a notes folder sees these populate immediately.
//
// The node `id` returned for each item is the note's relpath, which is exactly
// the CausalNode.id deriveGraph() assigns (electron/services/local-brain/
// graph-derive.ts). That lets the renderer call useBrainStore().focusNode(id)
// to jump the Brain graph to the same note. Keep the parsing in lockstep with
// graph-derive's frontmatter/wikilink conventions.

import { allChunks } from '../local-brain/index-store'
import { groupChunksByFile } from './extraction-util'
import { getResolvedConstruction } from './construct'
import type { ConstructedData, NoteClassification } from './types'

export interface PersonItem {
  /** Graph node id — a constructed `person:*` entity id, or a person-note
   *  relpath. Clicking focuses this node in the Brain graph. */
  id: string
  name: string
  /** Source note (relpath) the person was found in / typed as, if any. */
  note?: string
  /** How many notes link to / mention this person (rough salience). */
  mentions?: number
}

const ISO = /\d{4}-\d{2}-\d{2}/

interface ParsedNote {
  file: string
  /** Raw note body (frontmatter stripped). */
  body: string
  type: string | null
  status: string | null
  /** Lowercased frontmatter `date`/`due`/… value, ISO if parseable. */
  fmDate: string | null
  tags: string[]
  /** Lowercased path segments (folders + filename). */
  segments: string[]
  /** [[wikilink]] targets, in document order, de-duplicated. */
  links: string[]
}

/** Reassemble per-file text from chunks (chunks arrive in file/chunk order). */
function groupByFile(): { file: string; text: string }[] {
  return groupChunksByFile(allChunks())
}

/** Parse the leading `---`…`---` block. Tolerant: only the keys we use, plus
 *  tags (inline list / token). Mirrors graph-derive.parseFrontmatter. */
function parseNote(file: string, text: string): ParsedNote {
  const note: ParsedNote = {
    file,
    body: '',
    type: null,
    status: null,
    fmDate: null,
    tags: [],
    segments: file.toLowerCase().split('/'),
    links: []
  }
  // eslint-disable-next-line no-irregular-whitespace -- optional BOM before YAML frontmatter
  const m = text.match(/^﻿?\s*---\r?\n([\s\S]*?)\r?\n---/)
  let body = text
  if (m) {
    body = text.slice(m[0].length)
    const dateKeys = ['date', 'due', 'deadline', 'created', 'when']
    for (const rawLine of m[1].split(/\r?\n/)) {
      const kv = rawLine.trim().match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/)
      if (!kv) continue
      const key = kv[1].toLowerCase()
      let val = kv[2].trim().replace(/^["']|["']$/g, '')
      if ((key === 'type' || key === 'kind' || key === 'category') && val) {
        note.type = val.toLowerCase()
      } else if (key === 'status' || key === 'state') {
        if (val) note.status = val
      } else if (dateKeys.includes(key) && !note.fmDate) {
        const d = val.match(ISO)
        note.fmDate = d ? d[0] : null
      } else if (key === 'tags' || key === 'tag') {
        val = val.replace(/^\[|\]$/g, '')
        note.tags.push(
          ...val.split(/[,\s]+/).map((t) => t.replace(/^#/, '').toLowerCase()).filter(Boolean)
        )
      }
    }
  }
  note.body = body

  // Inline `#tag`s in the body (word chars + hyphen; not part of a URL/heading).
  const tagRe = /(?:^|\s)#([A-Za-z][\w-]*)/g
  let tm: RegExpExecArray | null
  while ((tm = tagRe.exec(body)) !== null) {
    const t = tm[1].toLowerCase()
    if (!note.tags.includes(t)) note.tags.push(t)
  }

  // [[wikilink]] targets (strip alias/anchor), in order, de-duplicated.
  const linkRe = /\[\[([^\]]+?)\]\]/g
  let lm: RegExpExecArray | null
  while ((lm = linkRe.exec(body)) !== null) {
    const target = lm[1].trim().split('#')[0].split('|')[0].trim()
    if (target && !note.links.includes(target)) note.links.push(target)
  }
  return note
}

function parseAllNotes(): ParsedNote[] {
  return groupByFile().map(({ file, text }) => parseNote(file, text))
}

function isPersonNote(note: ParsedNote): boolean {
  return (
    note.type === 'person' ||
    note.type === 'people' ||
    hasTag(note, ['person', 'people']) ||
    inFolder(note, ['People', 'Persons', 'Contacts'])
  )
}

/** Title: first markdown H1, else filename without extension. */
function deriveTitle(file: string, body: string): string {
  const h1 = body.match(/^\s*#\s+(.+?)\s*$/m)
  if (h1 && h1[1].trim()) return h1[1].trim()
  const base = file.split('/').pop() ?? file
  return base.replace(/\.(md|markdown|txt)$/i, '')
}

/** Template-engine tokens that betray a Templater / Jinja / Liquid template
 *  file rather than a real entity ({{name}}, <% tp.file.title %>, {% … %}). */
const TEMPLATE_TOKENS = ['{{', '}}', '<%', '%>', 'tp.', '{%']

/**
 * True when a note is a TEMPLATE or an INDEX/HUB note, not a real entity — so
 * People/Orgs lists never surface junk like `<% tp.file.title %>`, `{{name}}`
 * (Templater template files) or `_CRM.md` ("CRM — relationships to tend", a
 * folder hub). Conservative: only filenames/titles carrying unambiguous
 * template/index signals are dropped; ordinary person/org notes pass through.
 *
 * Drops when ANY of:
 *  - template file: basename starts with `Template` (case-insensitive), OR a
 *    `templates/`/`Templates` folder is in the path;
 *  - the derived title/name carries a template token ({{ }} <% %> tp. {%);
 *  - index/hub file: basename starts with `_` (e.g. `_CRM`), OR the basename
 *    IS `CRM` / `MOC` / `index` (case-insensitive) — folder hub / map-of-content.
 *
 * PURE — testable.
 */
function isTemplateOrIndex(file: string, title: string): boolean {
  const base = (file.split('/').pop() ?? file).replace(/\.(md|markdown|txt)$/i, '')
  const baseLower = base.toLowerCase()
  const segs = file.toLowerCase().split('/')

  // Template file by name / folder.
  if (baseLower.startsWith('template')) return true
  if (segs.slice(0, -1).some((seg) => seg.replace(/[\s-]+/g, '') === 'templates')) return true

  // Template tokens leaking into the file name OR the derived title/name.
  const hay = `${base} ${title}`
  if (TEMPLATE_TOKENS.some((tok) => hay.includes(tok))) return true

  // Index / hub / MOC note.
  if (base.startsWith('_')) return true
  if (['crm', 'moc', 'index'].includes(baseLower)) return true

  return false
}

/** First ~`max` chars of the body, frontmatter + leading H1 stripped. */
function hasTag(note: ParsedNote, tags: string[]): boolean {
  return note.tags.some((t) => tags.includes(t))
}

function inFolder(note: ParsedNote, folders: string[]): boolean {
  // Match any path segment EXCEPT the filename (last segment) against a folder
  // name (case-insensitive, space/hyphen-insensitive).
  const wanted = folders.map((f) => f.toLowerCase().replace(/[\s-]+/g, ''))
  return note.segments
    .slice(0, -1)
    .some((seg) => wanted.includes(seg.replace(/[\s-]+/g, '')))
}

// ── Meetings ────────────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12
}

const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'

/* RETIRED 2026-08-04 — Meetings · Outputs · Mental Models.
 *
 * `deriveMeetings` / `deriveOutputs` / `deriveMentalModels` and their supporting classifiers,
 * date parsing and attendee resolution lived here. Each classifier was a four-way disjunction —
 * a frontmatter `type`, a tag, a folder name (`Mental Models`, `Frameworks`, `Meetings`), and an
 * LLM classification — with NO precedence between the four and no mutual exclusion. `isMentalModel`
 * never consulted `isPersonNote`, which sits directly above it, so a person note the model happened
 * to classify as a framework appeared in both lists.
 *
 * On a vault organised by workstream rather than by those folder names, the first three signals
 * never fire, which reduces the whole thing to "whatever the model guessed about this prose". That
 * is not a category — it is a coin flip with a label on it.
 *
 * The Explorer offers operator-authored tags instead: a category you declared, that you can pin,
 * that means what you meant. `derivePeople` below is deliberately NOT retired — it reads
 * constructed `person:*` graph nodes and person-note frontmatter, which is evidence, not opinion.
 */

export function collectPeople(
  notes: ParsedNote[],
  construction: ConstructedData | null
): PersonItem[] {
  const byId = new Map<string, PersonItem>()

  // (1) Constructed `person:*` entities (from raw prose). Mention count = number
  //     of construction edges that touch the person id (in either direction).
  if (construction) {
    const edgeTouch = new Map<string, number>()
    for (const e of construction.edges) {
      edgeTouch.set(e.source, (edgeTouch.get(e.source) ?? 0) + 1)
      edgeTouch.set(e.target, (edgeTouch.get(e.target) ?? 0) + 1)
    }
    for (const ent of construction.entities) {
      if (ent.kind !== 'person') continue
      if (byId.has(ent.id)) continue
      // Drop template/index junk even when it slipped into the construction.
      if (isTemplateOrIndex(ent.note ?? ent.id, ent.label)) continue
      byId.set(ent.id, {
        id: ent.id,
        name: ent.label,
        ...(ent.note ? { note: ent.note } : {}),
        mentions: edgeTouch.get(ent.id) ?? 0
      })
    }
  }

  // (2) Person-NOTES (frontmatter/tag/folder). id = note relpath. Mention count
  //     = how many OTHER notes wikilink to this person (by basename or relpath).
  const personNotes = notes.filter(isPersonNote)
  for (const pn of personNotes) {
    if (byId.has(pn.file)) continue
    const title = deriveTitle(pn.file, pn.body)
    // Skip Templater template files (`<% tp.file.title %>`, `{{name}}`) and
    // index/hub notes (`_CRM.md` → "CRM — relationships to tend") — they match
    // isPersonNote's folder/tag heuristics but are NOT people.
    if (isTemplateOrIndex(pn.file, title)) continue
    const base = (pn.file.split('/').pop() ?? pn.file).replace(/\.(md|markdown|txt)$/i, '')
    const baseLower = base.toLowerCase()
    const relLower = pn.file.replace(/\.(md|markdown|txt)$/i, '').toLowerCase()
    let mentions = 0
    for (const other of notes) {
      if (other.file === pn.file) continue
      if (other.links.some((l) => {
        const t = l.toLowerCase()
        return t === baseLower || t === relLower
      })) {
        mentions++
      }
    }
    byId.set(pn.file, {
      id: pn.file,
      name: title,
      note: pn.file,
      mentions
    })
  }

  return [...byId.values()].sort(
    (a, b) => (b.mentions ?? 0) - (a.mentions ?? 0) || a.name.localeCompare(b.name)
  )
}

export function derivePeople(): { people: PersonItem[] } {
  // RESOLVED, not raw. `getConstruction()` returns the pre-alias census, so a person the whitelist
  // has already collapsed onto a canonical id was listed here under whichever surface form the
  // extractor last emitted — an id that no longer exists in the graph the operator is looking at.
  // Every other consumer of the census resolves first; this one did not, and the divergence is not
  // hypothetical (13 person ids differed from the graph on the live vault, 2026-08-04). The
  // resolver is memoized per construction generation, so this costs nothing on the repeat call.
  return { people: collectPeople(parseAllNotes(), getResolvedConstruction()) }
}
