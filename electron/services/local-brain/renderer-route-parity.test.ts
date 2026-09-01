import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'

// Guard against orphaned brain routes: every `/state/...` path the RENDERER
// fetches must have a matching registration in the brain's route chain.
//
// This exists because `/state/graph-diff` 404'd on every graph-shell mount for
// weeks. It was the Python sidecar's `graph.parity_report()`; the sidecar was
// retired in 1ce3c534, no native route replaced it, and the caller's
// `.catch(() => {})` hid the failure from everything except the devtools
// network log. A route the renderer calls but the server does not serve is a
// silent feature outage, so pin it.
//
// Direction is deliberately one-way. Server routes with no renderer caller are
// legitimate (the CLI, plugins/skills, and `curl` all hit them), so an
// unreferenced route is NOT a failure here.

const ROOT = resolve(__dirname, '../../..')
const RENDERER = join(ROOT, 'src')
const ROUTE_FILES = ['brain-native-routes.ts', 'brain-native-routes-2.ts', 'server.ts'].map((f) =>
  join(__dirname, f)
)

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(entry)) out.push(p)
  }
  return out
}

// Strip comments so a prose mention of a removed route (e.g. the tombstone
// comments left where graph-diff used to be) doesn't read as a live call.
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

describe('renderer → brain route parity', () => {
  const routeChain = ROUTE_FILES.map((f) => readFileSync(f, 'utf8')).join('\n')

  const called = new Map<string, Set<string>>()
  for (const file of walk(RENDERER)) {
    if (/\.test\.tsx?$/.test(file)) continue
    for (const m of stripComments(readFileSync(file, 'utf8')).matchAll(
      /\/state\/[a-z0-9-]+(?:\/[a-z0-9-]+)?/g
    )) {
      if (!called.has(m[0])) called.set(m[0], new Set())
      called.get(m[0])!.add(relative(ROOT, file))
    }
  }

  it('finds the renderer route surface (guards against the scan silently going blind)', () => {
    expect(called.size).toBeGreaterThan(50)
  })

  it('serves every /state route the renderer fetches', () => {
    const orphans = [...called.entries()]
      .filter(([route]) => !new RegExp(`['"\`]${route}['"\`]`).test(routeChain))
      .map(([route, files]) => `${route}  ← ${[...files].join(', ')}`)

    expect(orphans).toEqual([])
  })
})
