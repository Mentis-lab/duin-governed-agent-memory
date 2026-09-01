import { describe, it, expect, afterEach } from 'vitest'
import { shouldIgnore } from './notes-watcher'

describe('notes-watcher shouldIgnore (item 7 — live-watch the ingest set)', () => {
  it('watches every ingestable doc type (md/text/html + binary docs + json)', () => {
    // .json IS ingestable (the indexer maps it → application/json), so it is watched. Honest
    // behavior after the tie-up audit corrected the earlier (wrong) "json ignored" claim.
    for (const f of ['a.md', 'a.markdown', 'a.txt', 'a.html', 'a.htm', 'a.pdf', 'a.docx', 'a.json']) {
      expect(shouldIgnore(f)).toBe(false)
    }
  })
  it('always ignores extensions NOTHING can ingest', () => {
    for (const f of ['a.exe', 'a.zip']) {
      expect(shouldIgnore(f)).toBe(true)
    }
  })

  // Gated media track the INDEXER's capability rather than a fixed list. This test used to
  // assert `shouldIgnore('a.png') === true` unconditionally, which was written before image
  // OCR ingestion landed and has been carried as a "pre-existing baseline failure" ever since.
  // It was never a watcher bug: isIngestable() returns true for an image when ocrEnabled(),
  // which DEFAULTS ON, so the watcher was correctly watching a file the indexer will ingest —
  // the test was simply out of date, and (because ocrEnabled reads env then settings) it also
  // silently changed answer with the environment, which is why it read as mysterious.
  //
  // The real contract is conditional, so the test states it conditionally and pins BOTH sides.
  describe('images follow OCR — watched only when the indexer can actually read them', () => {
    const prior = process.env.DUIN_OCR
    afterEach(() => {
      if (prior === undefined) delete process.env.DUIN_OCR
      else process.env.DUIN_OCR = prior
    })

    it('WATCHES images when OCR is on — an edited screenshot must re-index', () => {
      process.env.DUIN_OCR = '1'
      for (const f of ['a.png', 'a.jpg']) expect(shouldIgnore(f)).toBe(false)
    })

    it('IGNORES images when OCR is off — nothing would read them, so watching is pure churn', () => {
      process.env.DUIN_OCR = '0'
      for (const f of ['a.png', 'a.jpg']) expect(shouldIgnore(f)).toBe(true)
    })

    it('audio stays ignored either way — transcription defaults OFF and OCR must not imply it', () => {
      process.env.DUIN_OCR = '1'
      expect(shouldIgnore('a.mp4')).toBe(true)
    })
  })
  it('ignores skip dirs; lets bare directories descend', () => {
    expect(shouldIgnore('node_modules/x.md')).toBe(true)
    expect(shouldIgnore('.git/x.md')).toBe(true)
    expect(shouldIgnore('foo')).toBe(false) // no extension → a directory, must descend
  })

  it('P5 "machine files only": ignores `_`-basename FILES; KEEPS DUIN/Meta cards + `_`-DIR notes', () => {
    // `_`-prefixed machine files (logs/indexes/dashboards) → ignored (scaffolding).
    expect(shouldIgnore('_concept-index.md')).toBe(true)
    expect(shouldIgnore('Notes/_dashboard.md')).toBe(true)
    expect(shouldIgnore('DUIN/Meta/_scratch.md')).toBe(true) // `_`-file wins even under DUIN/Meta
    // DUIN/Meta design cards (normal basename) are REAL knowledge → watched (KEPT, not ignored).
    expect(shouldIgnore('DUIN/Meta/design-card.md')).toBe(false)
    // A normal file inside a `_`-prefixed content DIR → watched (basename-scoped).
    expect(shouldIgnore('北澜/_原始转录/transcript.md')).toBe(false)
  })

  // A folder whose name contains a dot used to match the extension test, so it was ignored and
  // chokidar never descended — silently freezing the live index for that whole subtree.
  describe('dotted directory names still descend', () => {
    it('treats a spaced dot-name as a directory, not an extension', () => {
      expect(shouldIgnore('Vault/01. Inbox')).toBe(false)
      expect(shouldIgnore('Vault/Dr. Smith notes')).toBe(false)
      expect(shouldIgnore('Vault/v1.2 drafts')).toBe(false)
    })

    it('keeps watching notes underneath such a folder', () => {
      expect(shouldIgnore('Vault/01. Inbox/note.md')).toBe(false)
      expect(shouldIgnore('Vault/01. Inbox/_index.md')).toBe(true)
    })

    it('defers to chokidar stats when the name alone is ambiguous', () => {
      const asDir = { isDirectory: () => true }
      const asFile = { isDirectory: () => false }
      // `v1.2` looks exactly like a file with a `.2` extension; only stats can separate them.
      expect(shouldIgnore('Vault/v1.2', asDir)).toBe(false)
      expect(shouldIgnore('Vault/archive.zip', asFile)).toBe(true)
      expect(shouldIgnore('Vault/note.md', asFile)).toBe(false)
    })

    it('still rejects real non-ingestable extensions', () => {
      expect(shouldIgnore('Vault/binary.exe')).toBe(true)
      expect(shouldIgnore('Vault/notes.markdown')).toBe(false)
    })
  })
})

// Release M11 (A6 F7): agent/tool config trees are neither indexed nor watched. Parity with
// index-store.AGENT_CONFIG_DIRS — the indexer skips them, so a watcher that still fired on them
// would arm a reindex (and, with consent, an LLM pass) for content that never reaches the index.
describe('notes-watcher shouldIgnore — agent/tool config trees', () => {
  it('ignores .claude/.codex/.agents/.cursor/.github on both separators', () => {
    for (const d of ['.claude', '.codex', '.agents', '.cursor', '.github']) {
      expect(shouldIgnore(`${d}/x.md`), d).toBe(true)
      expect(shouldIgnore(`Vault/${d}/deep/x.md`), d).toBe(true)
      expect(shouldIgnore(`Vault\\${d}\\x.md`), d).toBe(true)
    }
  })

  it('does not ignore a note whose name merely starts like one of them', () => {
    expect(shouldIgnore('.claude-notes/x.md')).toBe(false)
    expect(shouldIgnore('notes/github-plan.md')).toBe(false)
  })
})
