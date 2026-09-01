/* global agent, args, log, memory, phase */

export const meta = {
  name: 'consolidate-memory',
  description:
    'Merge duplicate or near-duplicate typed memory entries, write the consolidated files, and delete entries fully represented by the merge.',
  phases: [
    { title: 'Load' },
    { title: 'Consolidate' },
    { title: 'Write' }
  ]
}

const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference']
const requestedType = args && args.type ? String(args.type) : 'project'
const type = MEMORY_TYPES.includes(requestedType) ? requestedType : 'project'

function compactEntry(entry) {
  return {
    name: String(entry && entry.name ? entry.name : ''),
    projectSlug: String(entry && entry.projectSlug ? entry.projectSlug : '__global__'),
    description: String(entry && entry.description ? entry.description : ''),
    type: String(entry && entry.type ? entry.type : type),
    body: String(entry && entry.body ? entry.body : '')
  }
}

function extractJson(value) {
  if (value && typeof value === 'object') return value
  const text = String(value || '').trim()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1))
    }
  }
  return null
}

phase('Load')
const supplied = args && Array.isArray(args.entries) ? args.entries : null
const loaded = supplied || await memory.list({ type })
const entries = loaded
  .map(compactEntry)
  .filter((entry) => entry.name && entry.type === type && entry.body.trim())

if (entries.length < 2) {
  return { type, kept: entries.length, written: 0, deleted: 0, note: 'fewer than two entries' }
}

phase('Consolidate')
const proposal = await agent(
  `You are consolidating DUIN memory files of type "${type}".

Input entries are JSON. Merge only true duplicates or near-duplicates. Preserve distinct facts and user preferences. Do not invent facts. Prefer existing names when keeping entries; if you create a new merged name, use lowercase slug-friendly words. Delete an input entry only when its facts are fully represented by an entry you return.

Return exactly this JSON object and nothing else:
{
  "entries": [
    { "name": "existing_or_new_name", "projectSlug": "__global__", "description": "short hook", "body": "complete markdown body" }
  ],
  "deleteNames": ["obsolete_entry_name"]
}

Input entries:
${JSON.stringify(entries, null, 2)}`,
  {
    label: 'memory-consolidator',
    phase: 'Consolidate',
    agentType: 'general',
    model: 'pro'
  }
)

const parsed = extractJson(proposal)
const proposedEntries = parsed && Array.isArray(parsed.entries) ? parsed.entries : []
const proposedDeleteNames = parsed && Array.isArray(parsed.deleteNames) ? parsed.deleteNames : []

const byName = new Map(entries.map((entry) => [entry.name, entry]))
const writes = proposedEntries
  .map((entry) => {
    const fallback = byName.get(String(entry && entry.name ? entry.name : '')) || entries[0]
    return {
      name: String(entry && entry.name ? entry.name : fallback.name),
      projectSlug: String(entry && entry.projectSlug ? entry.projectSlug : fallback.projectSlug),
      description: String(entry && entry.description ? entry.description : fallback.description),
      type,
      body: String(entry && entry.body ? entry.body : fallback.body)
    }
  })
  .filter((entry) => entry.name && entry.body.trim())

const deleteNames = proposedDeleteNames
  .map((name) => String(name || '').trim())
  .filter((name) => byName.has(name))

// Abstain unless there is something to WRITE. A consolidation deletes an entry only
// because its facts were merged into a written entry, so zero writes means there is no
// merge to justify any deletion. This must not be `writes.length === 0 && deleteNames
// .length === 0`: a reply that proposes deletions but no usable entries (entries omitted,
// renamed, null, or an array of strings rather than objects — all coerced to [] above)
// would fall through that conjunction, no-op the write loop, and then delete. Total parse
// failure already abstains here; a partial/deviant-but-parseable reply must not do more
// damage than a correct one.
if (writes.length === 0) {
  const note = deleteNames.length
    ? 'no entries returned — refusing to delete ' + deleteNames.length + ' entries with nothing merged in their place'
    : 'no consolidation proposed'
  if (deleteNames.length) log('Consolidation abstained: ' + note + '.')
  return { type, kept: entries.length, written: 0, deleted: 0, note }
}

phase('Write')
const written = []
for (const entry of writes) {
  written.push(await memory.write(entry))
}

// Deletion is deliberately NOT gated on the deleted body's words reappearing in a written
// one. Consolidation merges *near*-duplicates, so the surviving entry is usually a
// paraphrase — scoring text overlap would refuse exactly the merges this workflow exists
// to perform (and repeat the exact-text-matching mistake that made a previous consolidator
// destructive). Recoverability, not textual proof, is what makes this safe: `memory.delete`
// soft-deletes into `<lamprey-memory>/.trash` with a journal line recording what was
// removed, from where and when, so a misjudged merge is reversible rather than fatal.
//
// The "don't delete what we just wrote" guard has to span BOTH identity spaces this loop
// straddles. `writes[].name` is the model's RAW proposal; `memory.write` normalises it
// through `memorySlug`, so an entry proposed as "Feedback Style" lands on — and correctly
// overwrites — the existing `feedback_style` file. `deleteNames` was filtered against the
// index above, so it only ever holds canonical names. Comparing one against the other
// missed, and this loop soft-deleted the very entry the Write phase had just produced:
// both originals AND the merge gone, recoverable only from .trash, with nothing telling
// the user to look there. What made it invisible: the model usually echoes an existing
// slug verbatim, so the two spaces coincide and the guard appears to work — it is the
// common title-case/whitespace slip that splits them, and the prompt only *prefers*
// existing names. `memory.write` returns the canonical name it settled on, so add that;
// keep the raw proposals too, so a write result without a usable name can only ever make
// this set bigger, never silently empty it.
const writeNames = new Set()
for (let i = 0; i < writes.length; i += 1) {
  writeNames.add(writes[i].name)
  const canonical = written[i] && written[i].name
  if (canonical) writeNames.add(String(canonical))
}
let deleted = 0
for (const name of deleteNames) {
  if (writeNames.has(name)) continue
  const removed = await memory.delete(name)
  if (removed) deleted += 1
}

log('Consolidated ' + entries.length + ' ' + type + ' memories into ' + written.length + ' writes; deleted ' + deleted + '.')

return {
  type,
  scanned: entries.length,
  written: written.length,
  deleted,
  // Report the canonical names too — same reason as the guard above. Echoing the raw
  // proposal here named an entry the user cannot find: "Feedback Style" is not what is
  // on disk or in the memory panel, `feedback_style` is.
  keptNames: writes.map((entry, i) => String((written[i] && written[i].name) || entry.name))
}
