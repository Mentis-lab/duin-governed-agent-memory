// method-run — the CONSUME half of the Methods layer. Given a `type: method`
// vault note, resolve the skills it wires (calls-skills frontmatter + skill
// [[wikilinks]]) and build a grounded prompt that instructs the agent to RUN the
// method — following its `## Steps (DAG)` as a soft shape — to produce the
// deliverable. The renderer activates the resolved skills and sends the prompt
// through DUIN's normal chat/agent loop (which injects active skills into context).
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, resolve, relative, isAbsolute } from 'path'
import { fmList } from './workflows-native'

export interface MethodRun {
  name: string
  deliverable: string
  skillWires: string[]
  prompt: string
}

function fmBlock(head: string): string {
  const m = /^---\n([\s\S]*?)\n---/.exec(head)
  return m ? m[1] : ''
}
function fmVal(head: string, key: string): string {
  for (const line of fmBlock(head).split('\n')) {
    const i = line.indexOf(':')
    if (i > 0 && line.slice(0, i).trim() === key) {
      return line.slice(i + 1).trim().replace(/^["']+|["']+$/g, '').replace(/^'+|'+$/g, '')
    }
  }
  return ''
}

/** Directory names under `<vault>/.duin/skills`. ONE of two sources for
 *  classifying which [[wikilinks]] in a method body are skills — the other, and
 *  the one that matters on a normal install, is the app's own installed skill
 *  set, which the caller passes in. Nothing in DUIN writes `.duin/skills`; it
 *  exists only where an operator built one by hand. */
function skillDirNames(notesDir: string): Set<string> {
  const out = new Set<string>()
  try {
    const sd = join(notesDir, '.duin', 'skills')
    for (const n of readdirSync(sd)) {
      if (n.startsWith('.') || n.startsWith('_')) continue
      try {
        if (statSync(join(sd, n)).isDirectory()) out.add(n)
      } catch {
        /* skip unreadable entry */
      }
    }
  } catch {
    /* no skills dir */
  }
  return out
}

/** The `## Steps` section body, verbatim (until the next `## ` heading or EOF). */
function stepsSection(raw: string): string {
  const lines = raw.split('\n')
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+steps\b/i.test(lines[i])) {
      start = i
      break
    }
  }
  if (start < 0) return ''
  const out: string[] = [lines[start]]
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break
    out.push(lines[i])
  }
  return out.join('\n').trim()
}

function buildPrompt(name: string, deliverable: string, skills: string[], steps: string): string {
  const parts = [`Run the "${name}" method to produce its deliverable.`]
  if (deliverable) parts.push(`\nDeliverable: ${deliverable}`)
  if (skills.length) {
    parts.push(
      `\nCompose these skills as the moves: ${skills.join(', ')}. ` +
        `(They have been activated for this turn; where a step names one, use it.)`
    )
  }
  if (steps) {
    parts.push(
      `\nFollow the method's steps as a SOFT DAG — a dependency shape, not a strict order; ` +
        `you may reorder or skip a step where it makes sense:\n\n${steps}`
    )
  }
  parts.push(`\nProduce the deliverable, following the method's shape and composing the named skills.`)
  return parts.join('\n')
}

/** Prepare a run for the `type: method` note at `methodRelPath` (relative to
 *  `notesDir`). Returns null if the path escapes the vault, is unreadable, or is
 *  not a method note. Pure read — no side effects; the caller does the activation. */
export function prepareMethodRun(
  notesDir: string | null,
  methodRelPath: string,
  installedSkills?: Iterable<string>
): MethodRun | null {
  if (!notesDir || !methodRelPath) return null
  const root = resolve(notesDir)
  const abs = resolve(join(notesDir, methodRelPath))
  const rel = relative(root, abs)
  if (rel.startsWith('..') || isAbsolute(rel)) return null // path escape guard
  let raw: string
  try {
    raw = readFileSync(abs, 'utf-8').replace(/\r\n?/g, '\n')
  } catch {
    return null
  }
  const head = raw.slice(0, 2000)
  if (!/^type:\s*method\b/m.test(fmBlock(head))) return null
  const name = fmVal(head, 'name') || fmVal(head, 'title') || methodRelPath.split('/').pop()!.replace(/\.md$/, '')
  const deliverable = fmVal(head, 'deliverable')
  const installed = skillDirNames(notesDir)
  for (const s of installedSkills ?? []) if (s) installed.add(s)
  const wires = new Set<string>()
  for (const s of fmList(head, 'calls-skills')) if (s) wires.add(s)
  for (const mm of raw.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const leaf = mm[1].split('|')[0].trim().split('/').pop()!.replace(/\.md$/, '')
    if (leaf && (mm[1].includes('/skills/') || installed.has(leaf))) wires.add(leaf)
  }
  const skillWires = [...wires]
  const prompt = buildPrompt(name, deliverable, skillWires, stepsSection(raw))
  return { name, deliverable, skillWires, prompt }
}
