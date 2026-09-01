import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  buildStreamGraph,
  buildCausalGraph,
  readAnchorDecls,
  extendWithAnchors,
  parseTaskLine,
  anchorBinds,
  gatherTasks,
  causalGraph,
  labelMatchesKey,
  edgeConfidence,
  daysBetween,
  parseDeadline,
  type FutureStream,
  type Driver,
  type AnchorDecl,
  type CGEdge
} from './causal-substrate'

describe('date helpers', () => {
  it('daysBetween handles YYYY-MM-DD and YYYY-MM (→1st)', () => {
    expect(daysBetween('2026-06-20', '2026-07-10')).toBe(20)
    expect(daysBetween('2026-06', '2026-07')).toBe(30) // 06-01 → 07-01
    expect(daysBetween('Q1 2027', '2026-07-10')).toBe(null)
  })
  it('parseDeadline: YYYY-MM → last day of month', () => {
    expect(parseDeadline('2026-02')?.toISOString().slice(0, 10)).toBe('2026-02-28')
    expect(parseDeadline('2026-06-20')?.toISOString().slice(0, 10)).toBe('2026-06-20')
    expect(parseDeadline('Q1 2027')).toBe(null)
  })
})

describe('buildStreamGraph — faithful to causal_graph stream loop', () => {
  const futures: FutureStream[] = [
    {
      id: 's1',
      title: 'BW BD',
      track: '北澜',
      target: '2026-07-10',
      decide_by: '2026-06-20',
      decision: 'BW资源分配',
      cleared: '资源到位',
      blocked: '资源不足',
      parent_label: '北澜发行',
      steps: [
        { event: 'KOL确认', when: '2026-06-25', done: true },
        { event: '展位锁定', when: '2026-07-01' }
      ]
    }
  ]
  const drivers: Driver[] = [{ driver: '发行节奏', explains: ['s1'] }]
  const today = new Date('2026-06-22T00:00:00Z') // past decide_by → overdue

  const { nodes, edges } = buildStreamGraph(futures, drivers, today)
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]))
  const edge = (s: string, t: string) => edges.find((e) => e.source === s && e.target === t)

  it('produces the typed nodes with correct kinds', () => {
    expect(byId['stream:s1'].kind).toBe('stream')
    expect(byId['driver:发行节奏'].kind).toBe('driver') // dmap wins over parent_label
    expect(byId['decision:s1'].kind).toBe('decision')
    expect(byId['outcome:s1:cleared'].kind).toBe('outcome')
    expect(byId['outcome:s1:blocked'].kind).toBe('risk') // blocked → risk node
    expect(byId['step:s1:0'].kind).toBe('step')
    expect(byId['step:s1:1'].kind).toBe('step')
  })

  it('decision overdue + step done flags', () => {
    expect(byId['decision:s1'].overdue).toBe(true)
    expect(byId['step:s1:0'].done).toBe(true)
    expect(byId['step:s1:1'].done).toBe(false)
  })

  it('folds decide_by/fork/steps onto the stream node', () => {
    expect(byId['stream:s1'].decide_by).toBe('2026-06-20')
    expect(byId['stream:s1'].decision_id).toBe('decision:s1')
    expect((byId['stream:s1'].fork as any).cleared).toBe('资源到位')
    expect((byId['stream:s1'].steps as any[]).length).toBe(2)
  })

  it('edges carry the right types + lag_days', () => {
    expect(edge('driver:发行节奏', 'stream:s1')?.type).toBe('drives')
    expect(edge('decision:s1', 'stream:s1')).toMatchObject({ type: 'gates', lag_days: 20 })
    expect(edge('decision:s1', 'outcome:s1:cleared')).toMatchObject({ type: 'if_cleared', polarity: '+', branch: true })
    expect(edge('decision:s1', 'outcome:s1:blocked')).toMatchObject({ type: 'if_blocked', polarity: '-' })
    expect(edge('decision:s1', 'step:s1:0')).toMatchObject({ type: 'requires', lag_days: 5 })
    expect(edge('step:s1:0', 'step:s1:1')).toMatchObject({ type: 'requires', lag_days: 6 })
    expect(edge('step:s1:1', 'stream:s1')).toMatchObject({ type: 'enables', lag_days: 9 })
  })
})

