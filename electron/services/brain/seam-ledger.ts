// seam-ledger — what the seam has projected, per fact, kept IN THE VAULT.
//
// `<vault>/.duin/_state/seam-ledger.json`, keyed by fact id: the slug the fact was written to, the
// content hash, when it was last written, and the status / claim / lineage that produced it. Two jobs:
//   1. idempotency (W3) — a re-projection whose bytes would not change writes nothing, so a daily
//      reconcile does not churn the vault or any watcher on it;
//   2. human authority (W4) — a fact the ledger says was projected but whose file is gone from
//      `memory/` (and not in `_retired/`) was deleted by hand; a file whose claim line differs from the
//      ledger's was edited by hand. Both flow back into the operator model.
// It lives in the vault, not in user data, on purpose: a vault switch starts with an empty ledger, so
// the new vault's missing files can never read as a mass deletion. A missing or corrupt ledger is
// empty — the worst case is one redundant re-projection, never a lost fact.
import { existsSync, readFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { createHash } from 'crypto'
import { atomicWriteFileSync } from '../atomic-write'
import { brainStateDir } from './brain-state-dir'

export const SEAM_LEDGER_FILE = 'seam-ledger.json'

export interface SeamLedgerEntry {
  slug: string
  hash: string
  writtenAt: number
  status: string
  claim: string
  /** Sorted, comma-joined ids of the facts this concept supersedes (the frontmatter `supersedes:`). */
  lineage: string
  /** W4: the human annotated the file (marker kept, claim intact) — leave it alone until the fact changes. */
  annotated?: boolean
}

export interface SeamLedger {
  version: 1
  facts: Record<string, SeamLedgerEntry>
}

/** `memoryDir` is `<vault>/.brain/memory`; the ledger sits beside the brain's other `.duin/_state` ledgers. */
export function seamLedgerPath(memoryDir: string): string {
  const vault = dirname(dirname(memoryDir))
  return join(brainStateDir(vault), SEAM_LEDGER_FILE)
}

export function loadSeamLedger(memoryDir: string): SeamLedger {
  const empty: SeamLedger = { version: 1, facts: {} }
  try {
    if (!memoryDir) return empty
    const p = seamLedgerPath(memoryDir)
    if (!existsSync(p)) return empty
    const j = JSON.parse(readFileSync(p, 'utf-8')) as Partial<SeamLedger> | null
    if (!j || typeof j !== 'object' || !j.facts || typeof j.facts !== 'object') return empty
    const facts: Record<string, SeamLedgerEntry> = {}
    for (const [id, e] of Object.entries(j.facts as Record<string, Partial<SeamLedgerEntry>>)) {
      if (!e || typeof e.slug !== 'string' || typeof e.hash !== 'string') continue
      facts[id] = {
        slug: e.slug,
        hash: e.hash,
        writtenAt: typeof e.writtenAt === 'number' ? e.writtenAt : 0,
        status: typeof e.status === 'string' ? e.status : '',
        claim: typeof e.claim === 'string' ? e.claim : '',
        lineage: typeof e.lineage === 'string' ? e.lineage : '',
        ...(e.annotated ? { annotated: true } : {})
      }
    }
    return { version: 1, facts }
  } catch {
    return empty
  }
}

/** Never throws: a ledger write failure costs one redundant re-projection, never a fact. */
export function saveSeamLedger(memoryDir: string, ledger: SeamLedger): void {
  try {
    if (!memoryDir) return
    const p = seamLedgerPath(memoryDir)
    mkdirSync(dirname(p), { recursive: true })
    atomicWriteFileSync(p, JSON.stringify(ledger, null, 2) + '\n', 0o644)
  } catch {
    /* best-effort */
  }
}

export function contentHash(md: string): string {
  return createHash('sha1').update(md, 'utf8').digest('hex')
}
