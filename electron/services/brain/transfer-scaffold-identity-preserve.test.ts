// A hand-written ME.md / BRAIN.md must survive `brain:scaffoldNewOperator` — and if it is
// replaced, the prior bytes must be recoverable and the replacement recorded.
//
// The defect: `scaffoldNewOperatorBrain(vault, { rawSrcDir: <other dir>, identity })` destroyed both
// files, reported ok:true, and left nothing to recover from. Two independent causes, both fixed here:
//
//  1. PROXIMATE — scaffold-harness's foundation writer `w()` gated its entire preserve-to-00-Inbox +
//     alteration-ledger block on `if (inPlace && …)`. transfer-scaffold calls
//     `scaffoldHarness(rawSrcDir, vaultDir)`, i.e. COPY-OUT whose output root IS the operator's live
//     vault, so the gate was false and every stub foundation file was bare-written over the
//     operator's root notes. The correct guard (`writeTraceable`) already existed 400 lines above in
//     the same file and was already used by the starter RULES; this one call site skipped it.
//     (Pattern A: the guard exists nearby and exactly one call site skips it.)
//
//  2. transfer-scaffold inferred writeIdentityFiles' `overwrite` from `pillarsWritten`, which is
//     scaffoldHarness's `ok` — "the pass completed", not "a stub was written and the prior file
//     preserved". TOTAL failure was handled (ok:false ⇒ overwrite false); PARTIAL was not: a
//     refused/failed foundation write still returns ok, so `overwrite` flipped true and switched off
//     write-identity's only protection over a file the scaffold had deliberately declined to touch.
//     (Pattern B: total failure guarded, partial failure not.)
//
// Fix direction is preserve+record+stamp, not refuse-to-write: the vault is meant to self-evolve, so
// replacing these files is allowed — every alteration just has to be traceable.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../providers/registry', () => ({ chatOnce: vi.fn(), routeModel: () => null }))

import { scaffoldNewOperatorBrain } from './transfer-scaffold'
import { writeIdentityFiles } from './write-identity'
import { setOperatorModelPath, __resetOperatorModel } from './operator-model'

/** Substantial hand-written identity content, with a sentinel we can hunt for anywhere on disk. */
const SENTINEL = 'SENTINEL-hand-written-identity-must-survive'
const handwritten = (what: string): string =>
  `# My own ${what}\n\n${SENTINEL}\n\n` +
  Array.from({ length: 60 }, (_, i) => `Line ${i} the operator wrote by hand about ${what}.`).join('\n')

const ME_MD = ['---', 'type: identity', '---', '', '# Gao', '', '发行负责人', ''].join('\n')
const BRAIN_MD = ['---', 'type: operating-instructions', '---', '', '# BRAIN', '', '- Ground answers in the vault', ''].join('\n')

/** Every file under `dir` (recursively) whose text contains the sentinel. */
function survivors(dir: string, base = dir): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      out.push(...survivors(full, base))
      continue
    }
    try {
      if (readFileSync(full, 'utf-8').includes(SENTINEL)) out.push(full.slice(base.length + 1))
    } catch {
      /* unreadable → not a survivor */
    }
  }
  return out
}

