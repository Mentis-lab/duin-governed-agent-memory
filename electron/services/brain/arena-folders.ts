// arena-folders — the ONE canonical rule for "is this top-level folder a user ARENA".
// Shared by spaces-native (the Spaces lens) and projects-native (the Projects rail) so
// they agree, and reused by cards-native to reject pseudo-project field values. Before
// this, the Projects folder-walk treated ANY top-level dir as a project (see
// ARCHITECTURE/EXPLORER_CATEGORIZATION_AUDIT.md P0-1), surfacing note/doc containers
// (04 Notes, Documents, Outputs, DUIN-Docs) as projects.

// Generic pillar / framework / container folder names that are NEVER a user arena
// (lowercased). Extends the former spaces-native GENERIC set with the doc-container
// names (documents / docs / duin-docs) that were leaking into Projects + Spaces.
export const ARENA_GENERIC = new Set([
  'duin', '_agui_outputs', '_agui_uploads', 'knowledge', 'instincts', 'people',
  'decisions', 'planning', 'tasks', 'active', 'rules', 'templates', 'meta', 'identity',
  '00 inbox', '00 raw', '01 wiki', '02 cards', '03 projects', '04 notes', '05 decisions',
  '06 tasks', '07 templates', '08 agents', '09 rules', '10 action', 'about me',
  '99 attachments', 'scholar', 'private',
  'projects', 'orgs', 'people/orgs', 'outputs', 'active work', 'inbox',
  // Doc/system containers — not arenas (were surfacing as false projects).
  'documents', 'docs', 'duin-docs'
])

/** True if a top-level folder name is a candidate user arena: not a dot/underscore
 *  folder, not a generic pillar/container name, not a numbered pillar ("04 Notes").
 *  (Callers still require the folder to actually contain notes.) */
export function isArenaCandidate(name: string): boolean {
  if (name.startsWith('.') || name.startsWith('_')) return false
  if (ARENA_GENERIC.has(name.toLowerCase())) return false
  if (/^\d{2}\s/.test(name)) return false
  return true
}
