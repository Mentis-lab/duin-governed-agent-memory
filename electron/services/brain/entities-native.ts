// entities-native — TS port of server.py's vault-entity chain (list_vault_entities /
// vault_entities / vault_entity / _org_signal / _person_signal / _extract_org /
// load_entities). Walks the vault once, classifies each note as person/org by frontmatter
// + path signals, links people to orgs (explicit + derived), merges the manual
// _agui_entities.json. Backs /state/entities; listVaultEntities is reused by conversations.
// Pure reads (fs walk + regex), no side effects.
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative, sep } from 'path'

const ENTITY_SKIP_DIRS = new Set(['.git', '.obsidian', '.trash', 'node_modules', '07 Templates'])

export interface Entity {
  name: string
  kind: string
  role: string
  org: string
  email: string
  source: string
  id?: string
  members?: string[]
}

function fmOf(head: string): string {
  const m = /^---\n([\s\S]*?)\n---/.exec(head)
  return m ? m[1] : ''
}
/** Drop a trailing parenthetical + wiki brackets: '趣方块 (QuFangKuai)' → '趣方块'. */
function cleanName(s: string): string {
  return s
    .replace(/\s*[（(][^)）]*[)）]\s*$/, '')
    .trim()
    .replace(/^\[+|\]+$/g, '')
    .trim()
}
function slug(s: string): string {
  const out = s.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()
  return out.slice(0, 48) || 'output'
}
const isTemplate = (path: string, fn: string): boolean => path.toLowerCase().includes('template') || fn.toLowerCase().startsWith('template')

function personSignal(head: string, path: string): boolean {
  const fm = fmOf(head)
  return fm.includes('人物档案') || /^type:\s*person\b/m.test(fm) || path.includes(`${sep}人物${sep}`)
}
function orgSignal(head: string): boolean {
  const fm = fmOf(head)
  return fm.includes('ORG档案') || fm.includes('公司档案') || fm.includes('组织档案') || /^type:\s*org\b/m.test(fm)
}
function extractOrg(head: string, filenameOrg: string): string {
  if (filenameOrg) return cleanName(filenameOrg)
  const fm = fmOf(head)
  const fo = /^org:\s*(.+)$/m.exec(fm)
  if (fo && fo[1].trim()) return cleanName(fo[1])
  const cm = /公司[^[\n]*?\[\[([^\]|]+)/.exec(head) // | 公司 | [[趣方块 (QuFangKuai)]] |
  if (cm) return cleanName(cm[1])
  return ''
}
function vaultEntity(head: string, filename: string, kind: string): Entity {
  const stem = filename.endsWith('.md') ? filename.slice(0, -3) : filename
  const mm = /^(.*?)\s*[（(]([^)）]*)[)）]\s*$/.exec(stem)
  const name = (mm ? mm[1].trim() : stem).trim()
  const paren = mm ? mm[2].trim() : ''
  if (kind === 'org') return { name: cleanName(stem), kind: 'org', role: '', org: '', email: '', source: 'vault', members: [] }
  return { name, kind: 'person', role: '', org: extractOrg(head, paren), email: '', source: 'vault' }
}

/** Walk the vault (os.walk top-down order); yield qualifying .md files as [absPath, rel, fn]. */
function walkMd(base: string, rel: string, out: [string, string, string][]): void {
  let entries: import('fs').Dirent[]
  try {
    entries = readdirSync(join(base, rel), { withFileTypes: true })
  } catch {
    return
  }
  const subdirs: string[] = []
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!ENTITY_SKIP_DIRS.has(e.name) && !e.name.startsWith('_agui')) subdirs.push(e.name)
    } else if (e.name.endsWith('.md') && !e.name.startsWith('_')) {
      const r = rel ? `${rel}/${e.name}` : e.name
      out.push([join(base, r), r, e.name])
    }
  }
  for (const sd of subdirs) walkMd(base, rel ? `${rel}/${sd}` : sd, out)
}

/** Walk the vault once → (people, orgs), dedup by name.lower() first-wins in walk order. */
export function listVaultEntities(vaultDir: string): { people: Entity[]; orgs: Entity[] } {
  const people: Entity[] = []
  const orgs: Entity[] = []
  const seenP = new Set<string>()
  const seenO = new Set<string>()
  const files: [string, string, string][] = []
  walkMd(vaultDir, '', files)
  for (const [abs, rel, fn] of files) {
    if (isTemplate(abs, fn)) continue
    let head: string
    try {
      head = readFileSync(abs, 'utf-8').replace(/\r\n?/g, '\n').slice(0, 1500)
    } catch {
      continue
    }
    const eid = `vault:/${rel}`
    if (orgSignal(head)) {
      const ent = vaultEntity(head, fn, 'org')
      if (!seenO.has(ent.name.toLowerCase())) {
        seenO.add(ent.name.toLowerCase())
        ent.id = eid
        orgs.push(ent)
      }
    } else if (personSignal(head, abs)) {
      const ent = vaultEntity(head, fn, 'person')
      if (!seenP.has(ent.name.toLowerCase())) {
        seenP.add(ent.name.toLowerCase())
        ent.id = eid
        people.push(ent)
      }
    }
  }
  return { people, orgs }
}

/** People + orgs linked: orgs carry members (explicit + derived from people's org field). */
export function vaultEntities(vaultDir: string): Entity[] {
  const { people, orgs } = listVaultEntities(vaultDir)
  const byName = new Map<string, Entity>()
  for (const o of orgs) byName.set(o.name.toLowerCase(), o)
  for (const p of people) {
    const o = (p.org || '').trim()
    if (!o) continue
    const k = o.toLowerCase()
    if (!byName.has(k)) {
      byName.set(k, { id: `org:${slug(o)}`, name: o, kind: 'org', role: '', org: '', email: '', source: 'derived', members: [] })
    }
    const row = byName.get(k)!
    if (!row.members) row.members = []
    row.members.push(p.name)
  }
  const orgRows = [...byName.values()].sort((a, b) => (b.members?.length ?? 0) - (a.members?.length ?? 0))
  for (const o of orgRows) {
    const n = o.members?.length ?? 0
    o.role = n ? `${n} ${n === 1 ? 'person' : 'people'}` : o.role || ''
  }
  const peopleSorted = [...people].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return [...peopleSorted, ...orgRows]
}

/** Manual/uploaded entities from _agui_entities.json (else []). Port of load_entities.
 *  paths.P.entities_file = <vaultRoot>/_agui_entities.json (NOT under .duin/_state — _DIR is
 *  the vault root, and entities_file is joined directly to it). */
export function loadEntities(vaultDir: string): Entity[] {
  try {
    const data = JSON.parse(readFileSync(join(vaultDir, '_agui_entities.json'), 'utf-8'))
    return Array.isArray(data) ? (data as Entity[]) : []
  } catch {
    return []
  }
}

/** /state/entities = vault_entities() + load_entities(). */
export function listEntities(vaultDir: string | null): { entities: Entity[] } {
  if (!vaultDir) return { entities: [] }
  return { entities: [...vaultEntities(vaultDir), ...loadEntities(vaultDir)] }
}
