// artifact-export.ts — turn a rendered artifact (HTML source) into a deliverable
// FILE: a standalone self-contained `.html`, or a `.pdf` produced by loading the
// same HTML into a headless artifact-sandbox BrowserWindow and calling
// webContents.printToPDF (no new PDF library — Chromium's own print pipeline).
//
// Reuse: the HTML is wrapped with the SAME `buildHtmlDoc` the artifact panel uses
// (artifact-sandbox), so an exported file renders byte-identically to the preview.
//
// Electron is imported LAZILY inside the functions that need it, so the pure path-
// shaping helper (`resolveExportPath`) — and this module's import — stay usable in
// a node-only unit test without mocking electron. The PDF path can only run inside
// the Electron main process (headless BrowserWindow + printToPDF); it is flagged
// human-verify because that runtime is not exercisable here.

import { extname, normalize } from 'path'
import { writeFileSync } from 'fs'
import { assertNotOverwriting } from '../path-jail'
import { messageOf } from '../guarded'

export type ExportFormat = 'html' | 'pdf'

export interface ExportResult {
  ok: boolean
  path?: string
  bytes?: number
  error?: string
}

const HTML_EXTS = new Set(['.html', '.htm'])

/**
 * Shape a caller-supplied output path for `format`: require a non-empty path and
 * normalize its extension to `.html` / `.pdf` (swapping an html↔pdf mismatch,
 * appending when absent). PURE — no filesystem, no electron. This is the unit-
 * tested seam.
 */
export function resolveExportPath(
  rawPath: string,
  format: ExportFormat
): { ok: true; path: string } | { ok: false; error: string } {
  const p = String(rawPath ?? '').trim()
  if (!p) return { ok: false, error: 'an output path is required' }
  const want = format === 'pdf' ? '.pdf' : '.html'
  const cur = extname(p).toLowerCase()
  let out: string
  if (cur === want) out = p
  else if (cur === '.pdf' || HTML_EXTS.has(cur)) out = p.slice(0, -cur.length) + want
  else out = p + want
  return { ok: true, path: normalize(out) }
}

/** True when `html` already looks like a full standalone document. */
export function isFullHtmlDocument(html: string): boolean {
  return /<html[\s>]/i.test(html) || /<!doctype/i.test(html)
}

/** Wrap a fragment into a full self-contained document via the shared artifact
 *  wrapper; pass a full document through unchanged. Electron-lazy (buildHtmlDoc
 *  lives in the electron-importing artifact-sandbox module). */
async function toStandaloneHtml(html: string): Promise<string> {
  if (isFullHtmlDocument(html)) return html
  const { buildHtmlDoc } = await import('../artifact-sandbox')
  return buildHtmlDoc('html', html)
}

/**
 * Write the artifact HTML as a standalone `.html` file. Reversible local write.
 * Returns the resolved absolute-ish path and byte count.
 */
export async function exportArtifactHtml(html: string, outPath: string): Promise<ExportResult> {
  const resolved = resolveExportPath(outPath, 'html')
  if (!resolved.ok) return { ok: false, error: resolved.error }
  try {
    const doc = await toStandaloneHtml(String(html ?? ''))
    assertNotOverwriting(resolved.path, 'export_artifact')
    writeFileSync(resolved.path, doc, 'utf-8')
    return { ok: true, path: resolved.path, bytes: Buffer.byteLength(doc, 'utf8') }
  } catch (e) {
    return { ok: false, error: `html export failed: ${messageOf(e)}` }
  }
}

/**
 * Render the artifact HTML in a headless sandboxed BrowserWindow and export it to a
 * `.pdf` via Chromium's printToPDF. Requires the Electron main process. Never
 * throws — resolves a structured result. HUMAN-VERIFY: the printToPDF path is only
 * exercisable inside a live Electron runtime.
 */
export async function exportArtifactPdf(html: string, outPath: string): Promise<ExportResult> {
  const resolved = resolveExportPath(outPath, 'pdf')
  if (!resolved.ok) return { ok: false, error: resolved.error }

  let electron: typeof import('electron')
  try {
    electron = await import('electron')
  } catch (e) {
    return { ok: false, error: `pdf export needs the Electron main process: ${messageOf(e)}` }
  }
  const { BrowserWindow, app } = electron
  if (!BrowserWindow || !app?.getPath) {
    return { ok: false, error: 'pdf export must run in the Electron main process' }
  }

  const { join } = await import('path')
  const { writeFileSync: writeFile, unlinkSync } = await import('fs')
  const { randomUUID } = await import('crypto')

  let win: import('electron').BrowserWindow | null = null
  let tempPath: string | null = null
  try {
    const doc = await toStandaloneHtml(String(html ?? ''))
    tempPath = join(app.getPath('temp'), `duin-artifact-pdf-${randomUUID().slice(0, 8)}.html`)
    writeFile(tempPath, doc, 'utf-8')

    win = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        allowRunningInsecureContent: false,
        webSecurity: true
      }
    })
    await win.webContents.loadFile(tempPath)
    // Let late-rendering content (mermaid/JSX) settle before capture.
    await new Promise<void>((r) => setTimeout(r, 400))
    const pdf = await win.webContents.printToPDF({ printBackground: true })
    assertNotOverwriting(resolved.path, 'export_artifact')
    writeFile(resolved.path, pdf)
    return { ok: true, path: resolved.path, bytes: pdf.length }
  } catch (e) {
    return { ok: false, error: `pdf export failed: ${messageOf(e)}` }
  } finally {
    try {
      win?.destroy()
    } catch (e) {
      console.debug('[artifact-export] window teardown best-effort:', messageOf(e))
    }
    if (tempPath) {
      try {
        unlinkSync(tempPath)
      } catch (e) {
        console.debug('[artifact-export] temp cleanup best-effort:', messageOf(e))
      }
    }
  }
}

/** Dispatch to the html / pdf exporter by format. */
export async function exportArtifact(
  html: string,
  outPath: string,
  format: ExportFormat
): Promise<ExportResult> {
  return format === 'pdf' ? exportArtifactPdf(html, outPath) : exportArtifactHtml(html, outPath)
}
