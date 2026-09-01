import { existsSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'

// D1 — the legacy full-privilege exec-token file.
//
// This file predates the principal store. Whoever can read it holds UNSCOPED exec on the
// brain: no principal, no plane, no scope, no quota, no audit row. Every bound the Brain
// API enforces is advisory against any local process that can open it.
//
// It lives here, as a function, rather than inline in server.ts for one reason: server.ts
// pulls electron at module load and cannot be imported by a test, so the only way to check
// the inline version was to assert on its SOURCE TEXT — including one assertion that matched
// a COMMENT. That test would have passed with the gate deleted and failed on a reworded
// remark. A decision this security-relevant should be checkable by running it.

export type ExecTokenFileOutcome =
  | 'written' // the flag is on: the bypass is ACTIVE
  | 'removed' // the flag is off and a previous launch had left a token readable
  | 'absent' // the flag is off and there was nothing to clean up
  | 'failed' // best-effort I/O did not succeed; never throws into startup

/**
 * Reconcile the exec-token file with the launch environment.
 *
 * Opt-in by design: default OFF closes the bypass for every install that does not need it,
 * including every fresh download. The one machine that does need it — the operator's, whose
 * out-of-repo Feishu bridge reads this file to act on their behalf — sets
 * DUIN_EXEC_TOKEN_FILE=1 in the launch env (BOTH definitions: deploy.cmd and
 * ~/.duin/duin-launch.bat).
 *
 * Deleting the write outright was the other option and was rejected: it would break a live
 * bridge with no warning, which is an outage, not a security fix. The migration that retires
 * this for good is a `bridge`-kind principal with explicit planes — see
 * PLANNING/DUIN_BRAIN_API_NATIVE_MEMORY_SPEC.md section D1.
 *
 * Turning the flag OFF must actually revoke, so the off-path unlinks a file a previous
 * launch left behind. Without that, "off" would only mean "not refreshed" and a stale token
 * would sit on disk indefinitely, still valid, while the operator believed the door shut.
 */
export function syncExecTokenFile(
  userDataDir: string,
  token: string,
  env: NodeJS.ProcessEnv = process.env
): ExecTokenFileOutcome {
  const path = join(userDataDir, 'exec-token')
  if (env.DUIN_EXEC_TOKEN_FILE === '1') {
    try {
      // 0600: the bypass is at least not world-readable where the platform honours modes.
      writeFileSync(path, token, { mode: 0o600 })
      return 'written'
    } catch {
      return 'failed'
    }
  }
  try {
    if (!existsSync(path)) return 'absent'
    unlinkSync(path)
    return 'removed'
  } catch {
    return 'failed'
  }
}
