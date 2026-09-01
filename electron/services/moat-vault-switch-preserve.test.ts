// Regression: switchMoatVault must never clear userData on an UNVERIFIED flush.
//
// The defect: step 1 (flush to the old vault) was wrapped in `if (oldVault)`, but step 2 —
// rmSync of the three moat JSONs and rmSync(lamprey-memory, {recursive, force}) — ran
// unconditionally. Three ways that clears data that exists nowhere else:
//   1. oldVault === null (the ordinary FIRST vault pick). Nothing was projected at all; the
//      'Remember this' notes accumulated under userData/lamprey-memory by memory:add are deleted,
//      and step 3 rehydrates 0 files from the brand-new, empty vault.
//   2. Origin mismatch. canProjectToVault gates the PROJECTION but never the DELETION, so
//      projectMemoryToVault logs 'refusing to clobber', returns 0 — and the delete then destroys
//      the very files it just refused to copy.
//   3. Partial IO failure. A throw inside projectMemoryToVault's per-file loop is warn-and-continue,
//      so N-of-40 written still proceeded to deleting all 40.
// Nothing else holds these notes: memory-store treats the files as canonical and drops index rows
// whose file is gone, and moat-backup's SOURCES do not include lamprey-memory.
//
// Pure fs — no better-sqlite3 and no electron in the import graph, so this suite really executes.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  switchMoatVault,
  writeMoatOrigin,
  auditMoatProjection,
  canProjectToVault,
  projectMoatToVault,
  projectMemoryToVault,
  rehydrateMoatFromVault,
  rehydrateMemoryFromVault,
  sameVaultPath,
  SWITCH_JOURNAL
} from './moat-durability'
import {
  tombstoneToTrash,
  snapshotToTrash,
  restoreTombstone,
  recordCreation,
  TRASH_DIR_NAME
} from './local-brain/vault-trash'

const MOAT_FILES = ['operator-model.json', 'success-traces.json', 'ans-capabilities.json']
const MEM_SUB = 'lamprey-memory'
const VAULT_MEM_SUB = join('.brain', '_memory-store')

let root: string
let userData: string
let oldVault: string
let newVault: string

function seedUserDataMemory(count: number): string[] {
  const rels: string[] = []
  for (let i = 0; i < count; i++) {
    const rel = i % 3 === 0 ? join('nested', `note-${i}.md`) : `note-${i}.md`
    const abs = join(userData, MEM_SUB, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, `# Remember this ${i}\nhand-written knowledge ${i}\n`, 'utf-8')
    rels.push(rel)
  }
  return rels
}

function seedUserDataMoat(): void {
  for (const name of MOAT_FILES) {
    writeFileSync(join(userData, name), JSON.stringify({ learned: name }), 'utf-8')
  }
}

function listMemory(dir: string): string[] {
  const out: string[] = []
  const walk = (rel: string): void => {
    let entries
    try {
      entries = readdirSync(join(dir, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const child = rel ? join(rel, e.name) : e.name
      if (e.isDirectory()) walk(child)
      else if (e.name.endsWith('.md')) out.push(child)
    }
  }
  walk('')
  return out.sort()
}

function journal(): Record<string, unknown>[] {
  const p = join(userData, SWITCH_JOURNAL)
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'moat-switch-'))
  userData = join(root, 'userData')
  oldVault = join(root, 'oldVault')
  newVault = join(root, 'newVault')
  for (const d of [userData, oldVault, newVault]) mkdirSync(d, { recursive: true })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'debug').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

describe('switchMoatVault — first vault pick (oldVault null)', () => {
  it('does not destroy the 40 memory notes that were never projected anywhere', () => {
    const rels = seedUserDataMemory(40)
    seedUserDataMoat()
    expect(listMemory(join(userData, MEM_SUB))).toHaveLength(40)

    switchMoatVault(userData, null, newVault)

    // The notes must still be readable by the app afterwards, wherever they now live.
    const inUserData = listMemory(join(userData, MEM_SUB))
    const inVault = listMemory(join(newVault, VAULT_MEM_SUB))
    for (const rel of rels) {
      const survived = inUserData.includes(rel) || inVault.includes(rel)
      expect(survived, `note ${rel} was destroyed by the vault switch`).toBe(true)
    }
    expect(inUserData.length + inVault.length).toBeGreaterThanOrEqual(40)
  })

  it('adopts the orphan moat forward into the newly picked vault', () => {
    seedUserDataMemory(3)
    seedUserDataMoat()

    switchMoatVault(userData, null, newVault)

    for (const name of MOAT_FILES) {
      const durable = join(newVault, '.brain', '_moat', name)
      expect(existsSync(durable), `${name} has no durable copy after the switch`).toBe(true)
      expect(JSON.parse(readFileSync(durable, 'utf-8'))).toEqual({ learned: name })
    }
    expect(listMemory(join(newVault, VAULT_MEM_SUB))).toHaveLength(3)
    // Adoption succeeded and was verified, so clearing userData is now safe and expected.
    expect(auditMoatProjection(userData, newVault).complete).toBe(true)
  })
})

