import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { resolveBrainUrl } from './duin-bridge'

// README documented `http://127.0.0.1:8765/agui` as THE default brain endpoint,
// in four places, complete with copy-pasteable `DUIN_BRAIN_URL=...:8765` commands
// — while resolveBrainUrl() silently coerces any :8765 target back to :8799. A
// user following the README got an env var that was quietly discarded, with no
// warning. The Settings panel shipped the same wrong default as its placeholder
// and its on-blur fallback.
//
// This pins the two together: the port the code resolves to is the port the
// user-facing docs and the Settings default advertise.

const ROOT = resolve(__dirname, '../..')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

const LIVE_PORT = '8799'
const RETIRED_PORT = '8765'

describe('brain port: code and docs agree', () => {
  it('resolves to the live port, and coerces the retired one', () => {
    expect(resolveBrainUrl()).toBe(`http://127.0.0.1:${LIVE_PORT}/agui`)
    expect(resolveBrainUrl(`http://127.0.0.1:${RETIRED_PORT}/agui`)).toBe(
      `http://127.0.0.1:${LIVE_PORT}/agui`
    )
  })

  it('README never presents the retired port as a value to configure', () => {
    // Prose ABOUT the retirement is fine and wanted; an assignment or a bare
    // endpoint URL is what misleads. Match the shapes that read as "use this".
    const readme = read('README.md')
    expect(readme).not.toMatch(new RegExp(`DUIN_BRAIN_URL[^\\n]*${RETIRED_PORT}`))
    expect(readme).not.toMatch(new RegExp(`\`http://127\\.0\\.0\\.1:${RETIRED_PORT}[^\`]*\``))
    // …and it does document the real one.
    expect(readme).toContain(`http://127.0.0.1:${LIVE_PORT}/agui`)
  })

  it('the Settings panel default matches the resolved default', () => {
    const panel = read('src/components/settings/BrainSettings.tsx')
    const m = panel.match(/const DEFAULT_BRAIN_URL = '([^']+)'/)
    expect(m?.[1]).toBe(resolveBrainUrl())
  })

  it('README does not claim a bundled Python sidecar', () => {
    // The Linux row advertised "bundles the Python brain sidecar". It never
    // could: resources/brain/ is gone and electron-builder.yml has no
    // extraResources entry for it.
    expect(read('README.md')).not.toMatch(/bundles the Python brain sidecar/i)
  })
})
