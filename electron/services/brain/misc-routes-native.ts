// Native ports of a cluster of small still-proxied routes:
//   - save_to_raw   (/state/upload-raw)   — drop an uploaded file into the raw pillar
//   - auto_track_risks (/state/auto-track) — veto-model risk graduation (opt-in)
//   - infer_drivers (/state/drivers)       — cached read; explicit POST refresh can invoke the LLM
// Kept small + dependency-injected so the deterministic paths are verifiable.
import { readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from 'fs'
import { join, basename } from 'path'
import { randomBytes } from 'crypto'
import { revealedRisks } from './world-state-native'
import { actRevealedRisk } from './revealed-risk-write-native'
import { loadFutures } from './causal-substrate'
import { messageOf } from '../guarded'

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
const RAW_CANDIDATES = ['DUIN/00 Inbox', '00 Raw']
function rawPillar(vault: string): string {
  for (const c of RAW_CANDIDATES) if (isDir(join(vault, c))) return join(vault, c)
  return join(vault, RAW_CANDIDATES[0])
}
/** re.sub(r"[^\w.\- ]+", "_", basename) — Python \w is UNICODE (keeps CJK), so use
 *  \p{L}\p{N}; then Python .strip() → trim; default when empty. */
function safeName(filename: string, dflt: string): string {
  const b = basename(filename || dflt)
  return b.replace(/[^\p{L}\p{N}_.\- ]+/gu, '_').trim() || dflt
}

/** Port of save_to_raw (/state/upload-raw). */
export function saveToRaw(vaultDir: string, filename: string, data: Buffer): { stored: string; bytes: number } {
  const raw = rawPillar(vaultDir)
  mkdirSync(raw, { recursive: true })
  const safe = safeName(filename, 'upload')
  writeFileSync(join(raw, safe), data)
  return { stored: safe, bytes: data.length }
}

// ── save_upload (/state/upload) — file store + optional contacts→entities ──────
const ORG_HINTS = ['inc', 'ltd', 'llc', 'corp', 'studio', 'studios', 'games', '网络', '公司', '科技', '传媒', '互娱', '工作室', '集团', '技术']
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/
function slugAlnum(s: string): string {
  const r = String(s).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 48)
  return r || 'output'
}
function stripChars(s: string, chars: string): string {
  const set = new Set([...chars])
  let a = 0
  let b = s.length
  while (a < b && set.has(s[a])) a++
  while (b > a && set.has(s[b - 1])) b--
  return s.slice(a, b)
}
/** Port of parse_contacts. */
export function parseContacts(text: string, source = 'upload'): Record<string, string>[] {
  const out: Record<string, string>[] = []
  for (const raw of text.split(/\r\n|\r|\n/)) {
    let line = raw.trim().replace(/^[-*•]+/, '').trim()
    if (!line || line.startsWith('#')) continue
    let email = ''
    const m = EMAIL.exec(line)
    if (m) {
      email = m[0]
      line = line.replace(email, '')
    }
    const parts = line
      .split(/\s[—|/;]\s|\s-\s|,|\||\t/)
      .map((p) => stripChars(p, ' <>()\t'))
      .filter(Boolean)
    if (!parts.length) {
      if (!email) continue
      parts.push(email.split('@')[0])
    }
    const name = parts[0]
    const rest = parts.slice(1)
    const org = rest.find((p) => ORG_HINTS.some((h) => p.toLowerCase().includes(h))) || ''
    const detail = rest.filter((p) => p !== org).join(', ')
    out.push({ name, role: detail, org, email, kind: ORG_HINTS.some((h) => name.toLowerCase().includes(h)) ? 'org' : 'person', source })
  }
  return out
}
function entitiesFile(vault: string): string {
  return join(vault, '.duin', '_agui_entities.json')
}
function loadEntitiesRaw(vault: string): Record<string, unknown>[] {
  try {
    const r = JSON.parse(readFileSync(entitiesFile(vault), 'utf-8'))
    return Array.isArray(r) ? r : []
  } catch {
    return []
  }
}

/** Port of save_upload (/state/upload). Base file-store + (for parse=contacts on
 *  textual files) contact→entity extraction. Entity ids carry a random suffix
 *  (uuid parity), so the contacts path is structurally-, not byte-, verifiable. */
export function saveUpload(vaultDir: string, filename: string, data: Buffer, parse = ''): Record<string, unknown> {
  const uploadsDir = join(vaultDir, '.duin', '_agui_uploads')
  mkdirSync(uploadsDir, { recursive: true })
  const safe = safeName(filename, 'upload.txt')
  writeFileSync(join(uploadsDir, safe), data)
  const added: Record<string, unknown>[] = []
  const ext = safe.toLowerCase().includes('.') ? safe.toLowerCase().split('.').pop()! : ''
  const looksTextual = ['txt', 'csv', 'md', 'tsv', ''].includes(ext)
  if (parse === 'contacts' && looksTextual) {
    const text = data.toString('utf-8')
    const rows = loadEntitiesRaw(vaultDir)
    for (const ent of parseContacts(text, safe)) {
      const withId = { ...ent, id: slugAlnum(ent.name) + '-' + randomBytes(3).toString('hex') }
      rows.push(withId)
      added.push(withId)
    }
    if (added.length) writeFileSync(entitiesFile(vaultDir), JSON.stringify(rows, null, 2), 'utf-8')
  }
  return { stored: safe, bytes: data.length, added }
}

/** Port of auto_track_risks (/state/auto-track). Opt-in via `on`; graduates the
 *  highest-confidence (>=0.85) revealed risks (cap 3) into the register. When off,
 *  trivially returns disabled (the safe default when no native autoTrack setting). */
