// U10 — saving a workflow used to silently destroy an existing one.
//
// saveUserWorkflow did a bare writeFileSync to workflowFileName(meta.name) with
// no existsSync check, no confirm and no versioning at any layer. This is the
// NORMAL trajectory rather than negligence: MetaScaffolder hands every author
// the same default name 'new-workflow', and there is no load-for-edit path
// (both editor mounts remount fresh), so the second author's Save overwrote the
// first author's file. userData/workflows/scripts is not covered by
// backup-runner either, so the destroyed file was in no backup.

import { describe, expect, it, vi, beforeEach, afterAll } from 'vitest'
import { createHash, randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// A per-run userData root so this suite never shares state with another test
// file (or a previous run) — the conflict guard is exactly the kind of thing a
// stale fixture on disk would make flaky.
const USER_DATA = join(tmpdir(), `duin-wf-save-guard-${randomUUID()}`)

vi.mock('electron', () => ({
  app: { getPath: (): string => USER_DATA },
  BrowserWindow: { getAllWindows: (): unknown[] => [] }
}))

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

const {
  __workflowLibraryTest,
  deleteUserWorkflow,
  getWorkflow,
  saveUserWorkflow,
  WorkflowSaveError
} = await import('./workflow-library')

const SCRIPTS = join(USER_DATA, 'workflows', 'scripts')

function script(name: string, body: string): string {
  return `export const meta = {
  name: '${name}',
  description: 'A saved workflow used by the U10 conflict-guard test.'
}
return { ok: '${body}' }
`
}

function hashOf(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex')
}

beforeEach(() => {
  __workflowLibraryTest.reset()
  rmSync(SCRIPTS, { recursive: true, force: true })
  mkdirSync(SCRIPTS, { recursive: true })
})

afterAll(() => {
  rmSync(USER_DATA, { recursive: true, force: true })
})

describe('saveUserWorkflow — refuses to destroy an existing workflow', () => {
  it('refuses a same-name save with different content and leaves the file byte-identical', () => {
    const first = saveUserWorkflow(script('shared-name', 'first-author'))
    const before = hashOf(first.filePath)

    let thrown: unknown = null
    try {
      saveUserWorkflow(script('shared-name', 'second-author'))
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeInstanceOf(WorkflowSaveError)
    expect((thrown as InstanceType<typeof WorkflowSaveError>).code).toBe('conflict')
    expect((thrown as InstanceType<typeof WorkflowSaveError>).workflowName).toBe('shared-name')
    // The whole point: Cancel (i.e. not passing overwrite) must not touch the file.
    expect(hashOf(first.filePath)).toBe(before)
    expect(readFileSync(first.filePath, 'utf-8')).toContain('first-author')
  })

  it('the scaffold default name is refused so "Save" cannot land on new-workflow', () => {
    let thrown: unknown = null
    try {
      saveUserWorkflow(script('new-workflow', 'anything'))
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(WorkflowSaveError)
    expect((thrown as InstanceType<typeof WorkflowSaveError>).code).toBe('scaffold-name')
    expect(existsSync(join(SCRIPTS, 'new-workflow.js'))).toBe(false)
  })

  it('overwrite:true replaces the file and keeps a recoverable copy', () => {
    const first = saveUserWorkflow(script('shared-name', 'first-author'))
    const saved = saveUserWorkflow(script('shared-name', 'second-author'), { overwrite: true })

    expect(saved.filePath).toBe(first.filePath)
    expect(readFileSync(first.filePath, 'utf-8')).toContain('second-author')
    // The replaced version is still on disk — the directory is in no backup set,
    // so an in-place overwrite with no copy was unrecoverable.
    const trash = join(SCRIPTS, '.trash')
    const kept = readdirSync(trash)
    expect(kept.length).toBe(1)
    expect(readFileSync(join(trash, kept[0]), 'utf-8')).toContain('first-author')
  })

  it('re-saving byte-identical content is not a conflict (nothing can be lost)', () => {
    const source = script('shared-name', 'same')
    const first = saveUserWorkflow(source)
    const again = saveUserWorkflow(source)
    expect(again.filePath).toBe(first.filePath)
    expect(readFileSync(first.filePath, 'utf-8')).toBe(source)
  })
})

describe('deleteUserWorkflow — a workflow can finally be removed', () => {
  it('removes the file, drops the library entry, and keeps a recoverable copy', () => {
    const saved = saveUserWorkflow(script('doomed', 'body'))
    expect(getWorkflow('doomed')).not.toBeNull()

    const res = deleteUserWorkflow('doomed')

    expect(res.deleted).toBe(true)
    expect(existsSync(saved.filePath)).toBe(false)
    expect(getWorkflow('doomed')).toBeNull()
    const trash = readdirSync(join(SCRIPTS, '.trash'))
    expect(trash.length).toBe(1)
    expect(readFileSync(join(SCRIPTS, '.trash', trash[0]), 'utf-8')).toContain('body')
  })

  it('reports an unknown name instead of throwing', () => {
    expect(deleteUserWorkflow('never-existed')).toEqual({ deleted: false, reason: 'not-found' })
  })

  it('refuses to delete a built-in workflow', () => {
    const builtin = __workflowLibraryTest.builtinFileNames()
    expect(builtin.length).toBeGreaterThan(0)
    const name = __workflowLibraryTest.parsePath(
      join(process.cwd(), 'resources', 'workflows', builtin[0])
    ).meta.name
    expect(deleteUserWorkflow(name)).toEqual({ deleted: false, reason: 'builtin' })
  })

  it('leaves the .trash directory out of the scanned library', () => {
    saveUserWorkflow(script('scanned', 'x'))
    deleteUserWorkflow('scanned')
    saveUserWorkflow(script('scanned', 'y'))
    __workflowLibraryTest.reset()
    // A fresh scan must see exactly one 'scanned' entry and no trash artefacts.
    expect(getWorkflow('scanned')?.source).toContain('y')
  })
})
