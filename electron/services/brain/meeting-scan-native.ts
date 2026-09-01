// Native port of resources/brain/server.py :: scan_chat_meetings (/state/meeting-scan).
// Mines recent chat sweeps (WeChat/Feishu raw + daily notes) for arranged meetings/
// events via the model, merges into meetings.jsonl preserving prior confirm/dismiss.
//
// LLM route (generate injected), so it's structurally — not byte — verifiable: the
// found/merge/store pipeline is golden-tested with a fixed generate; the model calls
// are non-deterministic. (The Python sidecar runs the model in "stub" mode, so this
// is actually MORE functional natively — the app has the real brain.)
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'fs'
import { join, relative } from 'path'
import { createHash } from 'crypto'
import { jsonFromModel } from './stream-write-native'
import { messageOf } from '../guarded'

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
const PILLARS: Record<string, string[]> = { raw: ['DUIN/00 Inbox', '00 Raw'], planning: ['DUIN/Planning', '04 Notes'] }
function pillarDir(vault: string, name: string): string {
  for (const c of PILLARS[name]) if (isDir(join(vault, c))) return join(vault, c)
  return join(vault, PILLARS[name][0])
}
function readNorm(fp: string): string {
  try {
    return readFileSync(fp, 'utf-8').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  } catch {
    return ''
  }
}
function sliceCp(s: string, n: number): string {
  return [...s].slice(0, n).join('')
}
/** Non-recursive *.md in `dir`, sorted, last `n` (mirrors sorted(glob(dir/*.md))[-n:]). */
function lastMd(dir: string, n: number): string[] {
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
  } catch {
    return []
  }
  return files.slice(-n).map((f) => join(dir, f))
}
function loadJsonl(fp: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  let text: string
  try {
    text = readFileSync(fp, 'utf-8')
  } catch {
    return out
  }
  for (const raw of text.split(/\r\n|\n|\r/)) {
    const ln = raw.trim()
    if (!ln) continue
    try {
      out.push(JSON.parse(ln))
    } catch (e) { console.debug('[meeting-scan-native] skip:', messageOf(e)) }
  }
  return out
}

export interface MeetingScanResult {
  ok: boolean
  found: number
  total: number
}

/** Port of scan_chat_meetings. `today` is a YYYY-MM-DD string; `generate` runs one
 *  model pass per chat file (up to 8). */
export async function meetingScan(
  vaultDir: string,
  deps: { generate: (prompt: string) => Promise<string> },
  today: string
): Promise<MeetingScanResult> {
  const base = vaultDir
  const raw = pillarDir(vaultDir, 'raw')
  const plan = pillarDir(vaultDir, 'planning')
  const dirs = [join(raw, 'Wechat'), join(raw, 'Wechat', 'Wechat'), join(raw, 'Feishu'), join(plan, 'daily')]
  const texts: [string, string][] = []
  for (const d of dirs) {
    for (const fp of lastMd(d, 6)) {
      texts.push([relative(base, fp).replace(/\\/g, '/'), sliceCp(readNorm(fp), 8000)])
    }
  }
  const found: Record<string, unknown>[] = []
  for (const [rel, txt] of texts.slice(-8)) {
    if (txt.trim().length < 40) continue
    const prompt =
      `From this chat log, extract MEETINGS or EVENTS that are scheduled/arranged (a date or time ` +
      `+ a purpose). Today is ${today}. Return ONLY a JSON array; each item: ` +
      `{"when":"YYYY-MM-DD or YYYY-MM-DD HH:MM or a short relative phrase","who":"people/org",` +
      `"what":"short topic","type":"meeting|event"}. Skip past dates, vague mentions, and recurring ` +
      `routines. Empty array [] if none.\n\n${sliceCp(txt, 7000)}`
    let arr: unknown
    try {
      arr = jsonFromModel(await deps.generate(prompt), true)
    } catch {
      arr = []
    }
    for (const it of Array.isArray(arr) ? arr : []) {
      if (!it || typeof it !== 'object' || !(it as Record<string, unknown>).what) continue
      const o = it as Record<string, unknown>
      const mid = createHash('md5').update(String(o.when ?? '') + String(o.what ?? ''), 'utf-8').digest('hex').slice(0, 10)
      found.push({
        id: mid,
        when: sliceCp(String(o.when ?? ''), 40),
        who: sliceCp(String(o.who ?? ''), 80),
        what: sliceCp(String(o.what ?? ''), 140),
        type: sliceCp(String(o.type ?? 'meeting'), 12),
        source: rel,
        status: 'pending'
      })
    }
  }
  const storePath = join(vaultDir, '.duin', '_state', 'meetings.jsonl')
  const existing = new Map<string, Record<string, unknown>>()
  for (const m of loadJsonl(storePath)) existing.set(String(m.id), m)
  for (const m of found) {
    const prior = existing.get(String(m.id))
    if (prior) m.status = prior.status ?? 'pending' // preserve confirm/dismiss
  }
  const merged = new Map(existing)
  for (const m of found) merged.set(String(m.id), m)
  const rows = [...merged.values()]
  mkdirSync(join(vaultDir, '.duin', '_state'), { recursive: true })
  writeFileSync(storePath, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf-8')
  return { ok: true, found: found.length, total: merged.size }
}