const readLedger = (vault: string): Record<string, unknown>[] => {
  const p = join(vault, '.duin', '_state', 'scaffold-alterations.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf-8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
}

describe('scaffoldNewOperator — a hand-written identity is never destroyed without a trace', () => {
  let vault: string
  let raw: string
  let userData: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-vault-'))
    raw = mkdtempSync(join(tmpdir(), 'duin-raw-'))
    userData = mkdtempSync(join(tmpdir(), 'duin-ud-'))
    setOperatorModelPath(userData)
    __resetOperatorModel()
    // Raw notes to scaffold FROM — a different dir than the vault, i.e. copy-out mode.
    writeFileSync(join(raw, 'note.md'), '# A raw note\n\nSome content about the work.\n')
  })
  afterEach(() => {
    for (const d of [vault, raw, userData]) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  })

  it('copy-out INTO a live vault preserves + ledgers the operator ME.md/BRAIN.md it replaces', async () => {
    writeFileSync(join(vault, 'ME.md'), handwritten('identity'), 'utf-8')
    writeFileSync(join(vault, 'BRAIN.md'), handwritten('operating contract'), 'utf-8')

    const res = await scaffoldNewOperatorBrain(vault, {
      rawSrcDir: raw,
      identity: { meMd: ME_MD, brainMd: BRAIN_MD }
    })
    expect(res.ok).toBe(true)

    // (a) The hand-written bytes still exist SOMEWHERE recoverable. This is the assertion that
    //     failed before the fix: the pre-fix run left survivors === [].
    const found = survivors(vault)
    expect(found.length, 'the hand-written identity must survive somewhere in the vault').toBeGreaterThan(0)
    for (const what of ['ME', 'BRAIN']) {
      expect(
        found.some((f) => f.toUpperCase().includes(what)),
        `${what}.md's prior content must be recoverable, found: ${JSON.stringify(found)}`
      ).toBe(true)
    }

    // (b) The alteration is machine-readable — what changed, when, by whom, where the original went.
    const rows = readLedger(vault)
    for (const name of ['ME.md', 'BRAIN.md']) {
      const row = rows.find((r) => String(r.path).endsWith(name))
      expect(row, `an alteration of ${name} must be ledgered`).toBeTruthy()
      expect(row!.by).toBe('scaffold:foundation')
      expect(String(row!.at)).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(Number(row!.priorBytes)).toBeGreaterThan(0)
      expect(existsSync(join(vault, String(row!.priorCopy)))).toBe(true)
    }
  })

  it('reports the per-file outcome instead of only "the pass completed"', async () => {
    // The signal transfer-scaffold needs in order to stop inferring destruction rights from `ok`.
    const { scaffoldHarness } = await import('./scaffold-harness')
    writeFileSync(join(vault, 'ME.md'), handwritten('identity'), 'utf-8')
    const out = await scaffoldHarness(raw, vault)
    expect(out.ok).toBe(true)
    expect(out.foundation['ME.md']).toBe('altered') // operator content replaced, preserved + recorded
    expect(out.foundation['BRAIN.md']).toBe('written') // nothing was there; nothing at risk
  })

  it('does NOT overwrite identity when the scaffold could not claim that file (partial failure)', async () => {
    // The residual hazard that is solely transfer-scaffold's: a foundation write the scaffold
    // REFUSED (because it could not preserve the prior content) still left `ok: true`, so the old
    // `overwrite = pillarsWritten` destroyed exactly the file the scaffold had declined to touch.
    // Simulate that shape directly: scaffold reports ok with ME.md skipped.
    vi.resetModules()
    vi.doMock('./scaffold-harness', () => ({
      scaffoldHarness: vi.fn(async () => ({
        ok: true,
        counts: {},
        tracks: [],
        diagnosisPath: '',
        foundation: { 'ME.md': 'skipped', 'BRAIN.md': 'written' }
      }))
    }))
    const { scaffoldNewOperatorBrain: scoped } = await import('./transfer-scaffold')

    writeFileSync(join(vault, 'ME.md'), handwritten('identity'), 'utf-8')
    const res = await scoped(vault, { rawSrcDir: raw, identity: { meMd: ME_MD, brainMd: BRAIN_MD } })

    expect(res.ok).toBe(true)
    expect(res.pillarsWritten).toBe(true) // the pass "completed" — and that must not license a stomp
    expect(readFileSync(join(vault, 'ME.md'), 'utf-8')).toContain(SENTINEL)
    vi.doUnmock('./scaffold-harness')
    vi.resetModules()
  })

  it('write-identity: an authorized overwrite still snapshots the prior bytes to .trash', async () => {
    // Isolated control on the SECOND guard. `overwrite: true` is a legitimate request — it just has
    // to stay recoverable, the way every sibling note-writer in this tree already does it.
    writeFileSync(join(vault, 'ME.md'), handwritten('identity'), 'utf-8')
    const res = writeIdentityFiles({ notesDir: vault, meMd: ME_MD, brainMd: BRAIN_MD, overwrite: true })

    expect(res.ok).toBe(true)
    expect(res.wrote).toContain('ME.md')
    expect(readFileSync(join(vault, 'ME.md'), 'utf-8')).toContain('发行负责人') // the new identity landed
    const trashRel = res.replaced?.['ME.md']
    expect(trashRel, 'the replaced identity must be recorded as preserved').toBeTruthy()
    expect(readFileSync(join(vault, trashRel!), 'utf-8')).toContain(SENTINEL)
    expect(survivors(vault).length).toBeGreaterThan(0)
  })

  it('write-identity: refuses the overwrite (and says so) when the prior bytes cannot be preserved', async () => {
    // vault-trash's documented contract: a failed snapshot means the caller must NOT write.
    // `.trash` occupied by a FILE makes the trash dir uncreatable, so the snapshot fails.
    writeFileSync(join(vault, 'ME.md'), handwritten('identity'), 'utf-8')
    writeFileSync(join(vault, '.trash'), 'not a directory', 'utf-8')

    const res = writeIdentityFiles({ notesDir: vault, meMd: ME_MD, brainMd: BRAIN_MD, overwrite: true })

    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/could not be preserved/)
    expect(res.skipped).toContain('ME.md')
    expect(readFileSync(join(vault, 'ME.md'), 'utf-8')).toContain(SENTINEL) // untouched
  })

  it('still no-clobbers with no scaffold, and leaves a greenfield vault untouched-but-written', async () => {
    // Guard the fix against over-correcting: the ordinary paths must keep working.
    mkdirSync(join(vault, 'DUIN', 'Rules'), { recursive: true })
    const res = await scaffoldNewOperatorBrain(vault, { identity: { meMd: ME_MD, brainMd: BRAIN_MD } })
    expect(res.ok).toBe(true)
    expect(res.foundationWritten).toEqual(['BRAIN.md', 'ME.md'])
    expect(readFileSync(join(vault, 'ME.md'), 'utf-8')).toContain('发行负责人')
  })
})
