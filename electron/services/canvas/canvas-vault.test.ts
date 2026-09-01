import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { CANVAS_SUBDIR, listCanvasesIn, readCanvasIn, saveCanvasToVaultIn } from './canvas-vault'

let vault = ''
const CANVAS = JSON.stringify({
  nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 200, height: 80, text: 'hi' }],
  edges: []
})

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'canvas-vault-test-'))
})
afterEach(() => {
  try {
    rmSync(vault, { recursive: true, force: true })
  } catch {
    /* windows may hold a handle briefly */
  }
})

describe('saveCanvasToVaultIn', () => {
  it('writes into the Canvases folder and returns a vault-relative path', () => {
    const r = saveCanvasToVaultIn(vault, 'My Blueprint', CANVAS)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // sanitizeTitle is the house naming rule (shared with saved HTML artifacts);
    // it underscores spaces. Asserting its actual behaviour rather than a
    // prettier one keeps canvas names consistent with every other saved file.
    expect(r.rel).toBe(`${CANVAS_SUBDIR}/My_Blueprint.canvas`)
    expect(readFileSync(r.path, 'utf-8')).toBe(CANVAS)
  })

  it('creates the folder on first save', () => {
    expect(existsSync(join(vault, CANVAS_SUBDIR))).toBe(false)
    saveCanvasToVaultIn(vault, 'x', CANVAS)
    expect(existsSync(join(vault, CANVAS_SUBDIR))).toBe(true)
  })

  it('REFUSES to write content that is not a canvas', () => {
    const r = saveCanvasToVaultIn(vault, 'bad', 'not json')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/Not a valid canvas/)
    expect(existsSync(join(vault, CANVAS_SUBDIR, 'bad.canvas'))).toBe(false)
  })

  it('refuses when no vault is configured', () => {
    const r = saveCanvasToVaultIn('', 'x', CANVAS)
    expect(r.ok).toBe(false)
  })

  it('cannot be walked out of the vault by a traversing name', () => {
    const r = saveCanvasToVaultIn(vault, '../../escape', CANVAS)
    // sanitizeTitle strips separators, so this lands inside the folder rather
    // than escaping — assert on where the bytes actually went.
    if (r.ok) {
      expect(r.path.startsWith(vault)).toBe(true)
    } else {
      expect(r.error).toBeTruthy()
    }
    expect(existsSync(join(vault, '..', 'escape.canvas'))).toBe(false)
  })

  it('overwrites the same name on a repeat save (that is what Save means)', () => {
    saveCanvasToVaultIn(vault, 'same', CANVAS)
    const next = JSON.stringify({ nodes: [], edges: [] })
    const r = saveCanvasToVaultIn(vault, 'same', next)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(readFileSync(r.path, 'utf-8')).toBe(next)
  })
})

describe('listCanvasesIn', () => {
  it('finds canvases at several depths and sorts them', () => {
    mkdirSync(join(vault, 'a', 'b'), { recursive: true })
    writeFileSync(join(vault, 'top.canvas'), CANVAS)
    writeFileSync(join(vault, 'a', 'mid.canvas'), CANVAS)
    writeFileSync(join(vault, 'a', 'b', 'deep.canvas'), CANVAS)
    writeFileSync(join(vault, 'a', 'note.md'), '# not a canvas')
    const found = listCanvasesIn(vault)
    expect(found.map((f) => f.rel)).toEqual(['a/b/deep.canvas', 'a/mid.canvas', 'top.canvas'])
    expect(found[2].name).toBe('top')
  })

  it('skips dot-dirs and node_modules', () => {
    mkdirSync(join(vault, '.obsidian'), { recursive: true })
    mkdirSync(join(vault, 'node_modules'), { recursive: true })
    writeFileSync(join(vault, '.obsidian', 'x.canvas'), CANVAS)
    writeFileSync(join(vault, 'node_modules', 'y.canvas'), CANVAS)
    expect(listCanvasesIn(vault)).toEqual([])
  })

  it('returns empty for a missing vault instead of throwing', () => {
    expect(listCanvasesIn(join(vault, 'nope'))).toEqual([])
  })
})

describe('readCanvasIn', () => {
  it('reads a canvas by relative path', () => {
    writeFileSync(join(vault, 'top.canvas'), CANVAS)
    expect(readCanvasIn(vault, 'top.canvas')).toBe(CANVAS)
  })

  it('refuses a non-canvas extension — no arbitrary file reads', () => {
    writeFileSync(join(vault, 'secret.md'), 'private')
    expect(readCanvasIn(vault, 'secret.md')).toBeNull()
  })

  it('refuses a path that escapes the vault', () => {
    expect(readCanvasIn(vault, '../../../windows/system32/x.canvas')).toBeNull()
  })

  it('returns null for a missing file', () => {
    expect(readCanvasIn(vault, 'nope.canvas')).toBeNull()
  })
})
