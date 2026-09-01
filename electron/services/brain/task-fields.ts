// Shared task-id inline-field names for DUIN's native task system.
//
// DUIN tasks carry an inline id field on their markdown line, e.g. `{{duinTaskId:: cap-1a2b3c4d}}`.
// NEW tasks are always written with `duinTaskId` (DUIN owns its task format). Early DUIN builds
// borrowed the external "Operon" Obsidian plugin's `operonId` field; those lines still live in
// users' real vaults, so every READER must fall back to the legacy field to stay compatible.
//
// Read pattern (prefer native, fall back to legacy, then positional id):
//   fields[TASK_ID_FIELD] ?? fields[LEGACY_TASK_ID_FIELD] ?? `${source}#${idx}`
// Write pattern (native only):
//   `{{${TASK_ID_FIELD}:: ${id}}}`

/** DUIN-native task-id inline field. Written for all NEW tasks. */
export const TASK_ID_FIELD = 'duinTaskId'

/** Legacy task-id inline field from the external Operon plugin. READ-only (back-compat); never written. */
export const LEGACY_TASK_ID_FIELD = 'operonId'
