import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// Source-lock (LP-9 / era-chrome pattern): the ToolApprovalModal must NOT
// self-resolve on a timer. The renderer environment is node-only (no jsdom),
// so the component cannot be mounted to drive fake timers; a source-lock is
// the established way this repo pins "stays wired / stays unwired" facts.
//
// Regression guarded: the modal used to fire respond('deny','once') after a
// 30s countdown. That defeated the main process's askUser (permissions-store),
// which DELIBERATELY has no timeout — a pending approval stays pending until
// the user answers or cancelPending/abort resolves it. The renderer timer
// silently refused tool calls when the user stepped away (the exact behaviour
// the main process removed) and logged a machine timeout as a human deny.

const root = join(__dirname, '..', '..', '..')
const read = (p: string): string => readFileSync(join(root, p), 'utf-8')

describe('ToolApprovalModal has no auto-deny timer', () => {
  const src = read('src/components/tools/ToolApprovalModal.tsx')

  it('does not define a hardcoded timeout constant', () => {
    expect(src).not.toMatch(/TIMEOUT_SECONDS/)
  })

  it('does not run a countdown that auto-resolves the modal', () => {
    expect(src).not.toMatch(/setCountdown/)
    expect(src).not.toMatch(/Auto-deny in/)
  })

  it('never issues a machine-driven deny (deny only comes from the button)', () => {
    // The only respond('deny', ...) call is the user-clicked button handler,
    // which uses the selected `scope` — not a timer firing ('deny', 'once').
    expect(src).not.toMatch(/respond\(\s*['"]deny['"]\s*,\s*['"]once['"]\s*\)/)
    // Positive lock: the Deny button still exists and answers with the chosen
    // scope, so this guard cannot be satisfied by removing deny entirely.
    expect(src).toMatch(/onClick=\{\(\)\s*=>\s*respond\(\s*['"]deny['"]\s*,\s*scope\s*\)\}/)
  })
})
