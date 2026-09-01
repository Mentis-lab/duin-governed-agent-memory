// profile-native — TS port of server.py:list_profile. Pure reads: the user's
// foundation files (me.md/GOALS.md/MEMORY.md/BRAIN.md) + agent configs + a parsed
// me.md summary (name/bio/work). Structural (file-existence + regex), no side effects.
import { readFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { messageOf } from '../guarded'

interface FileRef {
  name: string
  path: string
}
export interface Profile {
  foundation: FileRef[]
  agents: FileRef[]
  me: { name?: string; bio?: string; work?: string[]; path?: string }
}

/** Minimal frontmatter key:value parse (matches _fm_kv usage for `description`). */
function fmKv(text: string): Record<string, string> {
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(t)
  const kv: Record<string, string> = {}
  if (!m) return kv
  for (const ln of m[1].split('\n')) {
    const i = ln.indexOf(':')
    if (i > 0 && !ln.trimStart().startsWith('#')) kv[ln.slice(0, i).trim()] = ln.slice(i + 1).trim()
  }
  return kv
}

export function listProfile(vaultDir: string | null): Profile {
  const empty: Profile = { foundation: [], agents: [], me: {} }
  if (!vaultDir) return empty
  const base = vaultDir
  const item = (rel: string, label?: string): FileRef | null =>
    existsSync(join(base, rel)) ? { name: label ?? rel.split('/').pop()!, path: rel } : null

  const foundation = [
    item('SOUL.md', 'SOUL — who DUIN is'),
    item('me.md', 'me — who you are'),
    item('GOALS.md', 'GOALS'),
    item('MEMORY.md', 'MEMORY — incident log'),
    item('BRAIN.md', 'BRAIN.md — operating instructions')
  ].filter((x): x is FileRef => x !== null)

  const agents: FileRef[] = []
  for (const [rel, label] of [
    ['AGENTS.md', 'AGENTS.md — codex'],
    ['.codex/AGENTS.md', '.codex / AGENTS.md']
  ]) {
    const x = item(rel, label)
    if (x) agents.push(x)
  }
  for (const d of ['.duin/agents', '08 Agents']) {
    try {
      for (const fn of readdirSync(join(base, d)).sort()) {
        if (fn.endsWith('.md')) agents.push({ name: fn.slice(0, -3), path: `${d}/${fn}` })
      }
    } catch (e) { console.debug('[profile-native] no dir:', messageOf(e)) }
  }

  let me: Profile['me'] = {}
  try {
    const txt = readFileSync(join(base, 'me.md'), 'utf-8')
    const body = txt.replace(/^---\n[\s\S]*?\n---\n/, '')
    const h1 = body.match(/^#\s+(.+)$/m)
    const name = h1 ? h1[1].trim().replace(/^Me\s*[—-]\s*/, '') : 'You'
    const bioM = body.match(/##\s*Quick Bio\s*\n+([\s\S]+?)(?=\n#{1,3}\s|\n---|$)/)
    const bio = (bioM ? bioM[1].trim() : fmKv(txt).description ?? '').replace(/\n/g, ' ')
    const work = body
      .split('\n')
      .filter((ln) => /^-\s+\*\*/.test(ln))
      .map((ln) => ln.replace(/^[-\s]+|[-\s]+$/g, '').replace(/\*\*/g, '').slice(0, 90))
      .slice(0, 6)
    me = { name, bio: bio.slice(0, 700), work, path: 'me.md' }
  } catch (e) { console.debug('[profile-native] no me.md:', messageOf(e)) }
  return { foundation, agents, me }
}
