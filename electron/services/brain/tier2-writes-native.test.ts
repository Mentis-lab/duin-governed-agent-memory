import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync } from 'fs'
import { recordPredictionFeedback, dismissAnchorCandidate, createProject } from './tier2-writes-native'

describe('tier2-writes-native', () => {
  let vault: string
  let sd: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-t2-'))
    sd = join(vault, '.duin', '_state')
    mkdirSync(sd, { recursive: true })
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  describe('recordPredictionFeedback', () => {
    it('appends a feedback row and accepts valid marks', () => {
      expect(recordPredictionFeedback(vault, 'p1', 'risk', 'false_alarm', new Date('2026-07-02T10:00:00')))
        .toEqual({ ok: true, id: 'p1', mark: 'false_alarm' })
      const rows = readFileSync(join(sd, 'prediction-feedback.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
      expect(rows[0]).toMatchObject({ id: 'p1', domain: 'risk', mark: 'false_alarm', ts: '2026-07-02T10:00:00' })
    })
    it('rejects a bad mark / missing id', () => {
      expect(recordPredictionFeedback(vault, 'p1', '', 'bogus').ok).toBe(false)
      expect(recordPredictionFeedback(vault, '', '', 'correct').ok).toBe(false)
    })
    it('is append-only (two rows for the same id both land)', () => {
      recordPredictionFeedback(vault, 'p1', '', 'correct')
      recordPredictionFeedback(vault, 'p1', '', 'clear')
      const n = readFileSync(join(sd, 'prediction-feedback.jsonl'), 'utf-8').trim().split('\n').length
      expect(n).toBe(2)
    })
  })

  describe('dismissAnchorCandidate', () => {
    it('adds a referent to the sorted dismissed set', () => {
      expect(dismissAnchorCandidate(vault, 'zeta')).toEqual({ ok: true, dismissed: 'zeta', total_dismissed: 1 })
      dismissAnchorCandidate(vault, 'alpha')
      const set = JSON.parse(readFileSync(join(sd, 'anchor-dismissed.json'), 'utf-8'))
      expect(set).toEqual(['alpha', 'zeta']) // sorted, matches Python json.dump(sorted(s))
    })
    it('is idempotent (re-dismiss keeps one entry)', () => {
      dismissAnchorCandidate(vault, 'alpha')
      const r = dismissAnchorCandidate(vault, 'alpha')
      expect(r.total_dismissed).toBe(1)
    })
    it('rejects an empty referent / null vault', () => {
      expect(dismissAnchorCandidate(vault, '  ').ok).toBe(false)
      expect(dismissAnchorCandidate(null, 'x').ok).toBe(false)
    })
  })

  describe('createProject', () => {
    it('creates an arena folder + hub note (arena-first vault, no 03 Projects)', () => {
      const r = createProject(vault, 'BW Activation')
      expect(r).toEqual({ ok: true, name: 'BW Activation' })
      const hub = readFileSync(join(vault, 'BW Activation', 'BRAIN.md'), 'utf-8')
      expect(hub).toBe('---\ntype: project-hub\ncreated-by: duin\n---\n\n# BW Activation — Project Hub\n')
    })
    it('uses 03 Projects/<name> on a legacy vault', () => {
      mkdirSync(join(vault, '03 Projects'), { recursive: true })
      createProject(vault, 'Legacy One')
      expect(existsSync(join(vault, '03 Projects', 'Legacy One', 'BRAIN.md'))).toBe(true)
    })
    it('rejects invalid names, existing projects, null vault', () => {
      expect(createProject(vault, 'bad/name').ok).toBe(false)
      expect(createProject(vault, '  ').ok).toBe(false)
      createProject(vault, 'Dupe')
      expect(createProject(vault, 'Dupe')).toEqual({ ok: false, error: 'a project with that name already exists' })
      expect(createProject(null, 'x').ok).toBe(false)
    })
  })
})
