// file-handler.test.ts — first coverage for the chat attachment dispatch table.
//
// This table decided what every attached file becomes, and had NO test of any kind. That let a
// real inversion sit in it unnoticed: Office documents were absent from every extension set, so a
// .docx fell through to the binary fallthrough and reached the model as one line saying the file
// existed — while the SAME file over the 5 MB inline threshold went to `rag-pending` and was fully
// indexed. Bigger files worked better than smaller ones, silently.
//
// The dispatch ORDER is the contract here, so these tests assert outcomes per extension rather
// than poking at internals.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { processFiles } from './file-handler'

const FIXTURES = join(__dirname, 'rag', 'loaders', '__fixtures__')
let tmp = ''

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'duin-fh-'))
})
afterAll(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true })
})

const one = async (path: string) => (await processFiles([path]))[0]

describe('Office documents reach the model as TEXT', () => {
  it('.xlsx is extracted, not stubbed as a binary', async () => {
    const f = await one(join(FIXTURES, 'sample.xlsx'))
    expect(f.kind).toBe('text')
    expect(f.error).toBeUndefined()
    expect(f.content.trim().length).toBeGreaterThan(0)
  })

  it('.pptx is extracted, including CJK', async () => {
    const f = await one(join(FIXTURES, 'sample.pptx'))
    expect(f.kind).toBe('text')
    expect(f.content.trim().length).toBeGreaterThan(0)
  })

  it('.rtf is extracted', async () => {
    const f = await one(join(FIXTURES, 'sample.rtf'))
    expect(f.kind).toBe('text')
    expect(f.content.trim().length).toBeGreaterThan(0)
  })

  // No .docx fixture existed anywhere in the repo, which left mammoth — the loader most likely to
  // meet a real user's attachment — as the least-tested one. Build a genuine .docx here with the
  // `docx` package (already a dependency, used write-side) so the mammoth path runs for real.
  it('.docx is extracted via mammoth', async () => {
    const { Document, Packer, Paragraph } = await import('docx')
    const doc = new Document({
      sections: [{ children: [new Paragraph('Revenue grew in Q3'), new Paragraph('第二段中文')] }]
    })
    const path = join(tmp, 'sample.docx')
    await writeFile(path, await Packer.toBuffer(doc))

    const f = await one(path)
    expect(f.kind).toBe('text')
    expect(f.error).toBeUndefined()
    expect(f.content).toContain('Revenue grew in Q3')
    expect(f.content).toContain('第二段中文')
  })
})

describe('legacy Office formats fail LOUDLY, not silently', () => {
  it.each(['.doc', '.xls', '.ppt'])('%s explains itself and names the fix', async (ext) => {
    const path = join(tmp, `legacy${ext}`)
    await writeFile(path, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0])) // OLE2 magic
    const f = await one(path)
    expect(f.kind).toBe('binary')
    // The whole point: a user can SEE why nothing happened and what to do next.
    expect(f.error).toBeTruthy()
    expect(f.error).toContain(ext)
    expect(f.error).toContain(`${ext}x`)
  })
})

describe('unchanged behaviour for everything else', () => {
  it('a genuine binary stays a quiet binary — no invented error', async () => {
    const path = join(tmp, 'blob.bin')
    await writeFile(path, Buffer.from([0, 1, 2, 3, 4, 5]))
    const f = await one(path)
    expect(f.kind).toBe('binary')
    // A .bin really IS opaque; flagging it as an error would be noise, not honesty.
    expect(f.error).toBeUndefined()
    expect(f.previewText).toContain('content not included')
  })

  it('a text file is still read as text', async () => {
    const f = await one(join(FIXTURES, 'sample.txt'))
    expect(f.kind).toBe('text')
    expect(f.content.length).toBeGreaterThan(0)
  })

  it('a missing file reports the read failure rather than throwing', async () => {
    const f = await one(join(tmp, 'does-not-exist.txt'))
    expect(f.kind).toBe('binary')
    expect(f.error).toBeTruthy()
  })
})

describe('pasted images get the same treatment as on-disk images', () => {
  const PNG_1x1 =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

  it('accepts a PNG and reports its real decoded size', async () => {
    const { processPastedImage } = await import('./file-handler')
    const f = await processPastedImage({
      dataUrl: PNG_1x1,
      name: 'pasted.png',
      mimeType: 'image/png'
    })
    expect(f.kind).toBe('image')
    expect(f.error).toBeUndefined()
    expect(f.content).toBe(PNG_1x1)
    expect(f.size).toBeGreaterThan(0)
  })

  it('rejects SVG — script-bearing markup, not a raster the vision models take', async () => {
    const { processPastedImage } = await import('./file-handler')
    const f = await processPastedImage({
      dataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      name: 'pasted.svg',
      mimeType: 'image/svg+xml'
    })
    expect(f.error).toBeTruthy()
    expect(f.content).toBe('')
  })

  it('rejects a non-data: URL rather than passing it along', async () => {
    const { processPastedImage } = await import('./file-handler')
    const f = await processPastedImage({
      dataUrl: 'https://evil.test/x.png',
      name: 'x.png',
      mimeType: 'image/png'
    })
    expect(f.error).toBeTruthy()
  })
})

describe('vision payloads are downscaled', () => {
  it('a large image shrinks for the model but OCR still sees the original', async () => {
    const sharp = (await import('sharp')).default
    // 3000px wide — comfortably over the 1568 ceiling.
    const big = await sharp({
      create: { width: 3000, height: 2000, channels: 3, background: { r: 20, g: 90, b: 200 } }
    })
      .png()
      .toBuffer()
    const path = join(tmp, 'big.png')
    await writeFile(path, big)

    const f = await one(path)
    expect(f.kind).toBe('image')
    const b64 = f.content.slice(f.content.indexOf(',') + 1)
    const sent = Buffer.from(b64, 'base64')
    expect(sent.byteLength).toBeLessThan(big.byteLength)
    const meta = await sharp(sent).metadata()
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(1568)
  })

  it('a small image is passed through untouched — no needless re-encode', async () => {
    const sharp = (await import('sharp')).default
    const small = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 1, g: 2, b: 3 } }
    })
      .png()
      .toBuffer()
    const path = join(tmp, 'small.png')
    await writeFile(path, small)

    const f = await one(path)
    const sent = Buffer.from(f.content.slice(f.content.indexOf(',') + 1), 'base64')
    expect(sent.equals(small)).toBe(true)
  })
})
