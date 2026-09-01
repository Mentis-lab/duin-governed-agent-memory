// meeting-write-native — confirm/dismiss a detected meeting. Port of meeting_action.
// Owns meetings.jsonl (.duin/_state/meetings.jsonl) — the same store simple-reads-native
// reads. Pure fs write (no model). A found meeting is always re-saved (matches Python);
// confirm→'confirmed', dismiss→'dismissed', any other action leaves status untouched.
import { readFileSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import { messageOf } from '../guarded'

const meetingsPath = (vaultDir: string): string => join(vaultDir, '.duin', '_state', 'meetings.jsonl')

function loadJsonl(path: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  let txt: string
  try {
    txt = readFileSync(path, 'utf-8')
  } catch {
    return rows
  }
  for (const ln of txt.split(/\r?\n/)) {
    const s = ln.trim()
    if (!s) continue
    try {
      rows.push(JSON.parse(s) as Record<string, unknown>)
    } catch (e) { console.debug('[meeting-write-native] skip malformed:', messageOf(e)) }
  }
  return rows
}

function saveJsonl(path: string, rows: Record<string, unknown>[]): void {
  const body = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, body, 'utf-8')
  renameSync(tmp, path)
}

export interface MeetingActionResult {
  ok: boolean
  error?: string
  id?: string
  status?: unknown
}

/** Confirm/dismiss a meeting by id. Port of meeting_action. */
export function meetingAction(vaultDir: string | null, mid: string, action: string): MeetingActionResult {
  if (!vaultDir) return { ok: false, error: 'not found' }
  const ms = loadJsonl(meetingsPath(vaultDir))
  for (const m of ms) {
    if (m.id === mid) {
      if (action === 'confirm' || action === 'dismiss') {
        m.status = action === 'confirm' ? 'confirmed' : 'dismissed'
      }
      saveJsonl(meetingsPath(vaultDir), ms) // saved regardless (matches Python)
      return { ok: true, id: mid, status: m.status }
    }
  }
  return { ok: false, error: 'not found' }
}