describe('switchMoatVault — origin mismatch (canProjectToVault refuses)', () => {
  it('retains userData instead of deleting what the projection refused to copy', () => {
    seedUserDataMemory(12)
    seedUserDataMoat()
    // userData's moat belongs to some THIRD vault → projection to oldVault is refused.
    writeMoatOrigin(userData, join(root, 'someOtherVault'))

    switchMoatVault(userData, oldVault, newVault)

    expect(listMemory(join(userData, MEM_SUB))).toHaveLength(12)
    for (const name of MOAT_FILES) expect(existsSync(join(userData, name))).toBe(true)
  })

  it('journals what was and was not durable, and leaves the origin marker alone', () => {
    seedUserDataMemory(2)
    seedUserDataMoat()
    const foreign = join(root, 'someOtherVault')
    writeMoatOrigin(userData, foreign)

    switchMoatVault(userData, oldVault, newVault)

    const entries = journal()
    expect(entries).toHaveLength(1)
    expect(entries[0].outcome).toBe('retained')
    expect(entries[0].to).toBe(newVault)
    expect((entries[0].memoryPending as string[]).length).toBe(2)
    expect((entries[0].moatPending as string[]).length).toBe(3)
    expect(typeof entries[0].at).toBe('string')
    // H1's own guard keeps protecting the new vault while the content waits for a retry.
    expect(readFileSync(join(userData, '.moat-vault-origin'), 'utf-8')).toBe(foreign)
  })
})

describe('switchMoatVault — partial projection failure', () => {
  it('does not delete all N notes when only some of them reached the vault', () => {
    const rels = seedUserDataMemory(6)
    seedUserDataMoat()
    // Make exactly one destination unwritable: a non-empty DIRECTORY where the .md must land,
    // so atomicWriteFileSync's rename throws for that file only (warn-and-continue in the loop).
    const blocked = rels[1]
    const dest = join(oldVault, VAULT_MEM_SUB, blocked)
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, 'occupied.txt'), 'x', 'utf-8')

    const result = switchMoatVault(userData, oldVault, newVault)

    // A partial flush must not be treated as a complete one.
    expect(result).toMatchObject({
      ok: false,
      outcome: 'retained',
      from: oldVault,
      to: newVault,
      flushTarget: oldVault,
      memoryPending: [blocked]
    })
    expect(listMemory(join(userData, MEM_SUB))).toHaveLength(6)
    const entries = journal()
    expect(entries[0].outcome).toBe('retained')
    expect(entries[0].memoryPending).toEqual([blocked])
    // The five that DID land are still counted as durable — the report is precise, not all-or-nothing.
    expect(entries[0].memoryVerified).toBe(5)
  })
})

