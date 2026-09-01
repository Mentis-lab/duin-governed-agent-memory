export type BootstrapState =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'degraded'; message: string }

function withTimeout(task: (signal: AbortSignal) => Promise<unknown>, timeoutMs: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const controller = new AbortController()
  return Promise.race([
    Promise.resolve().then(() => task(controller.signal)),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error('Startup timed out'))
      }, timeoutMs)
    })
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

export async function settleBootstrap(
  tasks: Array<(signal: AbortSignal) => Promise<unknown>>,
  timeoutMs = 10_000
): Promise<BootstrapState> {
  const results = await Promise.allSettled(tasks.map((task) => withTimeout(task, timeoutMs)))
  const failed = results.filter(
    (result) => result.status === 'rejected' || result.value === false
  ).length
  if (failed === 0) return { status: 'ready' }
  return {
    status: 'degraded',
    message: failed === 1
      ? 'One part of your local workspace could not be loaded.'
      : `${failed} parts of your local workspace could not be loaded.`
  }
}
