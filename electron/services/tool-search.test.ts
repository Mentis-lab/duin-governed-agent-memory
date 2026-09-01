import { describe, expect, it } from 'vitest'
import {
  computeToolTags,
  parseSelectQuery,
  scoreDescriptor,
  searchDescriptors,
  tokenizeQuery
} from './tool-search'

// Track 2 / C1 — pure-function tests for the search + tag derivation
// module. Exercises:
//   - tag taxonomy (provider kind, risks, meta flags)
//   - select:NAME[,NAME...] parser
//   - keyword tokenizer (lowercase, whitespace, commas, slashes)
//   - scoring weights (name 3x, tags 2x, description 1x)
//   - stable ordering on ties

const D = (
  name: string,
  description: string,
  tags: string[]
): { name: string; description: string; tags: string[] } => ({
  name,
  description,
  tags
})

describe('computeToolTags', () => {
  it('emits providerKind first, then every risk', () => {
    expect(
      computeToolTags({
        providerKind: 'native',
        risks: ['read', 'network'],
        requiresApproval: false
      })
    ).toEqual(['native', 'read', 'network'])
  })

  it('adds approval-required when the descriptor gates', () => {
    expect(
      computeToolTags({
        providerKind: 'native',
        risks: ['write'],
        requiresApproval: true
      })
    ).toContain('approval-required')
  })

  it('adds parallelizable when the flag is set', () => {
    expect(
      computeToolTags({
        providerKind: 'native',
        risks: ['read'],
        requiresApproval: false,
        parallelizable: true
      })
    ).toContain('parallelizable')
  })

  it('adds lazy for MCP tools and omits it for native', () => {
    const native = computeToolTags({
      providerKind: 'native',
      risks: ['read'],
      requiresApproval: false,
      lazy: false
    })
    const mcp = computeToolTags({
      providerKind: 'mcp',
      risks: ['network'],
      requiresApproval: false,
      lazy: true
    })
    expect(native).not.toContain('lazy')
    expect(mcp).toContain('lazy')
    expect(mcp).toContain('mcp')
  })
})

describe('parseSelectQuery', () => {
  it('returns null for non-select queries', () => {
    expect(parseSelectQuery('shell')).toBeNull()
    expect(parseSelectQuery('  ')).toBeNull()
  })

  it('parses comma-separated names', () => {
    expect(parseSelectQuery('select:foo,bar,baz')).toEqual(['foo', 'bar', 'baz'])
  })

  it('tolerates whitespace around commas', () => {
    expect(parseSelectQuery('select: foo , bar ')).toEqual(['foo', 'bar'])
  })

  it('drops empty entries', () => {
    expect(parseSelectQuery('select:foo,,bar,')).toEqual(['foo', 'bar'])
  })

  it('is case-insensitive on the prefix', () => {
    expect(parseSelectQuery('SELECT:foo')).toEqual(['foo'])
  })
})

describe('tokenizeQuery', () => {
  it('lowercases, splits on whitespace, comma, slash', () => {
    expect(tokenizeQuery('Shell Command/Run, Trace')).toEqual([
      'shell',
      'command',
      'run',
      'trace'
    ])
  })

  it('drops empties', () => {
    expect(tokenizeQuery('   ')).toEqual([])
  })
})