describe('switchMoatVault — verified flush still clears and reloads', () => {
  it('clears userData only after every file is byte-identical in the old vault', () => {
    seedUserDataMemory(5)
    seedUserDataMoat()
    // The new vault has its own durable record to be reloaded.
    const otherNote = join(newVault, VAULT_MEM_SUB, 'from-new-vault.md')
    mkdirSync(join(otherNote, '..'), { recursive: true })
    writeFileSync(otherNote, 'new vault knowledge\n', 'utf-8')

    const result = switchMoatVault(userData, oldVault, newVault)

    // Old vault holds the durable copy of everything that was cleared.
    expect(result).toEqual({
      ok: true,
      outcome: 'switched',
      from: oldVault,
      to: newVault,
      flushTarget: oldVault,
      moatVerified: 3,
      memoryVerified: 5,
      trashVerified: 0
    })
    expect(listMemory(join(oldVault, VAULT_MEM_SUB))).toHaveLength(5)
    for (const name of MOAT_FILES) {
      expect(existsSync(join(oldVault, '.brain', '_moat', name))).toBe(true)
      expect(existsSync(join(userData, name))).toBe(false)
    }
    // userData now reflects the NEW vault, not the old one.
    expect(listMemory(join(userData, MEM_SUB))).toEqual(['from-new-vault.md'])
    expect(readFileSync(join(userData, '.moat-vault-origin'), 'utf-8')).toBe(newVault)
    expect(journal()[0].outcome).toBe('cleared')
  })

  it('reports an unexpected exception as failed without touching valid userData', () => {
    seedUserDataMemory(2)
    seedUserDataMoat()
    const invalidOldVault = {} as unknown as string

    const result = switchMoatVault(userData, invalidOldVault, newVault)

    expect(result).toMatchObject({
      ok: false,
      outcome: 'failed',
      from: invalidOldVault,
      to: newVault,
      flushTarget: invalidOldVault
    })
    expect(result.outcome === 'failed' && result.error).toMatch(/path|object|string/i)
    expect(listMemory(join(userData, MEM_SUB))).toHaveLength(2)
    for (const name of MOAT_FILES) expect(existsSync(join(userData, name))).toBe(true)
  })

  it('never reports switched when cleanup fails and restores the prior verified snapshot', () => {
    seedUserDataMemory(2)
    seedUserDataMoat()
    writeMoatOrigin(userData, oldVault)
    const blocked = join(userData, 'operator-model.json')
    let failedOnce = false

    const result = switchMoatVault(userData, oldVault, newVault, {
      remove: ((target: Parameters<typeof rmSync>[0], options?: Parameters<typeof rmSync>[1]) => {
        if (!failedOnce && target === blocked) {
          failedOnce = true
          throw new Error('injected cleanup failure')
        }
        rmSync(target, options)
      }) as typeof rmSync
    })

    expect(result).toMatchObject({
      ok: false,
      outcome: 'failed',
      from: oldVault,
      to: newVault,
      restored: true
    })
    expect(result.outcome === 'failed' && result.error).toMatch(/cleanup failed/i)
    expect(readFileSync(join(userData, '.moat-vault-origin'), 'utf8')).toBe(oldVault)
    expect(listMemory(join(userData, MEM_SUB))).toHaveLength(2)
    for (const name of MOAT_FILES) {
      expect(readFileSync(join(userData, name), 'utf8')).toBe(
        readFileSync(join(oldVault, '.brain', '_moat', name), 'utf8')
      )
    }
  })

  it('switches away and back without resurrecting an additively projected deleted memory', () => {
    seedUserDataMemory(1)
    writeMoatOrigin(userData, oldVault)
    expect(switchMoatVault(userData, oldVault, newVault).ok).toBe(true)

    const memoryRoot = join(userData, MEM_SUB)
    const doomed = join(memoryRoot, 'doomed.md')
    mkdirSync(memoryRoot, { recursive: true })
    writeFileSync(doomed, 'delete me\n', 'utf8')
    projectMemoryToVault(userData, newVault)
    expect(tombstoneToTrash(memoryRoot, doomed, 'memory-store', 'operator delete').ok).toBe(true)
    projectMemoryToVault(userData, newVault)
    expect(existsSync(join(newVault, VAULT_MEM_SUB, 'doomed.md'))).toBe(true)

    expect(switchMoatVault(userData, newVault, oldVault).ok).toBe(true)
    const returned = switchMoatVault(userData, oldVault, newVault)

    expect(returned).toMatchObject({ ok: true, outcome: 'switched' })
    expect(existsSync(join(memoryRoot, 'doomed.md'))).toBe(false)
    expect(existsSync(join(memoryRoot, TRASH_DIR_NAME, '_tombstones.jsonl'))).toBe(true)
  })
})

