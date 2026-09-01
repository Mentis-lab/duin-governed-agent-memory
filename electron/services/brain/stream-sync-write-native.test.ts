import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  normalizeStream,
  buildAnchorMenu,
  buildStreamSyncPrompt,
  runStreamSync
} from './stream-sync-write-native'
import { loadOntology, type CompiledOntology } from './ontology'

// Cold-start A3 emptied the BUILT-IN track vocabulary, so normalizeStream now takes the vocabulary
// it validates against (`loadOntology(vaultDir)` from the callers that have a vault). The track
// contract is unchanged; it is just stated against a declared vocabulary instead of a compiled-in one.
const ONTOLOGY_JSON = { tracks: [{ key: 'alpha', match: 'alpha' }, { key: 'beta', match: 'beta' }] }
const ONTO = compileTestOntology()
function compileTestOntology(): CompiledOntology {
  const dir = mkdtempSync(join(tmpdir(), 'duin-ss-onto-'))
  mkdirSync(join(dir, '.duin'), { recursive: true })
  writeFileSync(join(dir, '.duin', 'ontology.json'), JSON.stringify(ONTOLOGY_JSON))
  return loadOntology(dir)
}

describe('stream-sync-write-native — normalizeStream (PURE)', () => {
  it('keeps a valid track, else falls back to trackOf over title+objective, else unknown', () => {
    expect(normalizeStream({ track: 'alpha', title: 'x' }, 'inferred', ONTO).track).toBe('alpha')
    expect(normalizeStream({ track: 'junk', title: 'alpha launch', objective: '' }, 'inferred', ONTO).track).toBe('alpha')
    expect(normalizeStream({ track: 'junk', title: 'totally generic', objective: 'nothing' }, 'inferred', ONTO).track).toBe('unknown')
  })

  it('with no vocabulary (the A3 built-in default) every track normalizes to unknown', () => {
    expect(normalizeStream({ track: 'alpha', title: 'alpha launch' }).track).toBe('unknown')
  })

  it('kind defaults to active for synced, emerging otherwise; explicit kind wins', () => {
    expect(normalizeStream({}, 'synced').kind).toBe('active')
    expect(normalizeStream({}, 'inferred').kind).toBe('emerging')
    expect(normalizeStream({ kind: 'emerging' }, 'synced').kind).toBe('emerging')
  })

  it('coerces dict steps defensively (String/slice/Boolean), caps at 7', () => {
    const steps = Array.from({ length: 9 }, (_, i) => ({ event: `e${i}`, when: '2026-06', lead: '~3mo', done: i === 0 }))
    const out = normalizeStream({ steps })
    expect(out.steps).toHaveLength(7)
    expect(out.steps[0]).toEqual({ event: 'e0', when: '2026-06', lead: '~3mo', done: true, task_id: '', gap: false })
  })

  it('does not crash on a numeric text field — coerces to string', () => {
    const out = normalizeStream({ steps: [{ event: 123, when: '2026-07', lead: '~1mo' }] })
    expect(out.steps[0].event).toBe('123')
  })

  it('accepts a bare-string step', () => {
    const out = normalizeStream({ steps: ['just a string step'] })
    expect(out.steps[0]).toEqual({ event: 'just a string step', when: '', lead: '', done: false, task_id: '', gap: false })
  })

  it('levels: keeps in-range numbers, defaults out-of-range/missing; confidence level defaults to top-level conf', () => {
    expect(normalizeStream({ levels: { risk: 0.7, progress: 1.5 }, confidence: 0.9 }).levels).toEqual({
      risk: 0.7,
      progress: 0.1, // 1.5 out of [0,1] → default
      confidence: 0.9 // missing level.confidence → top-level conf
    })
    expect(normalizeStream({}).levels).toEqual({ risk: 0.3, progress: 0.1, confidence: 0.5 })
  })

  it('title falls back to objective; text fields are sliced', () => {
    expect(normalizeStream({ objective: 'the goal' }).title).toBe('the goal')
    expect(normalizeStream({ title: 'x'.repeat(200) }).title).toHaveLength(80)
  })

  it('emits the full Python key set in order', () => {
    expect(Object.keys(normalizeStream({}, 'synced'))).toEqual([
      'title', 'objective', 'parent', 'parent_label', 'anchor_id', 'track', 'kind', 'target',
      'trigger', 'decision', 'decide_by', 'steps', 'cleared', 'blocked', 'confirm', 'levels',
      'confidence', 'log', 'source'
    ])
  })
})