describe('scoreDescriptor', () => {
  it('exact name match outranks substring match', () => {
    const a = scoreDescriptor(D('shell', 'run shell commands', ['native']), ['shell'])
    const b = scoreDescriptor(
      D('shell_command', 'run shell commands', ['native']),
      ['shell']
    )
    expect(a).toBeGreaterThan(b)
  })

  it('tag match contributes', () => {
    const onlyTag = scoreDescriptor(D('x', 'unrelated', ['lazy']), ['lazy'])
    expect(onlyTag).toBe(2)
  })

  it('description match is the cheapest hit', () => {
    const onlyDesc = scoreDescriptor(D('x', 'a lazy tool', []), ['lazy'])
    expect(onlyDesc).toBe(1)
  })

  it('returns 0 with no overlap', () => {
    expect(scoreDescriptor(D('a', 'b', ['c']), ['nope'])).toBe(0)
  })

  // Gate finding F6 — 1-character tokens used to score +3 for any name that
  // merely CONTAINED the letter, so a natural-language query drowned the real
  // match in noise.
  it('a 1-character token scores nothing against a name that merely contains it', () => {
    expect(scoreDescriptor(D('image_generate', 'zzz', []), ['a'])).toBe(0)
    expect(scoreDescriptor(D('apply_patch', 'zzz', []), ['a'])).toBe(0)
  })

  it('a 1-character token still matches a tool literally named that', () => {
    expect(scoreDescriptor(D('a', 'zzz', []), ['a'])).toBe(6)
  })

  it('a short token still matches a whole word — real signal is preserved', () => {
    // "qa" is a genuine segment of frontend_qa; it must not be collateral of
    // the length floor.
    expect(scoreDescriptor(D('frontend_qa', 'zzz', []), ['qa'])).toBe(3)
    // …but it must NOT match a name that only contains the letters.
    expect(scoreDescriptor(D('aqueduct', 'zzz', []), ['qa'])).toBe(0)
  })

  it('tokens of 3+ still match as substrings (unchanged behaviour)', () => {
    expect(scoreDescriptor(D('browser_screenshot', 'zzz', []), ['screensho'])).toBe(3)
    expect(scoreDescriptor(D('browser_screenshot', 'zzz', []), ['reenshot'])).toBe(3)
  })

  it('a repeated query word is one signal, not two', () => {
    const once = scoreDescriptor(D('web_search', 'search the web', []), ['web'])
    const twice = scoreDescriptor(D('web_search', 'search the web', []), ['web', 'web'])
    expect(twice).toBe(once)
  })
})

describe('searchDescriptors', () => {
  const sample = [
    D('shell_command', 'Run a one-shot shell command', ['native', 'write', 'network']),
    D('workspace_context', 'Workspace preflight', ['native', 'read', 'parallelizable']),
    D('memory_add', 'Save a fact about the user', ['native', 'write']),
    D('chrome__navigate', 'Navigate the browser tab', ['mcp', 'network', 'lazy']),
    D('chrome__click', 'Click a DOM node', [
      'mcp',
      'destructive',
      'write',
      'network',
      'lazy',
      'approval-required'
    ])
  ]

  it('keyword ranks by name then tags then description', () => {
    const r = searchDescriptors(sample, 'shell')
    expect(r[0]?.name).toBe('shell_command')
  })

  it('caps to maxResults', () => {
    expect(searchDescriptors(sample, 'lazy', 1)).toHaveLength(1)
  })

  it('returns empty array on no matches', () => {
    expect(searchDescriptors(sample, 'unknowntoken')).toEqual([])
  })

  it('keeps original order on score ties', () => {
    // Both have 'lazy' tag → identical score → original order preserved.
    const r = searchDescriptors(sample, 'lazy')
    expect(r.map((d) => d.name)).toEqual(['chrome__navigate', 'chrome__click'])
  })

  it('multi-token query sums per-token scores', () => {
    // 'click' hits chrome__click's name, 'destructive' hits its tags.
    const r = searchDescriptors(sample, 'click destructive')
    expect(r[0]?.name).toBe('chrome__click')
  })

  // Gate finding F6 — the shape of the real failure, in miniature.
  it('a natural-language phrasing ranks the real match first', () => {
    const catalog = [
      D('memory_add', 'Save a fact about the user', ['native', 'write']),
      D('apply_patch', 'Apply a patch to a file in the workspace', ['native', 'write']),
      D('workspace_context', 'Workspace preflight for an agent', ['native', 'read']),
      // No 'a' anywhere in this name — under the old scoring it collected none
      // of the "a" noise the others did, and sank.
      D('browser_screenshot', 'Capture a PNG screenshot of the visible viewport', [
        'native',
        'read'
      ])
    ]
    const r = searchDescriptors(catalog, 'take a screenshot of a web page')
    expect(r[0]?.name).toBe('browser_screenshot')
  })
})
