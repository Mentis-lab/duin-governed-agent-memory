// people-owed-native — "people you owe follow-ups" for the Home Digest's
// Needs You section. Mirrors server.py:list_conversations filtered to open>0:
// a vault person with open follow-up tasks that reference them. Pure read — task
// scan (taskFiles + parseTaskLine) × vault people (listVaultEntities). No LLM,
// no side effects. The name-match heuristic (assignee OR text mention) is kept
// identical to the Conversations surface so the same person surfaces in both.

import { readFileSync } from 'fs'
import { relative } from 'path'
import { taskFiles } from './throughput'
import { parseTaskLine, type Task } from './causal-substrate'
import { listVaultEntities } from './entities-native'

export interface OwedPerson {
  name: string
  org: string
  /** Count of open (un-done) follow-up tasks referencing this person. */
  open: number
  /** The highest-priority open follow-up's text — the row's why line. */
  top: string
}

const MAX_OWED = 8

/** Sort key over open tasks: priority ascending (1 > 9 > blank), then due. */
function byPriorityThenDue(a: Task, b: Task): number {
  const pa = a.priority || '9'
  const pb = b.priority || '9'
  if (pa !== pb) return pa < pb ? -1 : 1
  const da = a.due || '~'
  const db = b.due || '~'
  return da < db ? -1 : da > db ? 1 : 0
}

/** People with ≥1 open follow-up, most-owed first. Empty when no vault dir or on
 *  any read failure (best-effort — never throws into the digest). */
export function peopleOwed(vaultDir: string | null): OwedPerson[] {
  if (!vaultDir) return []
  const tasks: Task[] = []
  let people: { name: string; org: string }[]
  try {
    for (const fp of taskFiles(vaultDir)) {
      const rel = relative(vaultDir, fp).replace(/\\/g, '/')
      let lines: string[]
      try {
        lines = readFileSync(fp, 'utf-8').replace(/\r\n?/g, '\n').split('\n')
      } catch {
        continue
      }
      lines.forEach((line, i) => {
        const t = parseTaskLine(line, rel, i)
        if (t) tasks.push(t)
      })
    }
    people = listVaultEntities(vaultDir).people.map((p) => ({ name: p.name, org: p.org }))
  } catch {
    return []
  }

  const owed: OwedPerson[] = []
  for (const p of people) {
    const name = p.name
    if (!name) continue
    // Same match rule as list_conversations: an @assignee, or (for names ≥2 chars)
    // a plain mention in the task text.
    const related = tasks.filter(
      (t) => t.people.includes(name) || (name.length >= 2 && t.text.includes(name))
    )
    const open = related.filter((t) => !t.done)
    if (open.length === 0) continue
    const top = [...open].sort(byPriorityThenDue)[0]
    owed.push({ name, org: p.org || '', open: open.length, top: top?.text || '' })
  }

  owed.sort((a, b) => b.open - a.open || a.name.localeCompare(b.name))
  return owed.slice(0, MAX_OWED)
}
