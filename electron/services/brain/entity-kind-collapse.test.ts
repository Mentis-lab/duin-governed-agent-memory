import { describe, it, expect } from 'vitest'
import { decideKindCollapse, KIND_PRECEDENCE, type CollapseEntity } from './entity-kind-collapse'
import type { AliasGroup } from './entity-resolver'

const e = (id: string, label: string, kind: string): CollapseEntity => ({ id, label, kind })

describe('decideKindCollapse', () => {
  it('collapses one label recorded under two kinds onto the higher-precedence kind', () => {
    const { groups } = decideKindCollapse([e('org:acme', 'Acme', 'org'), e('topic:acme', 'Acme', 'topic')])
    expect(groups).toHaveLength(1)
    expect(groups[0].canonicalId).toBe('org:acme')
    expect(groups[0].kinds).toEqual(['org', 'topic'])
    expect(groups[0].source).toBe('auto-kind')
  })

  it('leaves a label that carries only one kind alone', () => {
    const { groups } = decideKindCollapse([e('topic:a', 'A', 'topic'), e('topic:b', 'B', 'topic')])
    expect(groups).toEqual([])
  })

  // ── the `project` guard — C4 abolishes the kind, so it must never be minted here ──
  it('never mints a project: canonical id, even when project is the only other kind', () => {
    const { groups } = decideKindCollapse([
      e('project:bilibili', 'bilibili', 'project'),
      e('org:bilibili', 'bilibili', 'org')
    ])
    expect(groups[0].canonicalId).toBe('org:bilibili')
  })

  it('project loses to topic, the weakest ranked kind', () => {
    const { groups } = decideKindCollapse([
      e('project:x', '经营玩法', 'project'),
      e('topic:x', '经营玩法', 'topic')
    ])
    expect(groups[0].canonicalId.startsWith('topic:')).toBe(true)
  })

  it('refuses, with a reason, when no member carries a rankable kind', () => {
    // `project` + a hypothetical future kind: nothing rankable, so nothing is minted.
    const { groups, skipped } = decideKindCollapse([
      e('project:x', 'Thing', 'project'),
      e('gadget:x', 'Thing', 'gadget')
    ])
    expect(groups).toEqual([])
    expect(skipped['no-rankable-kind']).toBe(1)
  })

  it('KIND_PRECEDENCE does not contain project', () => {
    expect(KIND_PRECEDENCE).not.toContain('project')
  })

  // ── the CJK slug-instability case this module exists for ──
  it('collapses one label whose slug churned across passes', () => {
    // Live shapes: event:duanwu-trial / project:duan-wu-shi-wan-hui / topic:端午试玩会 — three
    // slugs, one label. Keying on the slug would collapse nothing.
    const { groups } = decideKindCollapse([
      e('event:duanwu-trial', '端午试玩会', 'event'),
      e('project:duan-wu-shi-wan-hui', '端午试玩会', 'project'),
      e('topic:端午试玩会', '端午试玩会', 'topic')
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].canonicalId.startsWith('event:')).toBe(true)
    expect(groups[0].kinds).toEqual(['event', 'project', 'topic'])
  })

  it('normalizes case and spacing when grouping, and keeps every surface form as an alias', () => {
    const { groups } = decideKindCollapse([
      e('org:a', 'Acme  Corp', 'org'),
      e('topic:a', 'acme corp', 'topic')
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].aliases.sort()).toEqual(['Acme  Corp', 'acme corp'])
  })

  it('does not overrule a label the whitelist already governs', () => {
    const existing: AliasGroup[] = [
      { canonicalId: 'person:theo-quill', canonical: 'Theo', aliases: ['theo', 'Theo Quill'], source: 'human' }
    ]
    const { groups, skipped } = decideKindCollapse(
      [e('person:r', 'Theo Quill', 'person'), e('topic:r', 'theo quill', 'topic')],
      existing
    )
    expect(groups).toEqual([])
    expect(skipped['already-in-whitelist']).toBe(1)
  })

  it('refuses a canonical id the whitelist has already claimed', () => {
    const existing: AliasGroup[] = [
      { canonicalId: 'org:acme', canonical: 'Acme', aliases: ['something else'], source: 'human' }
    ]
    const { groups, skipped } = decideKindCollapse(
      [e('org:a', 'Acme', 'org'), e('topic:a', 'Acme', 'topic')],
      existing
    )
    expect(groups).toEqual([])
    expect(skipped['canonical-id-already-used']).toBe(1)
  })

  it('does not mint two groups onto the same canonical id within one run', () => {
    const { groups } = decideKindCollapse([
      e('org:a', 'Acme', 'org'), e('topic:a', 'Acme', 'topic'),
      e('org:b', 'ACME', 'org'), e('topic:b', 'acme', 'topic')
    ])
    const ids = groups.map((g) => g.canonicalId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('skips a label that slugifies to nothing rather than minting a bare-prefix id', () => {
    const { groups, skipped } = decideKindCollapse([e('org:x', '///', 'org'), e('topic:x', '///', 'topic')])
    expect(groups).toEqual([])
    expect(skipped['empty-slug']).toBe(1)
  })

  it('is deterministic — same census, same output order', () => {
    const census = [
      e('topic:z', 'Zeta', 'topic'), e('org:z', 'Zeta', 'org'),
      e('topic:a', 'Alpha', 'topic'), e('person:a', 'Alpha', 'person')
    ]
    const a = decideKindCollapse(census).groups.map((g) => g.canonicalId)
    const b = decideKindCollapse([...census].reverse()).groups.map((g) => g.canonicalId)
    expect(a).toEqual(b)
  })

  it('ignores entities with an empty or missing label', () => {
    const { groups } = decideKindCollapse([
      e('org:x', '', 'org'), e('topic:x', '   ', 'topic'), e('person:y', 'Real', 'person')
    ])
    expect(groups).toEqual([])
  })
})
