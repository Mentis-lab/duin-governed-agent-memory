// Re-index must re-derive a document IN PLACE — one row, one copy of its chunks.
//
// The bug this pins: the reingest handler set chunk_count = 0 and status =
// 'queued' but never dropped the chunks, so the old passages stayed live in
// rag_chunks / the FTS mirror / rag_chunk_vec. That made the defect invisible —
// the Library looked reset while the stale text was still fully searchable.
// Worse, the hash dedupe in runOneFile only short-circuits on status 'ready',
// so moving the row to 'queued' guaranteed the miss: insertDocument forked a
// SECOND document row holding a duplicate copy of every chunk (N reingests = N
// copies in retrieval), and the original row was stranded at 'queued' forever
// because resetInterruptedDocuments only rescues loading/chunking/embedding.
//
// This drives the REAL production path — the registered 'rag:document:reingest'
// IPC handler, the same one the Library's Re-index button reaches through
// rag-store.reingestDocument → preload. Testing IngestManager alone would prove
// the orchestrator reuses a row but not that the handler actually asks it to,
// which is precisely the wiring that was missing.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const ipcRegistered: Map<string, (...args: any[]) => any> = new Map()

vi.mock('electron', () => ({
  // Unlike the sibling rag.test.ts this must NOT throw: ensureIngestWired()
  // calls app.getPath('userData') before it can build the manager, and a throw
  // there would make the handler return an error instead of ingesting.
  app: { getPath: () => tmpdir() },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => any) => {
      ipcRegistered.set(channel, handler)
    }
  }
}))

// Deterministic fake embedder — the orchestrator's only contract is
// "vectors.length === chunks.length", so this keeps ONNX out of the test.
vi.mock('../services/rag/embeddings/service', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../services/rag/embeddings/service')>()
  return {
    ...actual,
    getEmbeddingsService: () => ({
      // Ingest embeds in the COLLECTION's space, so the stub must answer
      // embedWith too; the vectors themselves are irrelevant here.
      embedWith(_id: string, texts: string[]): Promise<Float32Array[]> {
        return this.embed(texts)
      },
      async embed(texts: string[]): Promise<Float32Array[]> {
        return texts.map((t) => {
          const v = new Float32Array(384)
          for (let i = 0; i < t.length; i++) v[i % 384] += t.charCodeAt(i) / 1000
          return v
        })
      }
    })
  }
})

// The sidecar bridge writes into the user's vault on every 'ready'. Not under
// test here, and we don't want the filesystem side effect.
vi.mock('../services/library-brain-bridge', () => ({
  writeLibrarySidecar: () => undefined
}))

import {
  __forceMemoryFallback as forceCollectionMemory,
  __peekMemoryChunks,
  __resetCollectionStore,
  createCollection,
  listDocuments
} from '../services/rag/store'
import {
  __forceMemoryFallback as forceEventMemory,
  __resetEventLog
} from '../services/event-log'
import { __resetIngestManager } from '../services/rag/ingest'
import { registerRagHandlers } from './rag'

let tmp: string

beforeEach(() => {
  __resetEventLog()
  forceEventMemory()
  __resetCollectionStore()
  forceCollectionMemory()
  __resetIngestManager()
  ipcRegistered.clear()
  registerRagHandlers()
  tmp = mkdtempSync(join(tmpdir(), 'rag-reingest-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function waitFor<T>(predicate: () => T | null | undefined, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const probe = (): void => {
      const v = predicate()
      if (v) return resolve(v)
      if (Date.now() - startedAt > timeoutMs) {
        return reject(new Error('waitFor: timed out'))
      }
      setTimeout(probe, 10)
    }
    probe()
  })
}

// Body has to clear the chunker's MIN_CHUNK_CHARS floor, or the doc lands at
// 'ready' with chunk_count 0 ('no extractable content') and indexes nothing.
// `animal` is the marker we track across the re-derive.
function note(animal: string): string {
  return (
    `# Field Notes\n\n` +
    `The observed herd of ${animal} crossed the river at dawn and grazed ` +
    `along the eastern bank for most of the morning. Several juveniles ` +
    `trailed the main group. Weather was clear, visibility excellent, and ` +
    `the ${animal} showed no sign of distress at the observers' distance.\n\n` +
    `## Afternoon\n\n` +
    `By midday the ${animal} had moved into the treeline, where counting ` +
    `became unreliable. The survey resumed the following morning with a ` +
    `second pass along the same transect to confirm the population estimate.\n`
  )
}

describe('rag:document:reingest — re-derives in place', () => {
  it('replaces the document\'s chunks instead of forking a second row', async () => {
    const collection = createCollection({
      name: 'Library',
      embedderId: 'bge-small-en-v1.5'
    })
    // Seed via .txt, not .md: markdown is now excluded from Library ingest
    // (it belongs in the Brain), so a .md seed would be skipped and never
    // create the row this test re-derives. The reingest-in-place wiring under
    // test is format-agnostic — .txt exercises the same loadText → chunk path.
    const file = join(tmp, 'note.txt')
    writeFileSync(file, note('zebras'), 'utf-8')

    const ingest = ipcRegistered.get('rag:document:ingest')!
    const reingest = ipcRegistered.get('rag:document:reingest')!

    const first = await ingest(null, collection.id, [{ path: file, name: 'note.txt' }])
    expect(first.success).toBe(true)

    const original = await waitFor(() =>
      listDocuments(collection.id).find((d) => d.status === 'ready')
    )
    expect(original.chunkCount).toBeGreaterThan(0)

    // The file changes on disk — the ordinary reason to hit Re-index, and the
    // case that forked a row, since the new hash cannot match the old one.
    writeFileSync(file, note('giraffes'), 'utf-8')

    const res = await reingest(null, original.id)
    expect(res.success).toBe(true)

    // Wait for the re-derive to land the new content ANYWHERE, so the
    // assertions below report what actually went wrong (a forked row) rather
    // than merely timing out waiting on the row that got stranded.
    await waitFor(() =>
      __peekMemoryChunks().some((c) => c.text.includes('giraffes')) || null
    )

    // One row, not two: the old row is neither duplicated nor stranded.
    const docs = listDocuments(collection.id)
    expect(docs).toHaveLength(1)
    expect(docs[0].id).toBe(original.id)
    expect(docs.some((d) => d.status === 'queued')).toBe(false)

    // …and it finished, rather than sitting at 'queued' forever with its
    // chunks still live (resetInterruptedDocuments would never rescue it).
    const after = await waitFor(() => {
      const d = listDocuments(collection.id).find((x) => x.id === original.id)
      return d && d.status === 'ready' ? d : null
    })

    // One copy of the content — every surviving chunk belongs to this row, and
    // the count matches what the row advertises.
    const chunks = __peekMemoryChunks().filter((c) => c.collectionId === collection.id)
    expect(chunks.every((c) => c.documentId === original.id)).toBe(true)
    expect(chunks).toHaveLength(after.chunkCount)

    // The pre-edit text is genuinely gone from the index, not merely uncounted.
    const allText = chunks.map((c) => c.text).join('\n')
    expect(allText).toContain('giraffes')
    expect(allText).not.toContain('zebras')
  })
})
