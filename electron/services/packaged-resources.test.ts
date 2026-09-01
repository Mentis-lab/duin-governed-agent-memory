import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { parseWorkflowScript } from './workflow-meta'

// Packaged-resources parity pin.
//
// Every runtime loader that resolves `process.resourcesPath/<dir>` degrades
// SILENTLY when the dir is absent from the packaged app — workflow-library's
// scanDir returns [], skill/plugin/slash-command loaders bootstrap nothing.
// electron-builder only ships what extraResources names, so a resources/ dir
// with a loader but no yml entry is a break that no unit test of the loader
// can see and no user report describes (features are just "missing").
//
// That is exactly how the 2026-08-14 estate audit's finding A1 happened:
// resources/workflows had been missing from extraResources since the workflow
// library shipped, so EVERY packaged install carried zero built-in workflows.
//
// This test closes the class, not just the instance: every top-level directory
// under resources/ must be referenced by an extraResources `from:` entry
// (directly or via a subpath, e.g. resources/ocr/tessdata). A new resources/
// dir without a yml entry fails here on the first commit, not in the field.
// deploy.cmd's GUARD A4 is the belt-and-braces check on the built artifact.

const ROOT = join(__dirname, '..', '..')

// The six built-ins the workflow palette documents; a rename here should be a
// deliberate act, so the names are pinned, not just counted.
const BUILTIN_WORKFLOWS = [
  'adversarial-verify.js',
  'consolidate-memory.js',
  'judge-panel.js',
  'loop-until-dry.js',
  'm5-smoke.js',
  'multi-modal-sweep.js'
]

describe('electron-builder extraResources parity', () => {
  const yml = readFileSync(join(ROOT, 'electron-builder.yml'), 'utf-8')

  it('every top-level resources/ directory has an extraResources entry', () => {
    const dirs = readdirSync(join(ROOT, 'resources'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
    const missing = dirs.filter(
      (dir) => !new RegExp(`from:\\s*resources/${dir}(/|\\s|$)`, 'm').test(yml)
    )
    expect(missing, `resources/ dirs with no extraResources entry: ${missing.join(', ')}`).toEqual(
      []
    )
  })

  it('ships resources/workflows to <resourcesPath>/workflows (finding A1)', () => {
    // workflow-library.ts resolves process.resourcesPath/workflows — the `to:`
    // name matters as much as the `from:`.
    expect(yml).toMatch(/from:\s*resources\/workflows\s*\n\s*to:\s*workflows/m)
  })
})

describe('bundled node-repl server — packaged ESM resolution (finding ⑤)', () => {
  // server.js is ESM and imports @modelcontextprotocol/sdk. ESM resolves bare
  // specifiers by walking parent node_modules from the importing FILE (NODE_PATH
  // is ignored), so the only packaged location it can run from is one where the
  // app's unpacked node_modules is an ancestor: app.asar.unpacked/mcp. Shipped
  // only under resources/mcp it link-fails with ERR_MODULE_NOT_FOUND — which it
  // silently did in EVERY packaged install until 2026-08-14. deploy.cmd GUARD A5
  // probes actual resolution from the built artifact; these pins keep the yml
  // entry and the dependency that resolution relies on from regressing.
  const yml = readFileSync(join(ROOT, 'electron-builder.yml'), 'utf-8')

  it('ships resources/mcp under app.asar.unpacked so the SDK import can resolve', () => {
    expect(yml).toMatch(/from:\s*resources\/mcp\s*\n\s*to:\s*app\.asar\.unpacked\/mcp/m)
  })

  it('@modelcontextprotocol/sdk is a production dependency (rides in node_modules)', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>
    }
    expect(pkg.dependencies?.['@modelcontextprotocol/sdk']).toBeTruthy()
  })
})

describe('built-in workflow scripts', () => {
  const dir = join(ROOT, 'resources', 'workflows')

  it('all six built-ins are present', () => {
    const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.js'))
    for (const name of BUILTIN_WORKFLOWS) expect(files).toContain(name)
  })

  it.each(BUILTIN_WORKFLOWS)('%s parses (meta name + description)', (name) => {
    const parsed = parseWorkflowScript(readFileSync(join(dir, name), 'utf-8'))
    expect(parsed.meta.name.length).toBeGreaterThan(0)
    expect(parsed.meta.description.length).toBeGreaterThan(0)
  })
})
