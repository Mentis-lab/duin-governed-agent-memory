// memory-source — THE owner of the memory-provenance vocabulary.
//
// This lived in two places: `electron/services/memory-frontmatter.ts` (the writer/parser side) and
// `src/lib/types.ts` (the renderer side), the second carrying the comment "Mirrors MemorySource in
// electron/services/memory-frontmatter.ts... Keep the two in step." That is constitution property 1
// exactly: one concept, two definitions, and the agreement held by a comment asking a human to
// remember rather than by a mechanism. The file's own example of the failure mode is three lists
// that each encoded "this is not a user note", every site individually correct and well-commented,
// with nobody owning the concept.
//
// It lives in `shared/` and not in `services/` because the renderer must be able to import it: the
// writer-side module pulls in `gray-matter`, which has no business in the web bundle. Dependency-
// free by design — the moment this file imports anything, one of its two consumers has to stop
// importing it and the drift starts again.
//
// PROVENANCE, and why the value set is what it is:
//
//  `unknown` is a first-class value, not a hole to be filled in later. Every memory written before
//  provenance existed is genuinely of unknown origin, and back-guessing it from timestamps or
//  conversation ids would manufacture exactly the confidence this field exists to make honest. It
//  stays `unknown` forever.
//
//  The values split by WHO asserted the fact, which is the only split that answers "ground this on
//  what I actually told you":
//    operator  — `user-explicit` (stated directly), `session` (stated in a conversation). Different
//                channel, same authority.
//    DUIN      — `inferred` (extracted from a turn), `reflection` (concluded by a reflection pass).
//                Both must EARN trust; neither may ever masquerade as something the operator
//                asserted.
//    elsewhere — `imported`.
//
//  `inferred` exists so that operator-model's `machine` facts have somewhere honest to land.
//  Mapping them to `session` — the obvious-looking move, since both arise mid-conversation — would
//  relabel model guesses as operator statements and destroy the distinction this field exists for.
//
// STATED LIMIT (property 5): `reflection` currently has NO EMITTER. Measured 2026-07-31 — nothing
// in `electron/` or `src/` ever writes it, so the MemoryPanel's provenance filter offers a bucket
// that can never match. It is kept rather than deleted because removing a value would downgrade any
// legacy row that already carries it to `unknown`, which is a worse outcome than an empty filter;
// `MEMORY_SOURCES_WITHOUT_EMITTER` records the fact so the claim cannot rot silently.

export type MemorySource =
  | 'user-explicit'
  | 'session'
  | 'inferred'
  | 'reflection'
  | 'imported'
  | 'unknown'

export const MEMORY_SOURCES: readonly MemorySource[] = [
  'user-explicit',
  'session',
  'inferred',
  'reflection',
  'imported',
  'unknown'
]

/** Human-facing labels — the words the UI and the glossary both use. */
export const MEMORY_SOURCE_LABELS: Readonly<Record<MemorySource, string>> = {
  'user-explicit': 'You told me',
  session: 'From a conversation',
  inferred: 'DUIN inferred',
  reflection: 'DUIN concluded',
  imported: 'From your vault',
  unknown: 'Unknown origin'
}

/** Values no code path currently produces. See the STATED LIMIT above; pinned by a test. */
export const MEMORY_SOURCES_WITHOUT_EMITTER: readonly MemorySource[] = ['reflection']

export function isMemorySource(value: unknown): value is MemorySource {
  return typeof value === 'string' && (MEMORY_SOURCES as readonly string[]).includes(value)
}
