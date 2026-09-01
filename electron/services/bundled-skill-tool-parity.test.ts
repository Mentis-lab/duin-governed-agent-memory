// bundled-skill-tool-parity.test.ts — a bundled skill may only name tools that exist.
//
// Skill bodies are injected verbatim into the system prompt, so a skill telling
// the model to call `verify_workspace` is a promise the registry has to keep.
// Nothing enforced that: a tool rename would leave the instruction in place,
// pointing at nothing, and the failure would surface as "the model ignored the
// skill" rather than as a broken reference. Anthropic's own authoring guidance
// says not to assume a tool is installed; this is that rule with teeth.
//
// Static on purpose: importing the live registry means importing tool-packs,
// which means an electron runtime. This reads both declaration sites instead.
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const REPO = join(__dirname, '..', '..')
const SKILLS_DIR = join(REPO, 'resources', 'skills')
const SERVICES_DIR = join(REPO, 'electron', 'services')

/** A DUIN tool id is snake_case with at least one underscore. That shape is what
 *  lets us tell `search_notes` (a tool) from `AGENTS.md` or `calls-skills`. */
const TOOL_SHAPE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/

function walk(dir: string, match: (f: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(full, match, out)
    else if (st.isFile() && match(full)) out.push(full)
  }
  return out
}

/** Every tool name declared anywhere in the services tree — the native registry
 *  (`id: 'x'`) and the brain executor plane (`name: 'x'`, plus the name arrays
 *  in brain-tool-registry / subagent-config). Deliberately inclusive: a false
 *  positive here only weakens the gate, while a false negative fails the build
 *  on a tool that really exists. */
function declaredToolNames(): Set<string> {
  const names = new Set<string>()
  const sources = walk(SERVICES_DIR, (f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
  for (const file of sources) {
    const src = readFileSync(file, 'utf-8')
    for (const m of src.matchAll(/\b(?:id|name):\s*'([a-z0-9_]+)'/g)) {
      if (TOOL_SHAPE.test(m[1])) names.add(m[1])
    }
    // Bare string-array declarations, e.g. VAULT_TOOL_NAMES / subagent configs.
    if (/tool|subagent|executor/i.test(file)) {
      for (const m of src.matchAll(/'([a-z0-9_]+)'/g)) {
        if (TOOL_SHAPE.test(m[1])) names.add(m[1])
      }
    }
  }
  return names
}

/** Backticked tool-shaped tokens in a skill body. Backticks are the convention
 *  every bundled skill already uses when it names a tool. */
function toolsNamedIn(body: string): string[] {
  const found = new Set<string>()
  for (const m of body.matchAll(/`([a-z0-9_]+)`/g)) {
    if (TOOL_SHAPE.test(m[1])) found.add(m[1])
  }
  return [...found]
}

describe('bundled skills only name tools that exist', () => {
  const declared = declaredToolNames()
  const skillFiles = walk(SKILLS_DIR, (f) => f.endsWith('.md'))

  it('finds the bundled skills and a populated tool catalog', () => {
    expect(skillFiles.length).toBeGreaterThan(0)
    // Guards the guard: if the scrape ever returns nothing, every assertion
    // below would pass vacuously and the gate would be silently off.
    expect(declared.size).toBeGreaterThan(40)
    expect(declared.has('search_notes')).toBe(true)
    expect(declared.has('generate_docx')).toBe(true)
    expect(declared.has('write_file')).toBe(true)
  })

  it('every tool a bundled skill instructs the model to call is registered', () => {
    const unknown: string[] = []
    for (const file of skillFiles) {
      for (const tool of toolsNamedIn(readFileSync(file, 'utf-8'))) {
        if (!declared.has(tool)) {
          unknown.push(`${file.slice(REPO.length + 1).replace(/\\/g, '/')} -> ${tool}`)
        }
      }
    }
    expect(unknown).toEqual([])
  })
})