describe('anchor layer (Level 1) — decls + feeds/dep/resource', () => {
  let vault: string
  beforeAll(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-cg-'))
    mkdirSync(join(vault, '北澜'), { recursive: true })
    writeFileSync(
      join(vault, '北澜', '(C) anchor-meilin.md'),
      [
        '---',
        'type: anchor',
        'anchor-id: meilin-2026',
        'name: 美林试玩会',
        'kind: event',
        'date: 2026-06-20',
        'track: 北澜',
        'attendees: 钟瑶, 沈一舟',
        'depends-on: bw-2026',
        'binds-keywords: 试玩会, 美林',
        'builds-toward: bw-2026',
        'confidential: false',
        '---',
        'body'
      ].join('\n')
    )
    writeFileSync(
      join(vault, '北澜', '(C) anchor-bw.md'),
      '---\ntype: anchor\nanchor-id: bw-2026\nname: BilibiliWorld\nkind: event\ndate: 2026-07-10\ntrack: 北澜\n---\n'
    )
    // .duin/_state so buildCausalGraph's loaders don't error
    mkdirSync(join(vault, '.duin', '_state'), { recursive: true })
    writeFileSync(
      join(vault, '.duin', '_state', 'future-nodes.jsonl'),
      JSON.stringify({ id: 'st1', title: '美林 stream', track: '北澜', anchor_id: 'meilin-2026', target: '2026-06-18' }) + '\n'
    )
  })
  afterAll(() => rmSync(vault, { recursive: true, force: true }))

  it('readAnchorDecls parses FM incl. comma-lists + booleans', () => {
    const decls = readAnchorDecls(vault)
    const m = decls.find((d) => d.id === 'meilin-2026')!
    expect(m.name).toBe('美林试玩会')
    expect(m.attendees).toEqual(['钟瑶', '沈一舟'])
    expect(m.depends_on).toEqual(['bw-2026'])
    expect(m.builds_toward).toBe('bw-2026')
    expect(m.confidential).toBe(false)
  })

  it('extendWithAnchors builds anchor/dependency/resource nodes + edges', () => {
    const { nodes, edges } = extendWithAnchors([], [], readAnchorDecls(vault))
    const ids = new Set(nodes.map((n) => n.id))
    expect(ids.has('anchor:meilin-2026')).toBe(true)
    expect(ids.has('dep:bw-2026')).toBe(true)
    expect(ids.has('res:钟瑶')).toBe(true)
    expect(edges.some((e) => e.source === 'res:钟瑶' && e.target === 'anchor:meilin-2026' && e.type === 'staffs')).toBe(true)
    expect(edges.some((e) => e.source === 'anchor:meilin-2026' && e.target === 'anchor:bw-2026' && e.type === 'builds_toward')).toBe(true)
  })

  it('buildCausalGraph wires the explicit stream→anchor feeds edge', () => {
    const { edges } = buildCausalGraph(vault, new Date('2026-06-01T00:00:00Z'))
    expect(edges.some((e) => e.source === 'stream:st1' && e.target === 'anchor:meilin-2026' && e.type === 'feeds')).toBe(true)
  })
})