export function autoTrackRisks(
  vaultDir: string,
  on: boolean,
  now: Date = new Date()
): { ok: boolean; enabled: boolean; graduated: string[] } {
  if (!on) return { ok: true, enabled: false, graduated: [] }
  const high = revealedRisks(vaultDir, now).risks.filter((r) => (typeof r.confidence === 'number' ? r.confidence : 0) >= 0.85)
  const graduated: string[] = []
  for (const r of high.slice(0, 3)) {
    const res = actRevealedRisk(vaultDir, String(r.id ?? ''), 'confirm', String(r.summary ?? r.title ?? ''), now)
    if (res.ok) graduated.push(String(res.id ?? ''))
  }
  return { ok: true, enabled: true, graduated }
}

/** Port of learn_loop_status (/state/learn-loop GET). Deterministic file counts:
 *  queued judgment candidates, new corrections, pending distill proposals, distill-
 *  due signal. The native app is Claude-Code-free (no learn-CLI job), so the paired
 *  `run` state is always idle. */
export function learnLoopStatus(vaultDir: string): Record<string, unknown> {
  const base = join(vaultDir, '.duin', '_state')
  const countLines = (fp: string, needles: string[]): number => {
    let text: string
    try {
      text = readFileSync(fp, 'utf-8')
    } catch {
      return 0
    }
    let n = 0
    for (const ln of text.split(/\r\n|\r|\n/)) if (needles.some((x) => ln.includes(x))) n++
    return n
  }
  let queued = 0
  try {
    queued = readdirSync(join(base, 'judgment-queue')).filter((f) => f.endsWith('.json')).length
  } catch (e) { console.debug('[misc-routes-native] no dir  0:', messageOf(e)) }
  const correctionsNew = countLines(join(base, 'corrections.jsonl'), ['"status": "new"', '"status":"new"'])
  const proposals = countLines(join(base, 'distill-proposals.jsonl'), ['pending-review'])
  let distillDue = false
  try {
    distillDue = readdirSync(join(vaultDir, '.duin', '_pending')).some((f) => f.startsWith('distill-request'))
  } catch (e) { console.debug('[misc-routes-native] no dir  false:', messageOf(e)) }
  return {
    queued,
    corrections_new: correctionsNew,
    proposals_pending: proposals,
    distill_due: distillDue,
    debt: queued + correctionsNew + proposals + (distillDue ? 1 : 0)
  }
}

/** Port of infer_drivers. No-force is a strictly pure cache read; force runs one
 * LLM pass (via injected generate) and rewrites the cache. */
export async function inferDrivers(
  vaultDir: string,
  force: boolean,
  deps: { generate: (prompt: string) => Promise<string> },
  now: Date = new Date()
): Promise<Record<string, unknown>> {
  const cachePath = join(vaultDir, '.duin', '_state', 'causal-drivers.json')
  if (!force) {
    try {
      return JSON.parse(readFileSync(cachePath, 'utf-8'))
    } catch (e) {
      console.debug('[misc-routes-native] driver cache unavailable:', messageOf(e))
      return { drivers: [], generated: '', note: 'cache miss' }
    }
  }
  const streams = (loadFutures(vaultDir) as Record<string, unknown>[]).filter((s) => (s.track || '') !== 'personal')
  const items = streams
    .filter((s) => s.id)
    .map((s) => ({
      id: s.id,
      title: s.title ?? '',
      track: s.track ?? '',
      risk_if_blocked: String(s.blocked ?? '').slice(0, 140)
    }))
  if (!items.length) return { drivers: [], generated: '', note: 'no streams' }
  const risks = revealedRisks(vaultDir, now)
    .risks.map((r) => String(r.summary ?? r.title ?? '').slice(0, 110))
    .slice(0, 18)
  const prompt =
    'Infer LATENT DRIVERS — the few underlying causes (often in no single doc) that set MULTIPLE ' +
    "of these streams/risks in motion. A driver is a real cause (e.g. 'male-lead weak draw', " +
    "'渠道与商业化战略'), NOT a category. Each must explain >=2 streams. Output ONLY a JSON array: " +
    '[{"driver":"<=24 chars in the item language","track":"<track>","explains":["<exact stream id>"...]}].' +
    '\n\nSTREAMS:\n' +
    JSON.stringify(items) +
    '\n\nRISKS:\n' +
    JSON.stringify(risks)
  let arr: unknown[] = []
  try {
    const raw = await deps.generate(prompt)
    const m = /\[[\s\S]*\]/.exec(raw || '')
    if (m) arr = JSON.parse(m[0])
  } catch {
    arr = []
  }
  const ids = new Set(streams.map((s) => s.id))
  const drivers: Record<string, unknown>[] = []
  for (const d of Array.isArray(arr) ? arr : []) {
    const dd = d as Record<string, unknown>
    const ex = ((dd.explains as unknown[]) || []).filter((x) => ids.has(x))
    if (typeof dd.driver === 'string' && ex.length >= 2)
      drivers.push({ driver: dd.driver.slice(0, 40), track: String(dd.track ?? ''), explains: ex })
  }
  const isoToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const out = { drivers, generated: isoToday }
  try {
    mkdirSync(join(vaultDir, '.duin', '_state'), { recursive: true })
    writeFileSync(cachePath, JSON.stringify(out, null, 2), 'utf-8')
  } catch (e) { console.debug('[misc-routes-native] best-effort:', messageOf(e)) }
  return out
}