// Regression: the H1 origin guard compared vault paths as raw strings with `===`, so the SAME
// directory spelled differently ('D:\x\Sample-brain' from the origin marker vs 'D:/x/Sample-brain' from
// settings.localBrainNotesDir) read as a foreign vault. Consequences, all silent:
//   - every 5-minute flush and the before-quit flush warn 'refusing to clobber' and write nothing,
//     so the vault projection freezes at the day the spelling changed (observed live: userData
//     operator-model.json 16354 bytes vs a vault projection of 5643 bytes eight days stale);
//   - brain-db-durability gates its export on the same predicate, so DB tables stop exporting too;
//   - and once the verified-flush guard landed, EVERY vault switch aborts as 'retained' forever,
//     because the flush it must verify is the flush the guard is refusing to perform.
// The anti-clobber guard was destroying the durability it exists to protect.
describe('H1 origin guard — path spelling must not disarm projection', () => {
  // Built by raw concatenation, NOT path.join — join pre-normalises `.`/`..` at the string level,
  // which would hand the guard an already-clean path and test nothing. This is the shape that
  // actually reaches the comparison: whatever the settings file or the picker literally stored.
  // `.`-segment and trailing-slash noise normalise identically on win32 and POSIX, so this case
  // exercises the defect (and fails without the fix) on every platform.
  const noisy = (p: string): string => p + '/./'

  it('treats a redundant-segment spelling of the same vault as the same vault', () => {
    writeMoatOrigin(userData, oldVault)
    expect(noisy(oldVault)).not.toBe(oldVault) // the strings really do differ

    expect(sameVaultPath(oldVault, noisy(oldVault))).toBe(true)
    expect(canProjectToVault(userData, noisy(oldVault))).toBe(true)
  })

  it('projects — rather than silently refusing — when the origin spelling differs', () => {
    seedUserDataMemory(4)
    seedUserDataMoat()
    writeMoatOrigin(userData, noisy(oldVault))

    expect(projectMoatToVault(userData, oldVault)).toBe(3)
    expect(projectMemoryToVault(userData, oldVault)).toBe(4)
    // The whole point: the durable record actually exists, so the moat survives a reinstall.
    expect(auditMoatProjection(userData, oldVault).complete).toBe(true)
  })

  it('completes a vault switch instead of aborting as retained forever', () => {
    seedUserDataMemory(3)
    seedUserDataMoat()
    writeMoatOrigin(userData, noisy(oldVault))

    switchMoatVault(userData, oldVault, newVault)

    expect(journal()[0].outcome).toBe('cleared')
    expect(listMemory(join(oldVault, VAULT_MEM_SUB))).toHaveLength(3)
    expect(readFileSync(join(userData, '.moat-vault-origin'), 'utf-8')).toBe(newVault)
  })

  // The live defect verbatim: the marker holds backslashes, settings holds forward slashes.
  // Separator equivalence and case-insensitivity are win32 filesystem facts, so assert them there.
  it.skipIf(process.platform !== 'win32')(
    'treats separator and case variants of the same Windows vault as the same vault',
    () => {
      const fwd = oldVault.replace(/\\/g, '/')
      expect(fwd).not.toBe(oldVault) // the strings really do differ
      expect(sameVaultPath(oldVault, fwd)).toBe(true)
      expect(sameVaultPath(oldVault, oldVault.toUpperCase())).toBe(true)

      writeMoatOrigin(userData, oldVault)
      expect(canProjectToVault(userData, fwd)).toBe(true)
    }
  )

  // Guard strength is unchanged: normalising spelling must not make two REAL vaults compare equal.
  it('still refuses a genuinely different vault', () => {
    seedUserDataMemory(2)
    seedUserDataMoat()
    writeMoatOrigin(userData, oldVault)

    expect(sameVaultPath(oldVault, newVault)).toBe(false)
    expect(canProjectToVault(userData, newVault)).toBe(false)
    expect(projectMoatToVault(userData, newVault)).toBe(0)
    expect(projectMemoryToVault(userData, newVault)).toBe(0)
    // And the refusal still routes into the preserve path, not the delete path.
    switchMoatVault(userData, newVault, join(root, 'thirdVault'))
    expect(journal()[0].outcome).toBe('retained')
    expect(listMemory(join(userData, MEM_SUB))).toHaveLength(2)
  })

  it('never compares two unset/empty paths as equal', () => {
    expect(sameVaultPath('', '')).toBe(false)
    expect(sameVaultPath(null, null)).toBe(false)
    expect(sameVaultPath(oldVault, '')).toBe(false)
  })
})

