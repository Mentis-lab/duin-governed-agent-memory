import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// The Python brain sidecar was retired in 1ce3c534 — the brain is in-process TS
// on :8799. `resources/brain/` was deleted, but the BUILD AND DEPLOY paths kept
// referencing it for months without anyone noticing, because every reference
// was failure-silenced:
//
//   - deploy.cmd force-copied `%REPO%\resources\brain\duin-brain.exe` twice,
//     each line ending in `>nul 2>&1`;
//   - build.yml / build-mac.yml ran `cd resources/brain && pyinstaller server.py`
//     under `continue-on-error: true`.
//
// A silenced reference to a path that cannot exist is worse than none: it reads
// as a safeguard while doing nothing. Pin the cleanup so it cannot creep back.

const ROOT = resolve(__dirname, '../..')

// deploy.cmd is checked separately: it is the ONE file allowed to name the path,
// because it is what deletes the orphaned directory from existing installs. It is
// owner tooling and does not ship in the public tree, so its block skips when absent.
const BUILD_PATH_FILES = [
  '.github/workflows/build.yml',
  '.github/workflows/ci.yml',
  'electron-builder.yml',
  'package.json'
]
const DEPLOY_CMD = join(ROOT, 'deploy.cmd')

// Comments explaining WHY the sidecar is gone are the point of the cleanup, so
// they must not trip this. Only executable references count.
const stripComments = (file: string, src: string): string => {
  if (file.endsWith('.cmd')) {
    return src
      .split(/\r?\n/)
      .filter((l) => !/^\s*(rem\b|::)/i.test(l))
      .join('\n')
  }
  if (file.endsWith('.yml')) {
    return src
      .split(/\r?\n/)
      .filter((l) => !/^\s*#/.test(l))
      .join('\n')
  }
  return src
}

describe('retired Python sidecar leaves no live references', () => {
  it('confirms resources/brain/ really is gone (else this suite proves nothing)', () => {
    expect(existsSync(join(ROOT, 'resources', 'brain'))).toBe(false)
  })

  it('the sidecar parity diff-tool stays deleted', () => {
    // parity.ts (repo root, removed 2026-08-21) existed to diff native routes
    // against `./duin-brain.exe` — a binary this very suite asserts cannot
    // exist. Its own header named its expiry condition ("once Python is
    // deleted there's no sidecar to diff against"), yet it survived a year
    // past it because BUILD_PATH_FILES never scanned repo-root .ts files.
    expect(existsSync(join(ROOT, 'parity.ts'))).toBe(false)
  })

  it('the Lamprey-era Bucket pipeline stays retired (backlog C5)', () => {
    // scripts/bucket.ps1 shipped a product named Lamprey to an R2 bucket.
    // deploy.cmd is the one supported deploy path (CLAUDE.md), yet the live
    // system prompt carried a "run bucket.ps1" instruction until 2026-08-21 —
    // the harness simultaneously instructing and forbidding the same act.
    // C5's default (retire, do not derive) is executed; pin it here.
    expect(existsSync(join(ROOT, 'scripts', 'bucket.ps1'))).toBe(false)
    expect(existsSync(join(ROOT, 'scripts', 'bucket-setup.ps1'))).toBe(false)
    expect(existsSync(join(ROOT, 'scripts', 'bucket-artifact-names.test.mjs'))).toBe(false)
  })

  it.each(BUILD_PATH_FILES)('%s has no executable reference to the sidecar', (file) => {
    const path = join(ROOT, file)
    expect(existsSync(path), `${file} is missing`).toBe(true)
    const code = stripComments(file, readFileSync(path, 'utf8'))

    expect(code).not.toMatch(/duin-brain/)
    expect(code).not.toMatch(/resources[\\/]brain/)
  })

  describe.skipIf(!existsSync(DEPLOY_CMD))('deploy.cmd', () => {
    const deploy = (): string => stripComments('deploy.cmd', readFileSync(DEPLOY_CMD, 'utf8'))

    it('removes the orphaned dir from the install target', () => {
      // robocopy /MIR never owned resources\brain — the old force-copy wrote it,
      // not the build — so ~22 MB of dead python survives in existing installs
      // unless the deploy explicitly deletes it.
      expect(deploy()).toMatch(/rd \/s \/q "%DEST%\\resources\\brain"/)
    })

    it('never copies or kills the retired engine', () => {
      // The two failure modes being pinned: a `copy /Y ...duin-brain.exe` whose
      // source cannot exist, and a `taskkill /IM duin-brain.exe` for a process
      // nothing spawns — both previously silenced with `>nul 2>&1`.
      const text = deploy()
      expect(text).not.toMatch(/duin-brain/)
      // The ONLY live mentions of the path belong to the removal block: the
      // `if exist` guards, the `rd /s /q` deletes, and the warning it echoes
      // when the delete is blocked.
      const mentions = text.split(/\r?\n/).filter((l) => /resources\\brain/.test(l))
      expect(mentions.length).toBeGreaterThan(0)
      expect(mentions.filter((l) => !/rd \/s \/q|if exist|echo/.test(l))).toEqual([])
    })
  })
})
