import { readFile } from 'fs/promises'
import { basename } from 'path'
import { canvasToOutline, parseCanvas } from '../../canvas/canvas-outline'

// JSON Canvas (.canvas) → the outline an agent can read.
//
// Before this loader, `.canvas` hit the "Unsupported document extension" throw
// in loaders/index.ts, so blueprints drawn in Obsidian were invisible to
// retrieval. Indexing the raw JSON instead would be worse than absent: node
// ids, colours and pixel coordinates would dominate every chunk and the actual
// content — block labels, connection labels, referenced notes — would be buried.
//
// The translation lives in services/canvas/canvas-outline.ts rather than here
// because the SAME text is what an agent should receive when it is handed a
// blueprint to follow. One serializer, two consumers.

export interface LoadedCanvas {
  text: string
  mime: string
}

/** jsoncanvas.org registers no IANA media type; `application/json` with the
 *  extension preserved on disk is the honest description. */
const CANVAS_MIME = 'application/json'

export function isCanvasExtension(path: string): boolean {
  return path.toLowerCase().endsWith('.canvas')
}

export async function loadCanvas(path: string): Promise<LoadedCanvas> {
  const raw = await readFile(path, 'utf-8')
  // A malformed canvas is a real ingest error the UI should surface — unlike a
  // malformed NODE, which parseCanvas tolerates. Re-thrown with the filename so
  // the failure names the file rather than just "Not valid JSON".
  let text: string
  try {
    const doc = parseCanvas(raw)
    text = canvasToOutline(doc, { title: basename(path) })
  } catch (err) {
    throw new Error(`Could not read canvas ${basename(path)}: ${(err as Error).message}`, {
      cause: err
    })
  }
  return { text, mime: CANVAS_MIME }
}
