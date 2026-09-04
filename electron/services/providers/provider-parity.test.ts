import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { PROVIDERS, MODEL_CATALOG } from './registry'

// Source-lock: the main-process ProviderId union (registry.ts) and the renderer
// mirror (src/lib/types.ts) must stay member-identical. The renderer cannot
// import electron code, so the mirror is hand-maintained — exactly the drift
// that shipped only 7 of the (then) 9 members. This test makes the drift fail
// the build. Adapted from the upstream provider-parity test for DUIN's shape:
// counts are re-pinned to DUIN's ACTUAL totals, DUIN's API-key UI is DYNAMIC
// (driven by listProviderKeys, no hardcoded PROVIDER_GROUPS to lock), and the
// OpenRouter clause is INVERTED — DUIN routes Claude via OpenRouter by design.

const repoRoot = join(__dirname, '..', '..', '..')

function unionMembers(relPath: string): string[] {
  const source = readFileSync(join(repoRoot, relPath), 'utf-8')
  const decl = source.match(/export type ProviderId =([\s\S]*?)\n\s*\n/)
  if (!decl) throw new Error(`ProviderId declaration not found in ${relPath}`)
  return [...decl[1].matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1])
}

describe('ProviderId union parity (main ↔ renderer)', () => {
  const mainMembers = unionMembers('electron/services/providers/registry.ts')
  const rendererMembers = unionMembers('src/lib/types.ts')

  it('both unions declare the original core providers', () => {
    for (const id of ['deepseek', 'google', 'dashscope', 'openrouter', 'zhipu', 'openai']) {
      expect(mainMembers).toContain(id)
    }
  })

  it('renderer union is member-identical to the main-process union', () => {
    expect([...rendererMembers].sort()).toEqual([...mainMembers].sort())
  })

  it('the PROVIDERS table covers exactly the union members', () => {
    expect(Object.keys(PROVIDERS).sort()).toEqual([...mainMembers].sort())
  })

  it('pins DUIN provider + pinned-model catalog totals', () => {
    // Re-pinned for the 2026-08-21 catalog redo (operator order): 15 providers
    // (the 14 + first-class 'anthropic' via the official OpenAI-compat layer)
    // and 34 pinned models — the six operator-named provider families (Claude,
    // OpenAI, DeepSeek, Kimi, GLM, Qwen) each carry a wide slice of their
    // CURRENT top lineup, verified against official docs on 2026-08-21; the
    // gpt-4o/o3/gpt-5.1-era, kimi-k2.5/moonshot-v1, glm-5.2, qwen3.5-era and
    // Gemma-4-via-OpenRouter pins were retired into RETIRED_MODEL_MAP.
    expect(Object.keys(PROVIDERS)).toHaveLength(15)
    expect(MODEL_CATALOG).toHaveLength(42) // +4 Gemini (operator request, same 2026-08-21 verification pass); +1 glm-5.3-flash (2026-08-26 operator order — it replaced the ox-alpha pin, which was this model's stealth preview); +1 qwen3.8-flash (2026-08-27 operator order, released 2026-08-26); +2 on 2026-09-04 (operator order): claude-fable-5-1 and gemini-3.8-flash, each verified against its vendor doc that day
  })

  it('ships Claude through the FIRST-CLASS anthropic provider, not OpenRouter', () => {
    // Inverted 2026-08-21: the old clause pinned Claude-via-OpenRouter because no
    // direct provider existed. Anthropic's official OpenAI-compat layer
    // (api.anthropic.com/v1/) made the shared-client path real, so the design is
    // now: a real 'anthropic' provider with bare claude-* wire ids, and no Claude
    // reaches the catalog through an OpenRouter proxy.
    //
    // This assertion used to read `openrouter …toHaveLength(0)`, which conflated
    // two separate rules: "Claude is first-class" (permanent) and "OpenRouter is
    // zero-pinned" (incidental — true only because nothing warranted a pin). The
    // 2026-08-26 ox-alpha pin broke the second while leaving the first intact, so
    // the check now targets the rule it actually means: whatever OpenRouter pins,
    // none of it may be a Claude proxy. (ox-alpha has since graduated to Zhipu's
    // glm-5.3-flash, so OpenRouter is zero-pinned again; the check stays as the rule,
    // not the count.)
    expect(Object.prototype.hasOwnProperty.call(PROVIDERS, 'anthropic')).toBe(true)
    const claude = MODEL_CATALOG.filter((m) => m.provider === 'anthropic')
    expect(claude.length).toBeGreaterThanOrEqual(4)
    for (const m of claude) expect(m.apiModelId.startsWith('claude-')).toBe(true)
    for (const m of MODEL_CATALOG.filter((x) => x.provider === 'openrouter')) {
      expect(/claude|anthropic/i.test(m.apiModelId), `${m.id} proxies Claude through OpenRouter`).toBe(false)
    }
  })

  it('every catalog model points at a provider that exists in PROVIDERS', () => {
    for (const m of MODEL_CATALOG) {
      expect(
        Object.prototype.hasOwnProperty.call(PROVIDERS, m.provider),
        `${m.id} references unknown provider '${m.provider}'`
      ).toBe(true)
    }
  })

  it('keeps the live-model import affordance visibly wired end to end', () => {
    expect(
      readFileSync(join(repoRoot, 'src/components/settings/ModelSettings.tsx'), 'utf-8')
    ).toContain('window.api.model.importLive(importProvider, ids)')
    expect(readFileSync(join(repoRoot, 'electron/preload.ts'), 'utf-8')).toContain(
      "ipcRenderer.invoke('model:importLive', { provider, ids })"
    )
  })
})
