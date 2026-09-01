import { describe, it, expect, beforeAll } from 'vitest'
import { ESLint } from 'eslint'

// U2 — the eslint half. src/duin/lib/brain-client.ts:13 has cited an eslint guard
// named `no-cross-brain-write` since it was written, and the ONLY occurrence of
// that name anywhere in the repository was that comment: the codebase believed it
// had a discipline it did not have. Both rules now exist, and this pins them so
// the same thing cannot happen again.
//
// Linting TEXT (not a file) keeps the fixtures out of the tree, and the filePath
// is chosen to be OUTSIDE the grandfather list so the ratchet is what gets tested.

let eslint: ESLint
const NEW_FILE = 'src/components/__guard-fixture.tsx'

beforeAll(() => {
  eslint = new ESLint({ cwd: process.cwd() })
})

async function ruleIdsFor(code: string, filePath = NEW_FILE): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath })
  return result.messages.map((m) => `${m.ruleId}:${m.message.split(':')[0]}`)
}

describe('no-raw-ipc-write', () => {
  it('rejects a raw awaited window.api mutation in new code', async () => {
    const ids = await ruleIdsFor(
      'export async function f() { await window.api.settings.set({ theme: "dark" }) }'
    )
    expect(ids).toContain('no-restricted-syntax:no-raw-ipc-write')
  })

  it('rejects the fire-and-forget shapes too', async () => {
    // `void window.api.tasks.stop(id)` is how Stop-on-a-runaway-agent was written.
    const voided = await ruleIdsFor('export function f(id: string) { void window.api.tasks.stop(id) }')
    expect(voided).toContain('no-restricted-syntax:no-raw-ipc-write')
    const bare = await ruleIdsFor('export function f(id: string) { window.api.tasks.stop(id) }')
    expect(bare).toContain('no-restricted-syntax:no-raw-ipc-write')
  })

  it('ACCEPTS the same call routed through invoke()', async () => {
    const ids = await ruleIdsFor(
      "import { invoke } from '@/lib/ipc-client'\n" +
        'export async function f() { await invoke("save", () => window.api.settings.set({})) }'
    )
    expect(ids).not.toContain('no-restricted-syntax:no-raw-ipc-write')
  })

  it('leaves READS alone — only mutating verbs are restricted', async () => {
    const ids = await ruleIdsFor('export async function f() { await window.api.tasks.list({}) }')
    expect(ids).not.toContain('no-restricted-syntax:no-raw-ipc-write')
  })

  it('exempts ipc-client itself — it is what everyone is redirected to', async () => {
    const ids = await ruleIdsFor(
      'export async function f() { await window.api.settings.set({}) }',
      'src/lib/ipc-client.ts'
    )
    expect(ids).not.toContain('no-restricted-syntax:no-raw-ipc-write')
  })
})

describe('no-cross-brain-write', () => {
  it('rejects a raw fetch to a TS-brain-OWNED /state/* route', async () => {
    const ids = await ruleIdsFor(
      'export function f() { return fetch(`http://x/state/insight-verdict`, { method: "POST" }) }'
    )
    expect(ids).toContain('no-restricted-syntax:no-cross-brain-write')
  })

  it('rejects the string-literal form as well', async () => {
    const ids = await ruleIdsFor(
      'export function f() { return fetch("http://x/state/verdict", { method: "POST" }) }'
    )
    expect(ids).toContain('no-restricted-syntax:no-cross-brain-write')
  })

  it('leaves NON-owned /state/* routes alone — most of them are legitimately vault-IO', async () => {
    const ids = await ruleIdsFor('export function f() { return fetch("http://x/state/tasks") }')
    expect(ids).not.toContain('no-restricted-syntax:no-cross-brain-write')
  })
})
