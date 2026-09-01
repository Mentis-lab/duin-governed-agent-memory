// The in-process brain's loopback port, in ONE place. Env-overridable (DUIN_BRAIN_PORT) so an
// isolated second instance (QA, benchmarks) can run beside an installed DUIN: the server binds it,
// the bridge's default endpoint uses it, and main tells the renderer to read state from it.
// Everything that used to spell 127.0.0.1:8799 derives from here.
export const DEFAULT_LOCAL_BRAIN_PORT = 8799
export function brainPortFrom(env: NodeJS.ProcessEnv): number {
  const n = Number(env.DUIN_BRAIN_PORT)
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_LOCAL_BRAIN_PORT
}
export const LOCAL_BRAIN_PORT = brainPortFrom(process.env) // signal-lint-ignore: the one declared port literal
export const LOCAL_BRAIN_ORIGIN = `http://127.0.0.1:${LOCAL_BRAIN_PORT}`
