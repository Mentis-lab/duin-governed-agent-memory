// hooks-seed.ts — first-run default hooks for the native hook engine.
//
// The hook ENGINE (hooks-runner.ts) fires sessionStart / pre|postToolUse /
// agentStop / lifecycle events, but a fresh install has ZERO hook rows, so the
// engine runs into the void (the "events fire, rows unbound" gap). This seeds a
// small, sandbox-faithful default set so the engine does something useful out of
// the box and a new user has a working example to clone.
//
// SANDBOX REALITY (see hooks-runner.ts): a JS hook body runs in a frozen `vm`
// with only `log()/console.log`, `Date/JSON/Math`, and the read-only event
// bindings (event/toolName/args/result/promptBody/cwd). It has NO fs/network and
// CANNOT call the brain. So the defaults are the three things the sandbox can
// honestly do — audit (log), GUARD (throw in preToolUse blocks the call), and
// inspect. operator-style biz-eval / cn-residue hooks need vault+model access and stay
// in the python hook layer (.duin/hooks/*.py), fired by the loop runner — they
// are deliberately NOT reimplemented here as no-op JS.
//
// Idempotent: seeds only once. Guarded by a settings flag AND an empty-table
// check, so it never duplicates and never resurrects hooks the user deleted.

import { createHook, listHooks } from './hooks-store'
import { readSettings, patchSettings } from './settings-helper'

const SEEDED_FLAG = 'defaultHooksSeeded'

interface SeedHook {
  event: Parameters<typeof createHook>[0]['event']
  label: string
  command: string
}

// Kept inline (not external files) so the seed is self-contained and survives
// packaging. Each body is strict-mode JS run inside the hook `vm` sandbox.
const DEFAULT_HOOKS: SeedHook[] = [
  {
    event: 'sessionStart',
    label: 'Session start audit',
    // Liveness + audit trail: proves the engine fires and timestamps the session.
    command: `log('DUIN session started — ' + new Date().toISOString());`
  },
  {
    event: 'preToolUse',
    label: 'Destructive-command guard',
    // The one default that DOES something: throwing in preToolUse BLOCKS the tool
    // call. Matches unmistakably destructive shell patterns across win/posix. Kept
    // deliberately narrow (only catastrophic, non-recoverable commands) to avoid
    // false positives on normal agent work.
    command: [
      `var a = args || {};`,
      `var cmd = String(a.command || a.cmd || a.script || a.input || '');`,
      // Matches `rm -rf` / `-fr` ONLY when the target is root, home, bare cwd,
      // or a glob (terminated by whitespace/end) — so scoped paths like
      // `rm -rf ./dist/tmp` pass through. Plus del /f /q, format, mkfs, raw-disk
      // writes, rd /s /q, and the classic fork bomb.
      `var DANGER = /\\brm\\s+-(?:rf|fr)\\s+(?:\\/\\*?|~\\/?\\*?|\\.|\\*)(?:\\s|$)|\\bdel\\s+\\/[a-z]\\s+\\/[a-z]|\\bformat\\s+[a-z]:|\\bmkfs\\b|>\\s*\\/dev\\/(sd|hd|nvme|disk)|\\brd\\s+\\/s\\s+\\/q\\b|:\\(\\)\\s*\\{\\s*:\\s*\\|\\s*:/i;`,
      `if (cmd && DANGER.test(cmd)) {`,
      `  throw 'DUIN safety hook blocked a destructive command: ' + cmd.slice(0, 120);`,
      `}`
    ].join('\n')
  },
  {
    event: 'postToolUse',
    label: 'Tool audit trail',
    // Activity trail: which tool ran and how large its result was.
    command: [
      `var n = (typeof result === 'string') ? result.length : 0;`,
      `log((toolName || 'tool') + ' completed — ' + n + ' bytes');`
    ].join('\n')
  }
]

export interface SeedResult {
  seeded: number
  skipped?: 'flag' | 'non-empty'
}

/**
 * Seed the default hooks exactly once. Safe to call on every startup.
 * - If the flag is already set → no-op.
 * - If hooks already exist (an upgraded install or a user who added their own) →
 *   set the flag without seeding, so we never duplicate or override their setup.
 * - Otherwise → insert DEFAULT_HOOKS and set the flag.
 */
export function seedDefaultHooks(): SeedResult {
  if (readSettings()[SEEDED_FLAG] === true) return { seeded: 0, skipped: 'flag' }

  if (listHooks().length > 0) {
    patchSettings({ [SEEDED_FLAG]: true })
    return { seeded: 0, skipped: 'non-empty' }
  }

  let seeded = 0
  for (const h of DEFAULT_HOOKS) {
    createHook({ event: h.event, label: h.label, command: h.command, language: 'js' })
    seeded += 1
  }
  patchSettings({ [SEEDED_FLAG]: true })
  return { seeded }
}
