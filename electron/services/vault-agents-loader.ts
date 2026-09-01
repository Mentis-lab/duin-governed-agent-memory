// vault-agents-loader.ts — make the vault's `.duin/agents/*.md` real, dispatchable
// subagents instead of inert markdown the runtime never calls.
//
// The harness ships a set of Claude-Code-style agent specs in the vault
// (vault-researcher, biz-doc-critic, bd-prospect-grader, vault-manager, …). They
// were indexed as graph CONTENT but never registered as forkable types, for two
// reasons: (1) the subagent-type loader only scans `userData/subagent-types/`,
// not the vault; (2) their CC frontmatter writes `tools:` as a comma string of
// CC tool names (`Read, Glob, Grep, mcp__…`), which the user-file parser rejects.
//
// This loader bridges both: it reads the vault agents directly, maps their CC
// tool names to DUIN's native tool ids (dropping ones with no native equivalent),
// and registers them via upsertSubagentType so `forkAgent({agentType})` — which
// post-M5 executes tools to completion — can dispatch them. Re-runnable on a
// vault switch (clears the prior vault's agents first).

import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join, sep } from 'path'
import matter from 'gray-matter'
import {
  upsertSubagentType,
  removeSubagentTypesBySource,
  BUILT_IN_SUBAGENT_TYPES,
  type SubagentTypeDef,
  type AllowedTools
} from './subagent-types'
import { mapCcToolNames } from './cc-tool-map'

// When an agent declares no mappable tools, give it a safe read-only floor so it
// can at least read the vault (these are mostly researchers/graders).
const DEFAULT_TOOLS = ['read_file', 'list_dir']

/** The marker that identifies a vault-sourced agent's `source` path. */
function isVaultAgentSource(source: string): boolean {
  return source.includes(`${sep}.duin${sep}agents${sep}`) || source.includes('/.duin/agents/')
}

// Floor to read-only only when NOTHING mapped — keeps an explicit, narrow set.
function withFloor(mapped: string[]): string[] {
  return mapped.length ? mapped : [...DEFAULT_TOOLS]
}

/** Parse a CC `tools:` field (comma string OR yaml list) → native tool ids,
 *  via the shared CC→native map. */
export function mapCcTools(raw: unknown): AllowedTools {
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed === '*' || trimmed.toLowerCase() === 'all') return '*'
    return withFloor(mapCcToolNames(trimmed.split(',')))
  }
  if (Array.isArray(raw)) {
    return withFloor(mapCcToolNames(raw.filter((x): x is string => typeof x === 'string')))
  }
  // unspecified → CC convention is "inherit all"; in DUIN we floor to read-only
  return [...DEFAULT_TOOLS]
}

/** Parse one vault agent .md (CC frontmatter) into a SubagentTypeDef. */
export function parseVaultAgentFile(filePath: string): SubagentTypeDef | null {
  try {
    if (!statSync(filePath).isFile()) return null
    const parsed = matter(readFileSync(filePath, 'utf-8'))
    const name = typeof parsed.data.name === 'string' ? parsed.data.name.trim() : ''
    const description =
      typeof parsed.data.description === 'string' ? parsed.data.description.trim() : ''
    const systemPrompt = parsed.content.trim()
    if (!name || !description || !systemPrompt) {
      console.warn(`[vault-agents] skipping ${filePath}: needs name + description + body`)
      return null
    }
    return {
      name,
      description,
      allowedTools: mapCcTools(parsed.data.tools),
      systemPrompt,
      source: filePath
    }
  } catch (err) {
    console.error('[vault-agents] failed to parse', filePath, err)
    return null
  }
}

export interface VaultAgentsLoadResult {
  loaded: number
  names: string[]
}

/**
 * Load (or reload) the vault's `.duin/agents/*.md` as dispatchable subagent
 * types. Clears any previously-loaded vault agents first so a vault switch
 * doesn't leave stale types. Top-level only — the `rubrics/` subdir is data the
 * agents read, not agents themselves. Best-effort: a bad file is skipped.
 */
export function loadVaultSubagents(vaultDir: string): VaultAgentsLoadResult {
  removeSubagentTypesBySource(isVaultAgentSource)
  const result: VaultAgentsLoadResult = { loaded: 0, names: [] }
  if (!vaultDir) return result
  const dir = join(vaultDir, '.duin', 'agents')
  if (!existsSync(dir)) return result
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return result
  }
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith('.md')) continue
    const def = parseVaultAgentFile(join(dir, entry))
    if (!def) continue
    // Trust boundary: a vault file must NOT silently redefine a built-in type
    // (e.g. an `Explore.md` granting itself apply_patch). User files in
    // userData may shadow built-ins; vault content may not.
    if (Object.prototype.hasOwnProperty.call(BUILT_IN_SUBAGENT_TYPES, def.name)) {
      console.warn(`[vault-agents] skipping '${def.name}': a vault agent may not shadow a built-in type`)
      continue
    }
    upsertSubagentType(def)
    result.loaded++
    result.names.push(def.name)
  }
  if (result.loaded) {
    console.log(`[vault-agents] registered ${result.loaded}: ${result.names.join(', ')}`)
  }
  return result
}
