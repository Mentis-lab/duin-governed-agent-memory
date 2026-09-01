// File-backed memory frontmatter (parity Track 3, prompt D1).
//
// Memory is stored on disk as <slug>.md files under
// `userData/lamprey-memory/<projectSlug>/`. SQLite is a mirror used for
// FTS / index reads; the files are canonical, so external edits and
// version-control are both first-class.

import matter from 'gray-matter'

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'

export const MEMORY_TYPES: readonly MemoryType[] = ['user', 'feedback', 'project', 'reference']

/** Provenance vocabulary — DEFINED IN `electron/shared/memory-source.ts`, which the renderer also
 *  imports. It used to be defined here AND mirrored in `src/lib/types.ts` under a comment asking a
 *  human to "keep the two in step" — one concept, two definitions, agreement held by review rather
 *  than by a mechanism (constitution property 1). Re-exported so existing importers of this module
 *  are unaffected; the rationale for the value set lives with the owner. */
import {
  type MemorySource,
  MEMORY_SOURCES,
  MEMORY_SOURCE_LABELS,
  isMemorySource
} from '../shared/memory-source'

export { type MemorySource, MEMORY_SOURCES, MEMORY_SOURCE_LABELS, isMemorySource }

export interface MemoryFrontmatter {
  name: string
  description: string
  metadata: { type: MemoryType; source: MemorySource }
}

export interface ParsedMemoryFile {
  name: string
  description: string
  type: MemoryType
  source: MemorySource
  body: string
}

export interface MemoryWriteInput {
  name: string
  description?: string
  type: MemoryType
  /** Omitted → 'unknown'. Callers that know their origin MUST pass it; a wrong
   *  default is worse than an honest absence. */
  source?: MemorySource
  body: string
}

const SLUG_MAX = 60

function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === 'string' && (MEMORY_TYPES as readonly string[]).includes(value)
}


// Convert a free-form display name to a filesystem-safe slug used as the
// `<slug>.md` filename. Slugs collapse non-alphanumerics into `_`, force
// lowercase, and clamp length so users can write "Why we ripped out X"
// and get something stable on disk.
export function memorySlug(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (!cleaned) return 'untitled'
  return cleaned.length <= SLUG_MAX ? cleaned : cleaned.slice(0, SLUG_MAX).replace(/_+$/, '')
}

// A project slug becomes the DIRECTORY segment of `<base>/<projectSlug>/<slug>.md`, so this
// character set is a safety boundary (memory-store's `assertSafeProjectSlug` enforces it),
// not a style preference. It lives here, next to the only function that can manufacture a
// conforming value, so the guard and the normaliser below cannot drift apart.
export const MEMORY_PROJECT_SLUG_RE = /^[a-z0-9_]+$/

/**
 * Convert an arbitrary project identifier into a memory project slug.
 *
 * DUIN carries two slug dialects and they are not interchangeable: `projects-store`'s
 * `slugify()` joins words with HYPHENS ('My Project' -> 'my-project'), while memory project
 * slugs are underscore-only. The `memory_add` tool path handed the former straight to the
 * latter, so `assertSafeProjectSlug` threw for every project whose name was not one
 * alphanumeric word and the memory was silently never written.
 *
 * What made it invisible: projects created before schema v15 carry slug='' (falsy, so the
 * caller's '__global__' default fired) — only projects created or renamed by a current build
 * produce a hyphen, and the throw was swallowed into a tool-result string the model could not
 * act on because it does not control the slug.
 *
 * A value that already conforms is returned UNTOUCHED, which is what keeps '__global__'
 * intact: running the sentinel through memorySlug() would strip its underscores to 'global'
 * and orphan the default lane. Blank stays blank so the caller's own default still applies.
 */
export function toMemoryProjectSlug(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  if (MEMORY_PROJECT_SLUG_RE.test(trimmed)) return trimmed
  return memorySlug(trimmed)
}

export function parseMemoryMarkdown(raw: string, fallbackName: string): ParsedMemoryFile {
  const parsed = matter(raw)
  const data = parsed.data ?? {}

  const name =
    typeof data.name === 'string' && data.name.trim() ? data.name.trim() : fallbackName
  const description =
    typeof data.description === 'string' ? data.description.trim() : ''

  const metadataRaw = (data as { metadata?: unknown }).metadata
  let type: MemoryType = 'project'
  // Absent/unreadable provenance is 'unknown' — never inferred. Files written
  // before this field existed parse here and stay honestly unlabelled.
  let source: MemorySource = 'unknown'
  if (metadataRaw && typeof metadataRaw === 'object') {
    const candidate = (metadataRaw as { type?: unknown }).type
    if (isMemoryType(candidate)) type = candidate
    const src = (metadataRaw as { source?: unknown }).source
    if (isMemorySource(src)) source = src
  } else if (isMemoryType((data as { type?: unknown }).type)) {
    // Tolerate flat `type:` at the top level even though our canonical
    // shape nests it under `metadata`. External editors / hand-rolled
    // memory files often skip the nesting.
    type = (data as { type: MemoryType }).type
  }
  // Flat `source:` is tolerated the same way, independently of how `type` was
  // found — a hand-edited file may nest one and not the other.
  if (source === 'unknown' && isMemorySource((data as { source?: unknown }).source)) {
    source = (data as { source: MemorySource }).source
  }

  return {
    name,
    description,
    type,
    source,
    body: parsed.content.trim()
  }
}

export function serializeMemoryMarkdown(input: MemoryWriteInput): string {
  const frontmatter: MemoryFrontmatter = {
    name: input.name,
    description: (input.description ?? '').trim(),
    metadata: { type: input.type, source: isMemorySource(input.source) ? input.source : 'unknown' }
  }
  // gray-matter.stringify wraps with `---` fences and serializes to YAML.
  // Pass the body as the first arg; the data object is the frontmatter.
  return matter.stringify(input.body.trim() + '\n', frontmatter)
}
