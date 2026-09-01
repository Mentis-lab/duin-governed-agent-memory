// named-skill-store — the I/O half of named-skill (pure logic in named-skill.ts), mirroring
// binding-store / learn-store (coherent-ownership: pure logic testable without disk). Owns
// .duin/_state/named-skills.jsonl — append-only, dedup by id so a re-distill or a bad row can never
// corrupt or duplicate existing skills (composability safety). Null-safe.
import { appendFileSync, readFileSync, mkdirSync } from 'fs'
import { atomicWriteFileSync } from '../atomic-write'
import { join, dirname } from 'path'
import type { NamedSkill } from './named-skill'
import { messageOf } from '../guarded'

const skillsPath = (vaultDir: string): string => join(vaultDir, '.duin', '_state', 'named-skills.jsonl')

/** Load all named skills (skips blank / corrupt lines). */
export function loadNamedSkills(vaultDir: string | null): NamedSkill[] {
  if (!vaultDir) return []
  const rows: NamedSkill[] = []
  let txt: string
  try {
    txt = readFileSync(skillsPath(vaultDir), 'utf-8')
  } catch {
    return rows
  }
  for (const line of txt.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      rows.push(JSON.parse(line) as NamedSkill)
    } catch (e) { console.debug('[named-skill-store] skip a corrupt row:', messageOf(e)) }
  }
  return rows
}

/** Append a skill — dedup by id (an existing id is a no-op) so re-distill can't corrupt/duplicate.
 *  Returns whether a new row was written. */
export function appendNamedSkill(vaultDir: string | null, skill: NamedSkill): boolean {
  if (!vaultDir) return false
  if (loadNamedSkills(vaultDir).some((s) => s.id === skill.id)) return false
  appendFileSync(skillsPath(vaultDir), JSON.stringify(skill) + '\n', 'utf-8')
  return true
}

/** Record a reuse event — a named skill was retrieved + injected into a live grounding — to
 *  .duin/_state/skill-reuse.jsonl. This is the READ-BACK-loop-closed signal the self-improve
 *  benchmark reads (Compounding · skill-reuse). Best-effort, null-safe, never throws into a turn. */
export function recordSkillReuse(vaultDir: string | null, query: string, skillIds: string[]): void {
  if (!vaultDir || !skillIds.length) return
  try {
    const p = join(vaultDir, '.duin', '_state', 'skill-reuse.jsonl')
    mkdirSync(dirname(p), { recursive: true })
    appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), query: query.slice(0, 200), skillIds }) + '\n', 'utf-8')
  } catch (e) { console.debug('[named-skill-store] reuse-event append failed:', messageOf(e)) }
}

/** Rewrite the whole store atomically — for an explicit replace (e.g. editing a skill's relations). */
export function writeNamedSkills(vaultDir: string | null, skills: NamedSkill[]): boolean {
  if (!vaultDir) return false
  const body = skills.map((s) => JSON.stringify(s)).join('\n')
  atomicWriteFileSync(skillsPath(vaultDir), skills.length ? body + '\n' : '', 0o644)
  return true
}
