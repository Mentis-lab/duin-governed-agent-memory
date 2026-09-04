/** Read-shaped compatibility routes that still cause durable or model-backed
 * effects. Main and renderer consume this one policy until those routes become
 * explicit POST commands. */
export const CONTROLLED_GET_PATHS = new Set([
  '/debug/self-improve-bench',
  '/state/futures',
  '/state/predicted-risks',
  // Not effectful, but they expose the main-process log and the spend ledger — more than a
  // status probe should hand to any local process. Same admission as the bench route.
  '/debug/log-tail',
  '/debug/cost'
])

export function isControlledGetPath(path: string): boolean {
  return CONTROLLED_GET_PATHS.has(path)
}
