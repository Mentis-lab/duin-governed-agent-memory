/** Read-shaped compatibility routes that still cause durable or model-backed
 * effects. Main and renderer consume this one policy until those routes become
 * explicit POST commands. */
export const CONTROLLED_GET_PATHS = new Set([
  '/debug/self-improve-bench',
  '/state/futures',
  '/state/predicted-risks'
])

export function isControlledGetPath(path: string): boolean {
  return CONTROLLED_GET_PATHS.has(path)
}
