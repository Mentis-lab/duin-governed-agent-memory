import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { describe, expect, it } from 'vitest'
import { CONTROLLED_GET_PATHS, isControlledGetPath } from './control-plane-policy'

describe('shared control-plane policy', () => {
  it('is consumed by both the main guard and renderer fetch wrapper', () => {
    const main = readFileSync(
      fileURLToPath(new URL('../services/local-brain/control-plane-guard.ts', import.meta.url)),
      'utf8'
    )
    const renderer = readFileSync(
      fileURLToPath(new URL('../../src/duin/lib/loopback-auth.ts', import.meta.url)),
      'utf8'
    )

    expect(main).toMatch(/shared\/control-plane-policy/)
    expect(renderer).toMatch(/electron\/shared\/control-plane-policy/)
    for (const path of CONTROLLED_GET_PATHS) expect(isControlledGetPath(path)).toBe(true)
  })
})