describe('task layer (Level 2) — parse + bind + gate nodes', () => {
  it('parseTaskLine parses checkbox, {{fields}}, #tags, @people', () => {
    const t = parseTaskLine('  - [ ] 试玩会准备 | 场地确认 {{priority:: 1}} {{dateDue:: 2026-06-18}} #北澜 @钟瑶', '北澜/Tasks.md', 42)!
    expect(t.done).toBe(false)
    expect(t.priority).toBe('1')
    expect(t.due).toBe('2026-06-18')
    expect(t.tags).toContain('北澜')
    expect(t.people).toContain('钟瑶')
    expect(t.id).toBe('北澜/Tasks.md#42') // no duinTaskId → source#line
    expect(parseTaskLine('not a task line', 'x', 0)).toBe(null)
  })

  it('anchorBinds matches on keyword in text', () => {
    const decl = { binds_keywords: ['试玩会'], binds_contexts: [], binds_tags: [], binds_ids: [], exclude_contexts: [] } as unknown as AnchorDecl
    const t = parseTaskLine('- [ ] 试玩会单场 SOW', 'x', 0)!
    expect(anchorBinds(t, decl)).toBe(true)
    expect(anchorBinds(parseTaskLine('- [ ] unrelated', 'x', 1)!, decl)).toBe(false)
  })

  it('gatherTasks is CRLF-tolerant (the 北澜/Tasks.md bug) + buildCausalGraph makes gate nodes', () => {
    const v = mkdtempSync(join(tmpdir(), 'duin-l2-'))
    mkdirSync(join(v, '.duin', '_state'), { recursive: true })
    writeFileSync(join(v, '.duin', '_state', 'future-nodes.jsonl'), '')
    mkdirSync(join(v, '北澜'), { recursive: true })
    // CRLF line endings — the exact case that parsed 0 tasks before the fix
    writeFileSync(join(v, '北澜', 'Tasks.md'), '- [ ] 试玩会 场地确认 {{priority:: 1}} {{dateDue:: 2026-06-18}}\r\n- [x] done thing\r\n')
    writeFileSync(join(v, '北澜', '(C) anchor-m.md'), '---\ntype: anchor\nanchor-id: meilin\nname: 试玩会\ntrack: 北澜\nbinds-keywords: 试玩会\n---\n')
    const tasks = gatherTasks(v, new Date('2026-06-01T00:00:00Z'))
    expect(tasks.length).toBe(1) // the open CRLF task parsed (done one excluded)
    const { nodes, edges } = buildCausalGraph(v, new Date('2026-06-01T00:00:00Z'))
    expect(nodes.some((n) => n.kind === 'gate' && n.id.startsWith('task:'))).toBe(true)
    expect(edges.some((e) => e.type === 'requires' && e.target === 'anchor:meilin')).toBe(true)
    rmSync(v, { recursive: true, force: true })
  })
})

describe('causalGraph decorations', () => {
  const e = (source: string, target: string, type: string): CGEdge => ({ source, target, type, lag_days: null, polarity: '+' })
  it('edgeConfidence: verdict > pattern > prior', () => {
    expect(edgeConfidence(e('decision:x', 'stream:x', 'gates'), { subjects: { x: 'passed' }, patterns: {} })).toEqual([0.85, 'validated:passed'])
    expect(edgeConfidence(e('a:b', 'c:d', 'requires'), { subjects: {}, patterns: { 'chain-slippage': 0.6 } })).toEqual([0.7, 'pattern:chain-slippage'])
    expect(edgeConfidence(e('a:b', 'c:d', 'drives'), { subjects: {}, patterns: {} })).toEqual([0.5, 'prior'])
  })
  it('causalGraph returns the full route shape with consistent stats', () => {
    const r = causalGraph(null, '', new Date('2026-07-01T00:00:00Z'))
    expect(r).toHaveProperty('nodes')
    expect(r).toHaveProperty('roadmap')
    expect(r.anchor).toBe(null)
    expect(r.today).toBe('2026-07-01')
    expect(r.stats.nodes).toBe(r.nodes.length)
    expect(r.note).toContain('P0 derived causal graph')
  })
})

describe('labelMatchesKey — fuzzy-feed coincidence guard', () => {
  it('matches an ASCII key only on a word boundary (no substring coincidence)', () => {
    expect(labelMatchesKey('the email thread', 'ai')).toBe(false) // "ai" ⊄ "email"
    expect(labelMatchesKey('maintain the build', 'ai')).toBe(false)
    expect(labelMatchesKey('an AI review', 'ai')).toBe(true) // whole word (case-insensitive)
    expect(labelMatchesKey('bilibiliworld booth src/slack/1', 'booth')).toBe(true)
  })

  it('matches a CJK key by substring (no word boundaries in CJK)', () => {
    expect(labelMatchesKey('北澜发行渠道决策', '北澜')).toBe(true)
    expect(labelMatchesKey('unrelated topic', '北澜')).toBe(false)
  })

  it('tolerates regex metacharacters in a key', () => {
    expect(labelMatchesKey('c++ refactor', 'c++')).toBe(false) // no \bc++\b boundary — no crash
    expect(labelMatchesKey('the (draft) plan', 'draft')).toBe(true)
  })
})
