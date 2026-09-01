// The projection engine's CONTEXT LAYER — the five vault-state readers that build the prompt
// context for project_futures: the operator profile, the world-state snapshot, the dynamic track
// lanes, the strategy docs, and the personal goals. Ports of _operator_profile (server.py:1216),
// _projection_context (1228), _projection_lanes (1270), _strategy_context (1287), _goals_context
// (1329). All PURE-ish (fs reads + regex; deterministic given the vault + injected clock).

import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative, basename, sep } from 'path'
import { worldState } from './world-state-native'
import { loadTrackRegistry } from './tracks-native'
import { normalizeTrackKey } from './ontology'
import { arenaDirs } from './throughput'
import { messageOf } from '../guarded'

const brainDir = (vaultDir: string): string => join(vaultDir, '.duin')

const stripFrontmatter = (t: string): string => t.replace(/^---[\s\S]*?---/, '')
const readIf = (fp: string): string | null => {
  try {
    return readFileSync(fp, 'utf-8')
  } catch {
    return null
  }
}
const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** Operator layer — .duin/operator-profile.md (frontmatter-stripped, capped). Port of _operator_profile. */
export function operatorProfile(vaultDir: string, maxchars = 1400): string {
  const t = readIf(join(brainDir(vaultDir), 'operator-profile.md'))
  if (t === null) return ''
  return stripFrontmatter(t).trim().slice(0, maxchars)
}

/** Compact per-track world snapshot for the projection prompt. Port of _projection_context. */
export function projectionContext(vaultDir: string, today: Date = new Date()): string {
  const tracks = worldState(vaultDir, today).tracks as Array<Record<string, unknown>>
  const out: string[] = []
  for (const t of tracks) {
    const open = Number(t.open ?? 0)
    const risks = Number(t.risks ?? 0)
    if (open === 0 && risks === 0) continue
    const seg = [`## ${t.label}  (open:${open} · risks:${risks} · next deadline:${t.next_due || '—'})`]
    if (t.status) seg.push(`- now: ${t.status}`)
    if (t.trajectory) seg.push(`- heading: ${t.trajectory}`)
    for (const r of ((t.risk_list as string[]) ?? []).slice(0, 4)) seg.push(`- risk: ${r}`)
    for (const u of ((t.updates as { summary?: string }[]) ?? []).slice(-3)) seg.push(`- recent update: ${u.summary}`)
    for (const b of ((t.beliefs as { summary?: string }[]) ?? []).slice(-2)) seg.push(`- belief/intent: ${b.summary}`)
    out.push(seg.join('\n'))
  }
  return out.join('\n\n')
}

/** Track lanes the projection may tag — from the live registry + core lanes. Port of _projection_lanes. */
export function projectionLanes(vaultDir: string): string[] {
  const lanes: string[] = []
  for (const t of loadTrackRegistry(vaultDir)) {
    const L = normalizeTrackKey((t.lane ?? '').trim()) // registry rows may still say `3rd` / `AIX`
    if (L && !lanes.includes(L)) lanes.push(L)
  }
  for (const L of ['ProjectA', 'PartnerCo', 'personal']) if (!lanes.includes(L)) lanes.push(L)
  return lanes
}

const GOALS_FILES = ['GOALS.md', '04 Notes/12-week/2026-Q2.md']

/** Personal goals — the significance lens (me.md + GOALS + the 12-week tracker). Port of _goals_context. */
export function goalsContext(vaultDir: string, maxchars = 1900): string {
  const parts: string[] = []
  const me = readIf(join(vaultDir, 'me.md'))
  if (me !== null) parts.push('### Identity & mission (me.md)\n' + stripFrontmatter(me).trim().slice(0, 900))
  for (const rel of GOALS_FILES) {
    const t = readIf(join(vaultDir, ...rel.split('/')))
    if (t !== null) parts.push(`### ${rel}\n` + t.slice(0, 1100))
  }
  return parts.join('\n\n').slice(0, maxchars)
}

// ── strategy context (glob-scored strategy prose) ──
const STRATEGY_TERMS = /发行|平台|Steam|Xbox|PlayStation|PS5|TapTap|B站|bilibili|iOS|Google ?Play|安卓|海外|出海|launch|marketing|买量|市场|用户|营收|上线|多平台|渠道|资源位|首发|定档/gi
const NAME_KW = /方案|计划|规划|策略|strateg|发行|launch|plan|roadmap|商务|BD/gi
const CHECKBOX = /^\s*[-*]\s+\[[ xX]\]/

function walkMd(root: string, out: string[]): void {
  let entries: import('fs').Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = join(root, e.name)
    if (e.isDirectory()) walkMd(full, out)
    else if (e.isFile() && e.name.endsWith('.md')) out.push(full)
  }
}

/** The glob roots feeding strategy context: 08 Goals + every 03 Projects/<d> + each arena. Port of
 *  _strategy_globs (as directory roots we walk for *.md). */
function strategyRoots(vaultDir: string): string[] {
  const roots = [join(vaultDir, '08 Goals')]
  const projBase = join(vaultDir, '03 Projects')
  try {
    for (const d of readdirSync(projBase).sort()) {
      if (!d.startsWith('.') && !d.startsWith('_') && isDir(join(projBase, d))) roots.push(join(projBase, d))
    }
  } catch (e) { console.debug('[projection-context-native] no 03 Projects:', messageOf(e)) }
  for (const a of arenaDirs(vaultDir)) roots.push(join(vaultDir, a))
  return roots
}

const SKIP_PATH = ['.obsidian', 'node_modules', '_agui', `${sep}00 Raw${sep}`]

/** The operator's launch/marketing strategy prose — scored by platform-strategy density, relevant lines kept.
 *  Port of _strategy_context. */
export function strategyContext(vaultDir: string, maxdocs = 3, maxchars = 1700): string {
  const seen = new Set<string>()
  const cands: { score: number; fp: string; txt: string }[] = []
  for (const root of strategyRoots(vaultDir)) {
    const files: string[] = []
    walkMd(root, files)
    for (const fp of files) {
      if (seen.has(fp)) continue
      seen.add(fp)
      if (SKIP_PATH.some((s) => fp.includes(s))) continue
      const name = basename(fp)
      if (name === 'Tasks.md' || name.includes('_Owed-Decisions')) continue
      const txt = readIf(fp)
      if (txt === null) continue
      const lines = txt.split('\n')
      const checkboxes = lines.filter((ln) => CHECKBOX.test(ln)).length
      if (lines.length && checkboxes / Math.max(lines.length, 1) > 0.4) continue // mostly a checklist
      const score = (txt.match(STRATEGY_TERMS)?.length ?? 0) + 8 * (name.match(NAME_KW)?.length ?? 0)
      if (score > 4) cands.push({ score, fp, txt })
    }
  }
  cands.sort((a, b) => b.score - a.score)
  const out: string[] = []
  for (const { fp, txt } of cands.slice(0, maxdocs)) {
    const rel = relative(vaultDir, fp).replace(/\\/g, '/')
    const keep: string[] = []
    for (const ln of txt.split('\n')) {
      if (!ln.trim() || CHECKBOX.test(ln)) continue
      if (ln.trimStart().startsWith('#') || STRATEGY_TERMS.test(ln)) {
        STRATEGY_TERMS.lastIndex = 0 // reset the global regex between .test() calls
        keep.push(ln.replace(/\{\{[^}]*\}\}/g, '').replace(/\s+$/, ''))
      }
      STRATEGY_TERMS.lastIndex = 0
    }
    out.push(`### ${rel}\n` + keep.join('\n').slice(0, maxchars))
  }
  return out.join('\n\n')
}