// Regression: the vault switch deleted the memory store's RECOVERY layer while reporting a
// verified flush.
//
// switchMoatVault step 3 does rmSync(<userData>/lamprey-memory, {recursive:true, force:true}).
// That is gated on auditMoatProjection reporting `complete`, but the audit enumerated userData via
// collectMdRel, which did `if (e.name.startsWith('.')) continue` for directories and only ever
// collected `*.md`. `<userData>/lamprey-memory/.trash` was therefore invisible to BOTH the
// projection and the audit that authorises the delete:
//   - memory-store's softDeleteMemoryFile tombstones deleted memories into it (real bodies),
//   - snapshotPriorVersion copies a memory's prior body into it before an overwrite replaces it,
//   - `_tombstones.jsonl` — not a .md file — is the journal of what went where and when.
// Concrete loss: consolidate-memory merges four hand-authored memories (three tombstoned, one
// prior body snapshotted); the user later re-picks / re-spells their vault folder, which is the
// ungated trigger for switchMoatVault; all the live .md files verify, so `complete: true`, the
// abort branch is skipped, and rmSync takes .trash with the rest. rehydrateMemoryFromVault then
// restores only what was projected — and .trash never was. Nothing else holds these bytes:
// moat-backup's SOURCES do not include lamprey-memory and the SQLite mirror holds live rows only.
// The 'cleared' journal line still said "flush verified byte-for-byte".
//
// These tests drive the REAL vault-trash primitives with the memory root as the trash root,
// exactly as memory-store.ts does.
describe('switchMoatVault — the .trash recovery layer is data, not scratch', () => {
  const memRoot = (): string => join(userData, MEM_SUB)
  const trashOf = (root: string): string => join(root, TRASH_DIR_NAME)

  function listAll(dir: string): string[] {
    const out: string[] = []
    const walk = (rel: string): void => {
      let entries
      try {
        entries = readdirSync(join(dir, rel), { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const child = rel ? join(rel, e.name) : e.name
        if (e.isDirectory()) walk(child)
        else out.push(child)
      }
    }
    walk('')
    return out.sort()
  }

  /** Seed the shape consolidate-memory leaves behind: 3 tombstoned memories, 1 pre-overwrite
   *  snapshot of the merge target, and the surviving live note. Returns the trash contents. */
  function seedRecoveryLayer(): { trashRels: string[]; bodies: Record<string, string> } {
    const proj = join(memRoot(), '__global__')
    mkdirSync(proj, { recursive: true })
    const bodies: Record<string, string> = {}
    for (const name of ['a', 'b', 'c']) {
      const abs = join(proj, `${name}.md`)
      const body = `# ${name}\nhand-authored memory ${name}\n`
      writeFileSync(abs, body, 'utf-8')
      const res = tombstoneToTrash(memRoot(), abs, 'memory-store', 'consolidated')
      expect(res.ok, `tombstone ${name} failed`).toBe(true)
      bodies[`${name}.md`] = body
    }
    const target = join(proj, 'target.md')
    const prior = '# target\nthe hand-written body before the merge overwrote it\n'
    writeFileSync(target, prior, 'utf-8')
    const snap = snapshotToTrash(memRoot(), target, 'memory-store', 'merge overwrite')
    expect(snap.ok).toBe(true)
    bodies['target.md'] = prior
    // The merge then rewrote the live note in place; the prior body survives only in .trash.
    writeFileSync(target, '# target\nMODEL-MERGED body\n', 'utf-8')
    return { trashRels: listAll(trashOf(memRoot())), bodies }
  }

  it('projects tombstones, snapshots and the journal into the vault before deleting them', () => {
    const { trashRels, bodies } = seedRecoveryLayer()
    seedUserDataMoat()
    // Everything the seed claims to have made is really there, including the non-.md journal.
    expect(trashRels).toContain('_tombstones.jsonl')
    expect(trashRels).toHaveLength(5)

    switchMoatVault(userData, oldVault, newVault)

    // The switch DID clear userData (the live notes verified) — so the recovery layer must be
    // durable in the vault it was flushed to, byte-for-byte.
    const durableTrash = trashOf(join(oldVault, VAULT_MEM_SUB))
    expect(
      existsSync(durableTrash),
      'the .trash recovery layer was destroyed by the vault switch with no durable copy'
    ).toBe(true)
    expect(listAll(durableTrash).sort()).toEqual(trashRels)
    for (const [orig, body] of Object.entries(bodies)) {
      const tomb = listAll(durableTrash).find((f) => f === orig || f.startsWith(orig.replace('.md', '.')))
      expect(tomb, `no tombstone for ${orig}`).toBeTruthy()
      expect(readFileSync(join(durableTrash, tomb as string), 'utf-8')).toBe(body)
    }
    // And the tombstone journal — the "what changed, when, where it went" trail — travelled too.
    const journalLines = readFileSync(join(durableTrash, '_tombstones.jsonl'), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    expect(journalLines).toHaveLength(4)
    expect(journalLines.filter((l) => l.op === 'overwrite')).toHaveLength(1)
  })

  it('records the recovery layer in the switch journal instead of silently omitting it', () => {
    seedRecoveryLayer()
    seedUserDataMoat()

    switchMoatVault(userData, oldVault, newVault)

    const entry = journal()[0]
    expect(entry.outcome).toBe('cleared')
    // Before the fix this count was structurally zero: the audit could not see .trash at all,
    // yet still certified "flush verified byte-for-byte" and authorised the recursive delete.
    expect(entry.trashVerified).toBe(5)
  })

  it('refuses to certify the flush while the recovery layer is unprojected', () => {
    seedRecoveryLayer()
    // Simulate the pre-fix projection: live .md files only, nothing from .trash.
    const live = join(memRoot(), '__global__', 'target.md')
    const dest = join(oldVault, VAULT_MEM_SUB, '__global__', 'target.md')
    mkdirSync(join(dest, '..'), { recursive: true })
    writeFileSync(dest, readFileSync(live, 'utf-8'), 'utf-8')

    const audit = auditMoatProjection(userData, oldVault)
    expect(audit.complete, 'audit certified a flush that omitted the entire recovery layer').toBe(false)
    expect(audit.memoryPending.filter((r) => r.includes(TRASH_DIR_NAME))).toHaveLength(5)
    expect(audit.trashVerified).toBe(0)
  })

  it('adopts the recovery layer forward on a first vault pick (oldVault null)', () => {
    const { trashRels } = seedRecoveryLayer()

    switchMoatVault(userData, null, newVault)

    const durableTrash = trashOf(join(newVault, VAULT_MEM_SUB))
    expect(listAll(durableTrash).sort()).toEqual(trashRels)
  })

  it('rehydrates the recovery layer back into userData on reinstall', () => {
    const { trashRels } = seedRecoveryLayer()
    expect(projectMemoryToVault(userData, oldVault)).toBeGreaterThan(0)
    // Reinstall: userData is gone entirely, the vault is all that is left.
    rmSync(memRoot(), { recursive: true, force: true })

    rehydrateMemoryFromVault(userData, oldVault)

    expect(listAll(trashOf(memRoot())).sort()).toEqual(trashRels)
  })

  it('does not resurrect tombstones as live notes (they stay under .trash)', () => {
    seedRecoveryLayer()
    switchMoatVault(userData, oldVault, newVault)
    // memory-store's scanner skips dot-directories, so projecting .trash cannot re-index deleted
    // memories as live ones — the recovery layer must land under .trash and nowhere else.
    const vaultMem = join(oldVault, VAULT_MEM_SUB)
    expect(listMemory(vaultMem).filter((r) => !r.includes(TRASH_DIR_NAME))).toEqual([
      join('__global__', 'target.md')
    ])
  })
})

// Regression: the boot rehydrate resurrected every memory the user had ever deleted.
//
// The vault projection is write-only — projectMemoryToVault only ever writes, and nothing in
// moat-durability prunes the projected tree — so a memory deleted from userData keeps its vault
// copy forever. rehydrateMemoryFromVault restores exactly "present in the vault, absent from
// userData", which a deleted memory satisfies every bit as well as a reinstalled one does. And it
// runs on EVERY launch (electron/main.ts, inside app.whenReady()), not only on a fresh install.
//
// So: user saves "never add a coauthor trailer" -> the 5-minute flushMoat projects it -> the user
// deletes it in the Memory panel (softDeleteMemoryFile -> tombstoneToTrash renames it into
// <lamprey-memory>/.trash, the index row is dropped, MEMORY.md is regenerated without it) -> next
// launch writes it straight back out of the vault, scanAndSync re-indexes it, and it is injected
// into the <memory_index> block of every chat turn again. Deleting it again resurrects it again:
// a retracted fact could not be made to stay retracted. What hid this is that the delete really
// does work — the file is gone from userData and gone from MEMORY.md — until the next boot.
//
// These tests drive the REAL vault-trash primitives with the memory root as the trash root, exactly
// as memory-store.ts does.
describe('rehydrateMemoryFromVault — a deleted memory must stay deleted', () => {
  const memRoot = (): string => join(userData, MEM_SUB)

  function saveMemory(name: string, body: string): string {
    const abs = join(memRoot(), '__global__', `${name}.md`)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, body, 'utf-8')
    return abs
  }

  it('does not restore a memory the user deleted, on the ordinary every-boot rehydrate', () => {
    const abs = saveMemory('no_coauthor', '# no_coauthor\nnever add a coauthor trailer\n')
    expect(projectMemoryToVault(userData, oldVault)).toBe(1) // flushMoat: the 5-minute timer
    expect(tombstoneToTrash(memRoot(), abs, 'memory-store', 'memory:delete no_coauthor').ok).toBe(true)
    expect(existsSync(abs)).toBe(false)
    projectMemoryToVault(userData, oldVault) // the next flush — additive, so the vault copy stays

    rehydrateMemoryFromVault(userData, oldVault)

    expect(existsSync(abs), 'the deleted memory was restored out of the vault projection').toBe(false)
    // And the delete stays undoable — withholding is not deleting.
    expect(existsSync(join(memRoot(), TRASH_DIR_NAME, 'no_coauthor.md'))).toBe(true)
    expect(existsSync(join(oldVault, VAULT_MEM_SUB, '__global__', 'no_coauthor.md'))).toBe(true)
  })

  it('withholds only the deleted one when userData is gone entirely (reinstall)', () => {
    const kept = saveMemory('trip_prefs', '# trip_prefs\naisle seat, never the red-eye\n')
    const doomed = saveMemory('no_coauthor', '# no_coauthor\nnever add a coauthor trailer\n')
    projectMemoryToVault(userData, oldVault)
    expect(tombstoneToTrash(memRoot(), doomed, 'memory-store', 'memory:delete no_coauthor').ok).toBe(true)
    projectMemoryToVault(userData, oldVault)
    rmSync(memRoot(), { recursive: true, force: true }) // reinstall: the vault is all that is left

    rehydrateMemoryFromVault(userData, oldVault)

    expect(existsSync(kept), 'a memory the user never deleted was not restored').toBe(true)
    expect(existsSync(doomed)).toBe(false)
    // The recovery layer still comes back, so the delete is still undoable after the reinstall.
    expect(existsSync(join(memRoot(), TRASH_DIR_NAME, '_tombstones.jsonl'))).toBe(true)
    expect(existsSync(join(memRoot(), TRASH_DIR_NAME, 'no_coauthor.md'))).toBe(true)
  })

  it('restores a memory re-created under a previously deleted name', () => {
    const abs = saveMemory('no_coauthor', '# no_coauthor\nfirst take\n')
    projectMemoryToVault(userData, oldVault)
    expect(tombstoneToTrash(memRoot(), abs, 'memory-store', 'memory:delete no_coauthor').ok).toBe(true)
    // The user types it back in. writeMemoryFile journals the create, so the delete stops being the
    // last word about this path — otherwise the resurrection fix would become a disappearance bug.
    saveMemory('no_coauthor', '# no_coauthor\nsecond take\n')
    recordCreation(memRoot(), abs, 'memory-store')
    projectMemoryToVault(userData, oldVault)
    rmSync(memRoot(), { recursive: true, force: true })

    rehydrateMemoryFromVault(userData, oldVault)

    expect(existsSync(abs), 'the re-created memory stayed suppressed by the older delete').toBe(true)
    expect(readFileSync(abs, 'utf-8')).toContain('second take')
  })

  it('restores a memory whose delete was undone from the trash', () => {
    const abs = saveMemory('no_coauthor', '# no_coauthor\nnever add a coauthor trailer\n')
    projectMemoryToVault(userData, oldVault)
    const t = tombstoneToTrash(memRoot(), abs, 'memory-store', 'memory:delete no_coauthor')
    expect(t.ok).toBe(true)
    expect(restoreTombstone(memRoot(), (t as { trashRel: string }).trashRel).ok).toBe(true)
    projectMemoryToVault(userData, oldVault)
    rmSync(memRoot(), { recursive: true, force: true })

    rehydrateMemoryFromVault(userData, oldVault)

    expect(existsSync(abs), 'an undone delete still suppressed the memory').toBe(true)
  })

  it('still restores a memory whose only journal line is an overwrite snapshot', () => {
    // snapshotPriorVersion runs on EVERY memory edit, so reading an overwrite line as a deletion
    // would quietly make every edited memory unrestorable — the opposite failure, and a worse one.
    const abs = saveMemory('trip_prefs', '# trip_prefs\naisle seat\n')
    expect(snapshotToTrash(memRoot(), abs, 'memory-store', 'memory:overwrite trip_prefs').ok).toBe(true)
    writeFileSync(abs, '# trip_prefs\nwindow seat\n', 'utf-8')
    projectMemoryToVault(userData, oldVault)
    rmSync(memRoot(), { recursive: true, force: true })

    rehydrateMemoryFromVault(userData, oldVault)

    expect(existsSync(abs)).toBe(true)
    expect(readFileSync(abs, 'utf-8')).toContain('window seat')
  })

  it('honours a delete that has not been flushed to the vault yet', () => {
    // The delete is written synchronously into userData's journal; the flush that projects it may
    // be up to five minutes away, and a crash in between must not un-delete the memory on reboot.
    const abs = saveMemory('no_coauthor', '# no_coauthor\nnever add a coauthor trailer\n')
    projectMemoryToVault(userData, oldVault)
    expect(tombstoneToTrash(memRoot(), abs, 'memory-store', 'memory:delete no_coauthor').ok).toBe(true)

    rehydrateMemoryFromVault(userData, oldVault) // no flush in between

    expect(existsSync(abs)).toBe(false)
  })
})

// Regression: a PARTIAL rehydrate restamped the moat origin, disarming H1 for the next flush.
//
// rehydrateMoatFromVault restores only the moat files userData LACKS ('runtime copy wins
// in-session'), then stamped the origin whenever `restored.length > 0`. That predicate proves only
// that at least ONE of the three files came from the vault, never that all of them did — so the
// stamp asserted something the loop had not established.
//
// The state that makes it bite is the one switchMoatVault's verified-flush abort deliberately
// creates: settings.localBrainNotesDir is written to B BEFORE switchMoatVault runs (settings.ts),
// the flush to A fails to verify, and the abort leaves the marker naming A on purpose so
// canProjectToVault keeps refusing. Next boot (main.ts: rehydrateMoatFromVault(userData, settings
// vault)) userData holds A's operator-model.json + ans-capabilities.json, established vault B
// supplies the success-traces.json this operator never had — one restore, and the marker was
// relabelled B. canProjectToVault(B) then returned true, so the 5-minute flush timer and the
// before-quit flush wrote A's moat over B's, and projectMemoryToVault (same predicate) took B's
// 'Remember this' notes with it. The only record was a journal line saying the switch was
// 'retained'.
describe('rehydrateMoatFromVault — a partial restore must not restamp the origin', () => {
  /** The post-aborted-switch state: userData holds vault A's moat minus one file; the marker still
   *  names A; established vault B has all three. */
  function seedAbortedSwitch(): void {
    writeFileSync(join(userData, 'operator-model.json'), JSON.stringify({ from: 'A', facts: 52 }), 'utf-8')
    writeFileSync(join(userData, 'ans-capabilities.json'), JSON.stringify({ from: 'A', caps: 3 }), 'utf-8')
    // no success-traces.json — this operator has never endorsed anything
    writeMoatOrigin(userData, oldVault)
    seedVaultMoat(newVault, 'B')
  }

  function seedVaultMoat(vault: string, tag: string): void {
    for (const name of MOAT_FILES) {
      const p = join(vault, '.brain', '_moat', name)
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, JSON.stringify({ from: tag, name }), 'utf-8')
    }
  }

  const origin = (): string => readFileSync(join(userData, '.moat-vault-origin'), 'utf-8')

  it('leaves the origin naming the old vault when userData still holds that vault moat', () => {
    seedAbortedSwitch()

    const restored = rehydrateMoatFromVault(userData, newVault)

    expect(restored).toEqual(['success-traces.json']) // exactly the file userData lacked
    expect(origin(), 'a one-file restore relabelled userData as belonging to the new vault').toBe(oldVault)
    expect(canProjectToVault(userData, newVault)).toBe(false)
  })

  it('keeps the next flush from overwriting the new vault durable moat with the old vault', () => {
    seedAbortedSwitch()
    seedUserDataMemory(4) // vault A's 'Remember this' notes, still in userData

    rehydrateMoatFromVault(userData, newVault)
    // This is main.ts's flushMoat: the 5-minute timer and the before-quit handler.
    expect(projectMoatToVault(userData, newVault)).toBe(0)
    expect(projectMemoryToVault(userData, newVault)).toBe(0)

    // Vault B's durable record is untouched — still B's, not A's.
    const durable = (name: string): unknown =>
      JSON.parse(readFileSync(join(newVault, '.brain', '_moat', name), 'utf-8'))
    expect(durable('operator-model.json')).toEqual({ from: 'B', name: 'operator-model.json' })
    expect(durable('ans-capabilities.json')).toEqual({ from: 'B', name: 'ans-capabilities.json' })
    expect(listMemory(join(newVault, VAULT_MEM_SUB))).toHaveLength(0)
  })

  it('still stamps on a clean full restore — the reinstall case the stamp exists for', () => {
    seedVaultMoat(newVault, 'B') // userData is empty: fresh install over a synced vault

    expect(rehydrateMoatFromVault(userData, newVault)).toHaveLength(3)

    expect(origin()).toBe(newVault)
    expect(canProjectToVault(userData, newVault)).toBe(true)
  })

  it('still stamps when the origin is unset, even with nothing to restore', () => {
    seedUserDataMoat() // pre-H1 userData, no marker, vault has no projection yet

    expect(rehydrateMoatFromVault(userData, newVault)).toEqual([])

    expect(origin()).toBe(newVault)
  })

  it('leaves an already-correct origin intact on an ordinary same-vault boot', () => {
    seedUserDataMoat()
    writeMoatOrigin(userData, oldVault)
    seedVaultMoat(oldVault, 'A')

    expect(rehydrateMoatFromVault(userData, oldVault)).toEqual([]) // nothing missing

    expect(origin()).toBe(oldVault)
    expect(canProjectToVault(userData, oldVault)).toBe(true)
  })
})

describe('auditMoatProjection', () => {
  it('reports a null target as fully unprojected rather than complete', () => {
    seedUserDataMemory(4)
    seedUserDataMoat()
    const audit = auditMoatProjection(userData, null)
    expect(audit.complete).toBe(false)
    expect(audit.memoryPending).toHaveLength(4)
    expect(audit.moatPending).toHaveLength(3)
  })

  it('is content-based: a same-path vault file with different bytes does not count as projected', () => {
    seedUserDataMemory(1)
    const rel = listMemory(join(userData, MEM_SUB))[0]
    const dest = join(oldVault, VAULT_MEM_SUB, rel)
    mkdirSync(join(dest, '..'), { recursive: true })
    writeFileSync(dest, 'STALE, different content\n', 'utf-8')

    const audit = auditMoatProjection(userData, oldVault)
    expect(audit.complete).toBe(false)
    expect(audit.memoryPending).toEqual([rel])
  })

  it('is complete when userData holds nothing to project', () => {
    expect(auditMoatProjection(userData, oldVault).complete).toBe(true)
  })
})
