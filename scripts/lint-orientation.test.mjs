// lint-orientation.test.mjs — proves scripts/lint-orientation.mjs fails on a
// CLAUDE.md that lies about itself, and passes on one that does not.
//
// Run: npm run test:teeth   (node --test "scripts/*.test.mjs")

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { countProviders } from './lint-orientation.mjs'

const SCRIPT = fileURLToPath(new URL('./lint-orientation.mjs', import.meta.url))

let root

const REGISTRY = `
export type ProviderId =
  | 'deepseek'
  | 'google'
  | 'ghost-union-member-that-is-not-a-table-key'

export const PROVIDERS: Record<ProviderId, ProviderDescriptor> = {
  deepseek: { id: 'deepseek', label: 'DeepSeek', baseURL: 'https://x/v1' },
  google: { id: 'google', label: 'Google', baseURL: 'https://y/v1' },
  'github-models': { id: 'github-models', label: 'GitHub', baseURL: 'https://z/v1' }
}
`

function run(doc, { rootDir = root } = {}) {
  writeFileSync(join(rootDir, 'CLAUDE.md'), doc)
  const r = spawnSync(process.execPath, [SCRIPT, '--root', rootDir], { encoding: 'utf8' })
  return { status: r.status, out: String(r.stdout || '') + String(r.stderr || '') }
}

// A doc that is true about the fixture: 3 providers, names the registry, quotes
// the real pins, cites only files that exist.
const TRUTHFUL = [
  '# DUIN',
  '',
  '- Provider registry + dispatch: `electron/services/providers/registry.ts`. Routes to three providers.',
  '- Electron is pinned to ^43.2.0 because better-sqlite3 13.0 needs the N-API build.',
  '- See `PLANNING/REAL_PLAN.md` and `ARCHITECTURE/REAL_ARCH.md`.',
  ''
].join('\n')

describe('lint-orientation', () => {
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'orientation-'))
    mkdirSync(join(root, 'electron/services/providers'), { recursive: true })
    mkdirSync(join(root, 'PLANNING'), { recursive: true })
    mkdirSync(join(root, 'ARCHITECTURE'), { recursive: true })
    writeFileSync(join(root, 'electron/services/providers/registry.ts'), REGISTRY)
    writeFileSync(join(root, 'PLANNING/REAL_PLAN.md'), '# real\n')
    writeFileSync(join(root, 'ARCHITECTURE/REAL_ARCH.md'), '# real\n')
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ dependencies: { 'better-sqlite3': '^13.0.1' }, devDependencies: { electron: '^43.2.0' } })
    )
  })

  after(() => {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      /* disposable */
    }
  })

  test('PASSES on a CLAUDE.md that is true about itself', () => {
    const { status, out } = run(TRUTHFUL)
    assert.equal(status, 0, out)
    assert.match(out, /RESULT: PASS/)
  })

  test('FAILS (R1) on a fake citation, naming the path — the acceptance case', () => {
    const { status, out } = run(TRUTHFUL + '\n- See `PLANNING/NOPE.md` for details.\n')
    assert.equal(status, 1, out)
    assert.match(out, /✗ R1 .*PLANNING\/NOPE\.md.*does not exist on disk/)
  })

  test('R1 has no historical escape — a dead link is wrong in either tense', () => {
    const { status, out } = run(TRUTHFUL + '\n- `PLANNING/NOPE.md` <!-- orientation-lint: historical -->\n')
    assert.equal(status, 1, out)
    assert.match(out, /PLANNING\/NOPE\.md/)
  })

  test('FAILS (R2) when the provider count disagrees with the PROVIDERS table', () => {
    const { status, out } = run(TRUTHFUL.replace('three providers', 'nine providers'))
    assert.equal(status, 1, out)
    assert.match(out, /✗ R2 .*claims "nine providers" but .* declares 3/)
  })

  test('R2 accepts a dated line marked historical', () => {
    const { status, out } = run(TRUTHFUL + '\n- FC-0 audit: all 4 providers were OpenAI-compatible. <!-- orientation-lint: historical -->\n')
    assert.equal(status, 0, out)
  })

  test('R2 does not read prompt ids like `FC-3 provider` as a count', () => {
    const { status, out } = run(TRUTHFUL + '\n- FC-3 provider schema normalizer; FC-0 provider capability audit.\n')
    assert.equal(status, 0, out)
  })

  test('FAILS (R2) when the doc names no source of truth for the count', () => {
    const { status, out } = run('# DUIN\n\nRoutes to three providers.\n')
    assert.equal(status, 1, out)
    assert.match(out, /does not name the provider source of truth/)
  })

  test('PASSES when there is no CLAUDE.md at all (public tree)', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--root', root, '--doc', join(root, 'NOT-THERE.md')], {
      encoding: 'utf8'
    })
    assert.equal(r.status, 0, String(r.stdout) + String(r.stderr))
    assert.match(String(r.stdout), /PASS — .*not present/)
  })

  test('FAILS (R3) when a quoted pin drifts from package.json', () => {
    const { status, out } = run(TRUTHFUL.replace('^43.2.0', '^35.7.5'))
    assert.equal(status, 1, out)
    assert.match(out, /✗ R3 .*quotes electron pin `\^35\.7\.5` but package\.json declares `\^43\.2\.0`/)
  })

  test('FAILS (R3) on a bare major mismatch, and TOLERATES a patch difference', () => {
    const bad = run(TRUTHFUL.replace('better-sqlite3 13.0', 'better-sqlite3 12.10'))
    assert.equal(bad.status, 1, bad.out)
    assert.match(bad.out, /✗ R3 .*better-sqlite3 12\.10 \(major 12\)/)

    // Same major, different patch — deliberately NOT a failure. A gate that goes
    // red on a routine bump gets deleted, and then it guards nothing.
    const ok = run(TRUTHFUL.replace('better-sqlite3 13.0', 'better-sqlite3 13.4'))
    assert.equal(ok.status, 0, ok.out)
  })

  test('countProviders counts table keys, not ProviderId union members', () => {
    const parsed = countProviders(REGISTRY)
    assert.equal(parsed.ok, true)
    assert.deepEqual(parsed.keys, ['deepseek', 'github-models', 'google'])
    // The union declares a member the table does not; counting the union would
    // have returned 3 by coincidence here and the WRONG number on the real file,
    // where the union carries prose naming 'anthropic'.
    assert.equal(parsed.count, 3)
  })

  test('countProviders reports honestly when the declaration is gone', () => {
    assert.equal(countProviders('export const OTHER = {}').ok, false)
  })
})
