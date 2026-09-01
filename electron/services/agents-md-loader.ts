import * as fs from 'fs'
import * as path from 'path'

const CAP = 20_000 // 20 KB cap; the foundation file is meant to be concise.

let cached: string = ''
let cachedAt = 0
// The cache key. Without the root in it, two workspaces read within the same 5s
// window got each other's operating contract — and the dedup below compares
// paths, so a stale path would be worse than no dedup at all.
let cachedRoot: string | null = null
let cachedPath: string | null = null

// DUIN's foundation/operating-instructions file is `brain.md` (preferred). The
// Codex/Claude conventions (AGENTS.md / CLAUDE.md) are kept only as fallbacks
// for imported vaults; brain.md wins whenever it exists.
const CANDIDATE_NAMES = [
  'brain.md',
  'Brain.md',
  'BRAIN.md',
  'AGENTS.md',
  'agents.md',
  'Agents.md',
  'CLAUDE.md'
]

function findAgentsMd(root: string): string | null {
  for (const name of CANDIDATE_NAMES) {
    const p = path.join(root, name)
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p
    } catch {
      // ignore
    }
  }
  return null
}

// Re-read at most once per 5s. Cheap enough to call on every chat send.
function load(workspaceRoot?: string): void {
  const root = workspaceRoot || process.cwd()
  const now = Date.now()
  if (cachedRoot === root && now - cachedAt < 5000) return
  const p = findAgentsMd(root)
  cachedAt = now
  cachedRoot = root
  cachedPath = p
  if (!p) {
    cached = ''
    return
  }
  try {
    const raw = fs.readFileSync(p, 'utf8')
    cached = raw.length > CAP ? raw.slice(0, CAP) + '\n\n[…truncated…]' : raw
  } catch {
    cached = ''
    cachedPath = null
  }
}

export function readAgentsMd(workspaceRoot?: string): string {
  load(workspaceRoot)
  return cached
}

/** Absolute path of the file `readAgentsMd` would return the contents of, or
 *  null when there is none. Lets a caller that ALREADY has this file's content
 *  in the prompt skip the duplicate injection. */
export function resolveAgentsMdPath(workspaceRoot?: string): string | null {
  load(workspaceRoot)
  return cachedPath
}

/** Path equality that survives separator style, `..` segments and — on Windows
 *  only — case. Two spellings of one file must compare equal or the dedup below
 *  silently does nothing. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const r = path.resolve(p)
    return process.platform === 'win32' ? r.toLowerCase() : r
  }
  return norm(a) === norm(b)
}

/**
 * True when injecting `<agents_md>` would put a file into the prompt that is
 * ALREADY there via `alreadyPresent`.
 *
 * BRAIN.md is the real case: it is both DUIN's operating-instructions file (so
 * this loader finds it) and the second entry of the brain identity block, and
 * the two readers resolve independent roots. Shipping both wastes the whole file
 * and — because they read at different moments through different caches — can
 * put two DISAGREEING copies of the operating contract in one turn.
 */
export function agentsMdDuplicates(
  workspaceRoot: string | undefined,
  alreadyPresent: readonly string[]
): boolean {
  const p = resolveAgentsMdPath(workspaceRoot)
  if (!p) return false
  return alreadyPresent.some((other) => samePath(other, p))
}

export function invalidateAgentsMd(): void {
  cached = ''
  cachedAt = 0
  cachedRoot = null
  cachedPath = null
}