describe('stream-sync-write-native — prompt + anchor menu (PURE)', () => {
  it('builds the anchor menu, dropping confidential entries', () => {
    const menu = buildAnchorMenu([
      { id: 'a1', name: 'BW', date: '2026-07', track: '北澜', confidential: false },
      { id: 'a2', name: 'secret', date: '', track: 'orbis', confidential: true }
    ])
    expect(menu).toBe('- a1 · BW · 2026-07 · 北澜')
  })

  it('prompt is verbatim (schema, LANG_RULE, today, menu, description)', () => {
    const p = buildStreamSyncPrompt('MY-DESC', '- a1 · BW · 2026-07 · 北澜', '2026-07-03')
    expect(p).toContain('The operator is SYNCING a strategic STREAM')
    expect(p).toContain('BACK-PROPAGATE the latest the decision can be made (target − total lead time)')
    expect(p).toContain('LANGUAGE — write each item in the language of its DOMAIN')
    expect(p).toContain('Today is 2026-07-03.')
    expect(p).toContain('=== DECLARED ANCHORS (bind via anchor_id) ===\n- a1 · BW · 2026-07 · 北澜')
    expect(p.endsWith("The operator's description:\nMY-DESC")).toBe(true)
  })

  it('menu falls back to (none) when empty', () => {
    expect(buildStreamSyncPrompt('d', '', '2026-07-03')).toContain('anchor_id) ===\n(none)\n')
  })
})

describe('stream-sync-write-native — runStreamSync (append)', () => {
  let vault: string
  let sd: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-ss-'))
    sd = join(vault, '.duin', '_state')
    mkdirSync(sd, { recursive: true })
    writeFileSync(join(vault, '.duin', 'ontology.json'), JSON.stringify(ONTOLOGY_JSON))
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('errors (no write) when the model returns nothing parseable', async () => {
    const out = await runStreamSync(vault, 'a plan', { generate: async () => 'sorry, no JSON here' })
    expect(out).toEqual({ ok: false, error: 'could not structure that' })
  })

  it('appends a normalized node with id/status/created/refreshed and returns it', async () => {
    const out = await runStreamSync(vault, 'ship alpha to TapTap', {
      generate: async () =>
        '{"title":"TapTap launch","objective":"launch on TapTap","track":"alpha","decide_by":"2026-08","confidence":0.7,"steps":[{"event":"submit build","when":"2026-07","lead":"~1mo"}]}',
      now: () => new Date(2026, 6, 3, 9, 30, 0),
      today: () => new Date(2026, 6, 3),
      uid: () => 'str01234'
    })
    expect(out.ok).toBe(true)
    expect(out.stream).toMatchObject({
      id: 'str01234',
      status: 'open',
      created: '2026-07-03T09:30:00',
      refreshed: '2026-07-03T09:30:00',
      title: 'TapTap launch',
      track: 'alpha', // validated against the VAULT's ontology, which runStreamSync loads
      kind: 'active',
      decide_by: '2026-08',
      confidence: 0.7,
      source: 'synced'
    })
    expect(out.stream?.steps[0]).toEqual({ event: 'submit build', when: '2026-07', lead: '~1mo', done: false, task_id: '', gap: false })
    const lines = readFileSync(join(sd, 'future-nodes.jsonl'), 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]).id).toBe('str01234')
  })

  it('appends to (does not overwrite) an existing future-nodes.jsonl', async () => {
    writeFileSync(join(sd, 'future-nodes.jsonl'), JSON.stringify({ id: 'existing', status: 'open' }) + '\n')
    await runStreamSync(vault, 'another plan', {
      generate: async () => '{"title":"T2","track":"personal"}',
      uid: () => 'new00001'
    })
    const lines = readFileSync(join(sd, 'future-nodes.jsonl'), 'utf-8').trim().split('\n')
    expect(lines.map((l) => JSON.parse(l).id)).toEqual(['existing', 'new00001'])
  })
})
