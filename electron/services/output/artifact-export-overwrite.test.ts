// Backlog finding 10 (critical). export_artifact / generate_{pdf,docx,xlsx,pptx} write a
// caller-supplied ABSOLUTE path with no existence check, so "save this to my Desktop as
// notes.docx" silently and permanently replaced whatever was already there — no
// confirmation, no backup, on every chat surface, from a path the model chose.
//
// Real files in a real temp dir: the whole defect is a filesystem side effect, so a
// mocked fs would prove nothing about it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('../artifact-sandbox', () => ({ buildHtmlDoc: (_k: string, html: string) => `<html>${html}</html>` }))

import { exportArtifactHtml } from './artifact-export'

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'duin-export-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('exportArtifactHtml — will not clobber an existing file', () => {
  it('writes when nothing is in the way', async () => {
    const out = join(dir, 'report.html')
    const r = await exportArtifactHtml('<p>hi</p>', out)
    expect(r.ok).toBe(true)
    expect(existsSync(out)).toBe(true)
  })

  it('REFUSES to overwrite, and leaves the original bytes untouched', async () => {
    const out = join(dir, 'notes.html')
    writeFileSync(out, 'THE USER FILE', 'utf-8')

    const r = await exportArtifactHtml('<p>replacement</p>', out)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toMatch(/already exists/)
    // The point of the whole fix: the file the user had is still there, byte for byte.
    expect(readFileSync(out, 'utf-8')).toBe('THE USER FILE')
  })

  it('refuses after extension normalisation, not before it', async () => {
    // resolveExportPath SWAPS a .pdf extension for .html, so the collision has to be
    // checked against the path actually written, not the one the caller typed. (An
    // unrelated extension like .txt is appended to, giving notes.txt.html — a different
    // file, correctly not a collision.)
    const real = join(dir, 'notes.html')
    writeFileSync(real, 'THE USER FILE', 'utf-8')
    const r = await exportArtifactHtml('<p>x</p>', join(dir, 'notes.pdf'))
    expect(r.ok).toBe(false)
    expect(readFileSync(real, 'utf-8')).toBe('THE USER FILE')
  })

  it('the refusal is a normal result, not a thrown exception', async () => {
    const out = join(dir, 'a.html')
    writeFileSync(out, 'x', 'utf-8')
    await expect(exportArtifactHtml('<p>y</p>', out)).resolves.toMatchObject({ ok: false })
  })
})
