import { describe, it, expect, vi } from 'vitest'
import {
  buildDriveMetadata,
  buildMultipartRelatedBody,
  driveMimeForName,
  uploadDriveFile
} from './gdrive-write'
import type { FetchLike } from './gcal-write'

// Pure multipart-shaping + mocked-fetch tests. No live token: `token`/`fetchFn` injected.

describe('buildDriveMetadata', () => {
  it('includes name + optional mimeType/parents/description, dropping empties', () => {
    expect(buildDriveMetadata({ name: 'a.txt' })).toEqual({ name: 'a.txt' })
    expect(
      buildDriveMetadata({ name: 'a.txt', mimeType: 'text/plain', parents: ['fld1', ' '], description: 'd' })
    ).toEqual({ name: 'a.txt', mimeType: 'text/plain', description: 'd', parents: ['fld1'] })
  })
})

describe('driveMimeForName', () => {
  it('maps known extensions and defaults to text/plain', () => {
    expect(driveMimeForName('r.pdf')).toBe('application/pdf')
    expect(driveMimeForName('p.HTML')).toBe('text/html')
    expect(driveMimeForName('x.unknown')).toBe('text/plain')
  })
})

describe('buildMultipartRelatedBody', () => {
  const { body, boundary, contentType } = buildMultipartRelatedBody(
    { name: 'note.txt', mimeType: 'text/plain' },
    'hello world',
    'text/plain',
    'BND'
  )
  it('declares multipart/related with the pinned boundary', () => {
    expect(contentType).toBe('multipart/related; boundary=BND')
    expect(boundary).toBe('BND')
  })
  it('has a JSON metadata part then a base64 media part, closed by the terminal boundary', () => {
    expect(body).toContain('--BND\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"name":"note.txt","mimeType":"text/plain"}')
    expect(body).toContain('Content-Transfer-Encoding: base64')
    expect(body).toContain(Buffer.from('hello world', 'utf8').toString('base64'))
    expect(body.endsWith('--BND--')).toBe(true)
  })
  it('base64-encodes raw Buffer media intact', () => {
    const bytes = Buffer.from([0xff, 0x00, 0x10])
    const { body: b } = buildMultipartRelatedBody({ name: 'x.bin' }, bytes, 'application/octet-stream', 'BX')
    expect(b).toContain(bytes.toString('base64'))
  })
  it('strips CR/LF from the media type so it cannot inject an extra MIME part or header', () => {
    const { body: b } = buildMultipartRelatedBody(
      { name: 'x.txt' },
      'hi',
      'text/plain\r\n\r\nInjected body\r\n--BX\r\nContent-Type: evil',
      'BX'
    )
    // No CRLF from the media type survives → nothing can start its own header line or
    // open a rogue body part. The whole tainted value collapses onto one line.
    expect(b).not.toMatch(/\r\nContent-Type: evil/)
    expect(b).not.toMatch(/\r\n\r\nInjected body/)
    expect(b).toContain('Content-Type: text/plainInjected body--BXContent-Type: evil\r\n')
  })
})

describe('uploadDriveFile — POST assembly', () => {
  it('POSTs the multipart body with the bearer + multipart/related content-type', async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ id: 'f1', name: 'note.txt', webViewLink: 'https://drive/f1' })
      })
    ) as unknown as FetchLike
    const r = await uploadDriveFile({ name: 'note.txt', content: 'hi' }, { token: 'TOK', fetchFn })
    expect(r).toEqual({ ok: true, id: 'f1', name: 'note.txt', webViewLink: 'https://drive/f1' })
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toContain('uploadType=multipart')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer TOK')
    expect(init.headers['Content-Type']).toMatch(/^multipart\/related; boundary=/)
    expect(init.body).toContain(Buffer.from('hi', 'utf8').toString('base64'))
  })
  it('requires a name', async () => {
    const r = await uploadDriveFile({ name: '', content: 'x' }, { token: 'T' })
    expect(r.ok).toBe(false)
  })
  it('surfaces an HTTP error body', async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve({ ok: false, status: 401, text: async () => 'unauthorized', json: async () => ({}) })
    ) as unknown as FetchLike
    const r = await uploadDriveFile({ name: 'a.txt', content: 'x' }, { token: 'T', fetchFn })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('401')
  })
})
