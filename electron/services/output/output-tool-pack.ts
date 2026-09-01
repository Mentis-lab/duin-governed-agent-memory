// output-tool-pack.ts — DUIN's OUTPUT/ACTUATION native tools ("hands"):
//   • send_email            — GATED. Send an email via Gmail (irreversible external
//                             side effect). requiresApproval:true so an interactive
//                             turn must confirm; a de-privileged inbound turn is
//                             denied at the brain's deny-first exec-token gate
//                             (send_email is in AGUI_GATED_TOOLS → decideAguiGate #1).
//   • export_artifact       — Write a rendered artifact (HTML source) to a standalone
//                             .html or .pdf, returning the path. Reversible local
//                             write, so NOT gated.
//   • generate_audio        — PRODUCE. Synthesize text → a spoken-audio file (mp3/…)
//                             via tts-service, written under userData/artifacts/audio.
//                             Reversible local write (network to the TTS provider,
//                             like image_generate) → NOT gated; flag-gated off until
//                             TTS is enabled + a key/binary is present.
//   • generate_pdf_document — PRODUCE. Render markdown → a clean printable HTML
//                             template → a .pdf deliverable (Chromium printToPDF).
//                             Reversible local write → NOT gated.
//
// Mirrors comms-tool-pack's registerNative shape. Only the IRREVERSIBLE external
// SEND (send_email) is gated; the PRODUCE tools write reversible local files.

import { join } from 'path'
import { mkdirSync } from 'fs'
import { app } from 'electron'
import { toolRegistry } from '../tool-registry'
import { sendGmail } from './gmail-send'
import { exportArtifact, exportArtifactPdf, type ExportFormat } from './artifact-export'
import {
  executeGenerateAudio,
  sanitizeBaseName,
  AUDIO_FORMATS,
  type GenerateAudioArgs
} from './audio-tools'
import { renderMarkdownToPrintHtml } from './document-render'
import {
  generateDocx,
  generateXlsx,
  generatePptx,
  type DocxSpec,
  type XlsxSpec,
  type PptxSpec
} from './doc-generate'
import { messageOf } from '../guarded'

/** Parse a `to`/`cc` field that may be a string (single or comma/;-separated) or
 *  an array into a clean address list. */
function parseAddresses(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
  return String(v ?? '')
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Default export directory under userData when the caller gives no path. */
function exportsDir(): string {
  const dir = join(app.getPath('userData'), 'artifacts', 'exports')
  mkdirSync(dir, { recursive: true })
  return dir
}

// ─────────────────────────── send_email (GATED) ───────────────────────────
toolRegistry.registerNative(
  {
    id: 'send_email',
    name: 'send_email',
    title: 'Send email',
    description:
      'Send an email through the connected Google (Gmail) account. This is an IRREVERSIBLE external action — a sent email cannot be recalled — so it always requires approval. Provide `to` (one address or a comma-separated list), `subject`, and `body`. Set `html:true` to send an HTML body. Attach files (e.g. an exported artifact from export_artifact) by passing their absolute paths in `attachments`.',
    providerKind: 'native',
    providerId: 'internal',
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Recipient email address, or several separated by commas.'
        },
        subject: { type: 'string', description: 'The email subject line.' },
        body: { type: 'string', description: 'The email body (plain text, or HTML when html=true).' },
        html: {
          type: 'boolean',
          description: 'When true, the body is sent as text/html instead of text/plain.'
        },
        cc: { type: 'string', description: 'Optional Cc recipients (comma-separated).' },
        attachments: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional absolute file paths to attach (e.g. a PDF from export_artifact).'
        }
      },
      required: ['to', 'subject', 'body'],
      additionalProperties: false
    },
    // Irreversible external send: destructive (irreversible), network (Gmail API),
    // secret (uses the stored Google token). requiresApproval:true so it always
    // gates through the approval service on a trusted turn; the deny-first
    // exec-token gate covers the de-privileged inbound turn.
    risks: ['destructive', 'network', 'secret'],
    requiresApproval: true,
    enabled: true,
    mutates: true
  },
  async (args) => {
    const to = parseAddresses(args.to)
    if (to.length === 0) return 'Error: at least one recipient (to) is required'
    const subject = String(args.subject ?? '')
    const body = String(args.body ?? '')
    const cc = args.cc !== undefined ? parseAddresses(args.cc) : undefined
    const attachments = Array.isArray(args.attachments)
      ? args.attachments.map((p) => String(p)).filter(Boolean)
      : undefined
    const r = await sendGmail(to, subject, body, {
      html: args.html === true,
      cc,
      attachments
    })
    if (!r.ok) return { result: `Error: ${r.error ?? 'send failed'}`, status: 'error' }
    return {
      result: `Email sent to ${to.join(', ')} (id ${r.id ?? 'unknown'}).`,
      status: 'done'
    }
  }
)

// ─────────────────────────── export_artifact ───────────────────────────
toolRegistry.registerNative(
  {
    id: 'export_artifact',
    name: 'export_artifact',
    title: 'Export artifact (HTML / PDF)',
    description:
      'Export a rendered artifact (HTML source) to a standalone file and return its absolute path. `format:"html"` writes a self-contained .html; `format:"pdf"` renders the HTML in a headless window and prints it to PDF. Pass the full HTML in `html`. Optionally set `path` (absolute) for the output location; otherwise a file is written under the app data exports folder. Use this to produce a shareable file you can then attach to send_email.',
    providerKind: 'native',
    providerId: 'internal',
    inputSchema: {
      type: 'object',
      properties: {
        html: { type: 'string', description: 'The full artifact HTML source to export.' },
        format: {
          type: 'string',
          enum: ['html', 'pdf'],
          description: 'Output format: "html" (self-contained file) or "pdf". Defaults to "html".'
        },
        path: {
          type: 'string',
          description:
            'Optional absolute output path. The correct extension is enforced. When omitted, a file is written under the app exports folder.'
        },
        name: {
          type: 'string',
          description: 'Optional base filename (without extension) used when `path` is omitted.'
        }
      },
      required: ['html'],
      additionalProperties: false
    },
    risks: ['write'],
    requiresApproval: false,
    enabled: true
  },
  async (args) => {
    try {
      const html = String(args.html ?? '')
      if (!html.trim()) return 'Error: html source is required'
      const format: ExportFormat = args.format === 'pdf' ? 'pdf' : 'html'
      let outPath: string
      if (typeof args.path === 'string' && args.path.trim()) {
        outPath = args.path.trim()
      } else {
        const base = String(args.name ?? '').trim() || `artifact-${Date.now().toString(36)}`
        outPath = join(exportsDir(), base)
      }
      const r = await exportArtifact(html, outPath, format)
      if (!r.ok) return { result: `Error: ${r.error ?? 'export failed'}`, status: 'error' }
      return { result: `Exported ${format.toUpperCase()} to ${r.path} (${r.bytes ?? 0} bytes).`, status: 'done' }
    } catch (e) {
      return { result: `Error: ${messageOf(e)}`, status: 'error' }
    }
  }
)

// ─────────────────────────── generate_audio ───────────────────────────
// PRODUCE a spoken-audio file from text. Network (TTS provider) + local write —
// mirrors image_generate's risk profile: reversible output, so NOT an
// AGUI_GATED_TOOLS irreversible-send. requiresApproval stays false; the descriptor
// carries `network` so the risk-based approval routing still applies. Best-effort:
// when TTS is disabled or unconfigured the handler returns an informative Error.
toolRegistry.registerNative(
  {
    id: 'generate_audio',
    name: 'generate_audio',
    title: 'Generate audio (text-to-speech)',
    description:
      'Synthesize spoken audio from text and save it as an audio file, returning the absolute path. Uses the configured TTS provider (OpenAI /audio/speech, or a local edge-tts binary). Requires TTS enabled in Settings (ttsEnabled) plus an OpenAI key or an installed edge-tts. Provide `text`; optionally `voice`, `format` (mp3/wav/opus/aac/flac), and a base `name` for the file. The file is written under the app data artifacts/audio folder.',
    providerKind: 'native',
    providerId: 'internal',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text to speak.' },
        voice: {
          type: 'string',
          description:
            "Optional provider voice id (e.g. 'alloy'/'nova' for OpenAI, 'en-US-AriaNeural' for edge-tts)."
        },
        format: {
          type: 'string',
          enum: [...AUDIO_FORMATS],
          description: 'Output audio container format. Defaults to "mp3".'
        },
        name: {
          type: 'string',
          description: 'Optional base filename (without extension) for the output audio file.'
        }
      },
      required: ['text'],
      additionalProperties: false
    },
    risks: ['network', 'write'],
    requiresApproval: false,
    enabled: true
  },
  async (args) => executeGenerateAudio(args as unknown as GenerateAudioArgs)
)

// ─────────────────────────── generate_pdf_document ───────────────────────────
// PRODUCE a PDF document from markdown/structured content: render → clean printable
// HTML template → Chromium printToPDF. Reversible local write → NOT gated.
toolRegistry.registerNative(
  {
    id: 'generate_pdf_document',
    name: 'generate_pdf_document',
    title: 'Generate PDF document (from markdown)',
    description:
      'Turn markdown / structured text into a clean, printable PDF document and return its absolute path. The markdown is rendered into a styled document template (headings, lists, code, quotes, links) and printed to PDF via the headless artifact engine — no external office tools. Provide `markdown`; optionally a `title` (used as the document heading + filename) and an absolute `path` for the output. When `path` is omitted the file is written under the app data exports folder.',
    providerKind: 'native',
    providerId: 'internal',
    inputSchema: {
      type: 'object',
      properties: {
        markdown: {
          type: 'string',
          description: 'The document content as markdown (headings, lists, bold/italic, code, links).'
        },
        title: {
          type: 'string',
          description: 'Optional document title — used as an <h1> header and the default filename.'
        },
        path: {
          type: 'string',
          description:
            'Optional absolute output path (.pdf enforced). When omitted, a file is written under the app exports folder.'
        }
      },
      required: ['markdown'],
      additionalProperties: false
    },
    risks: ['write'],
    requiresApproval: false,
    enabled: true
  },
  async (args) => {
    try {
      const markdown = String(args.markdown ?? '')
      if (!markdown.trim()) return { result: 'Error: markdown content is required', status: 'error' }
      const title = typeof args.title === 'string' ? args.title.trim() : ''
      const html = renderMarkdownToPrintHtml(markdown, { title })
      let outPath: string
      if (typeof args.path === 'string' && args.path.trim()) {
        outPath = args.path.trim()
      } else {
        const base = sanitizeBaseName(title) || `document-${Date.now().toString(36)}`
        outPath = join(exportsDir(), base)
      }
      const r = await exportArtifactPdf(html, outPath)
      if (!r.ok) return { result: `Error: ${r.error ?? 'pdf generation failed'}`, status: 'error' }
      return { result: `Generated PDF document at ${r.path} (${r.bytes ?? 0} bytes).`, status: 'done' }
    } catch (e) {
      return { result: `Error: ${messageOf(e)}`, status: 'error' }
    }
  }
)

// ─────── generate_docx / generate_xlsx / generate_pptx (office suite, PRODUCE) ───────
// PRODUCE tools: transform a structured spec → a real Office file under
// userData/artifacts/docs via docx / exceljs / pptxgenjs. Reversible LOCAL writes
// (same posture as generate_pdf_document) → NOT in AGUI_GATED_TOOLS, requiresApproval
// false. Deliver the returned path via export/send_email attachments.

// Reusable JSON-schema fragment for an optional absolute output path.
const OUT_PATH_PROP = {
  path: {
    type: 'string',
    description:
      'Optional absolute output path. When omitted, a file is written under the app data artifacts/docs folder.'
  }
} as const

toolRegistry.registerNative(
  {
    id: 'generate_docx',
    name: 'generate_docx',
    title: 'Generate Word document (.docx)',
    description:
      'Produce a Microsoft Word (.docx) document from a structured spec and return its absolute path. Provide `blocks`: an ordered list where each block is a heading ({type:"heading", level:1-6, text}), a paragraph ({type:"paragraph", text, bold?}), or a table ({type:"table", rows:[[...]], header?:true}). Optional `title` sets a document title heading. The file is written under the app data docs folder; deliver it by attaching to send_email.',
    providerKind: 'native',
    providerId: 'internal',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Optional document title (top heading + default filename).' },
        blocks: {
          type: 'array',
          description: 'Ordered document blocks (headings, paragraphs, tables).',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['heading', 'paragraph', 'table'] },
              text: { type: 'string', description: 'Text for heading/paragraph blocks.' },
              level: { type: 'number', description: 'Heading level 1-6 (heading blocks).' },
              bold: { type: 'boolean', description: 'Bold the heading/paragraph text.' },
              rows: {
                type: 'array',
                description: 'Table cell grid (rows × cols) for table blocks.',
                items: { type: 'array', items: { type: 'string' } }
              },
              header: { type: 'boolean', description: 'Treat the first table row as a bold header.' }
            },
            required: ['type'],
            additionalProperties: false
          }
        },
        ...OUT_PATH_PROP
      },
      required: ['blocks'],
      additionalProperties: false
    },
    risks: ['write'],
    requiresApproval: false,
    enabled: true
  },
  async (args) => {
    try {
      const spec = { title: args.title, blocks: args.blocks } as unknown as DocxSpec
      const r = await generateDocx(spec, typeof args.path === 'string' ? args.path : undefined)
      if (!r.ok) return { result: `Error: ${r.error ?? 'docx generation failed'}`, status: 'error' }
      return { result: `Generated Word document at ${r.path} (${r.bytes ?? 0} bytes).`, status: 'done' }
    } catch (e) {
      return { result: `Error: ${messageOf(e)}`, status: 'error' }
    }
  }
)

toolRegistry.registerNative(
  {
    id: 'generate_xlsx',
    name: 'generate_xlsx',
    title: 'Generate Excel spreadsheet (.xlsx)',
    description:
      'Produce a Microsoft Excel (.xlsx) workbook from a structured spec and return its absolute path. Provide `sheets`: a list of {name?, columns?:[headers], rows:[[cells]]}. A cell may be a string, number, boolean, or a formula object {formula:"SUM(A1:A3)"}. If the Excel library is unavailable, a .csv of the first sheet is written as a fallback. The file is written under the app data docs folder.',
    providerKind: 'native',
    providerId: 'internal',
    inputSchema: {
      type: 'object',
      properties: {
        sheets: {
          type: 'array',
          description: 'Worksheets to write.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Worksheet name (≤31 chars).' },
              columns: {
                type: 'array',
                description: 'Optional bold header row.',
                items: { type: 'string' }
              },
              rows: {
                type: 'array',
                description: 'Data rows; each cell is a string/number/boolean or {formula}.',
                items: { type: 'array' }
              }
            },
            additionalProperties: false
          }
        },
        ...OUT_PATH_PROP
      },
      required: ['sheets'],
      additionalProperties: false
    },
    risks: ['write'],
    requiresApproval: false,
    enabled: true
  },
  async (args) => {
    try {
      const spec = { sheets: args.sheets } as unknown as XlsxSpec
      const r = await generateXlsx(spec, typeof args.path === 'string' ? args.path : undefined)
      if (!r.ok) return { result: `Error: ${r.error ?? 'xlsx generation failed'}`, status: 'error' }
      const note = r.format === 'csv' ? ' (CSV fallback — Excel library unavailable)' : ''
      return { result: `Generated spreadsheet at ${r.path} (${r.bytes ?? 0} bytes)${note}.`, status: 'done' }
    } catch (e) {
      return { result: `Error: ${messageOf(e)}`, status: 'error' }
    }
  }
)

toolRegistry.registerNative(
  {
    id: 'generate_pptx',
    name: 'generate_pptx',
    title: 'Generate PowerPoint deck (.pptx)',
    description:
      'Produce a Microsoft PowerPoint (.pptx) presentation from a structured spec and return its absolute path. Provide `slides`: a list of {title?, bullets?:[lines], body?}. Optional top-level `title` sets deck metadata. The file is written under the app data docs folder; deliver it by attaching to send_email.',
    providerKind: 'native',
    providerId: 'internal',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Optional presentation title (deck metadata).' },
        slides: {
          type: 'array',
          description: 'Slides to render.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Slide title.' },
              bullets: {
                type: 'array',
                description: 'Bulleted body lines.',
                items: { type: 'string' }
              },
              body: { type: 'string', description: 'Optional free-text body under the bullets.' }
            },
            additionalProperties: false
          }
        },
        ...OUT_PATH_PROP
      },
      required: ['slides'],
      additionalProperties: false
    },
    risks: ['write'],
    requiresApproval: false,
    enabled: true
  },
  async (args) => {
    try {
      const spec = { title: args.title, slides: args.slides } as unknown as PptxSpec
      const r = await generatePptx(spec, typeof args.path === 'string' ? args.path : undefined)
      if (!r.ok) return { result: `Error: ${r.error ?? 'pptx generation failed'}`, status: 'error' }
      return { result: `Generated PowerPoint deck at ${r.path} (${r.bytes ?? 0} bytes).`, status: 'done' }
    } catch (e) {
      return { result: `Error: ${messageOf(e)}`, status: 'error' }
    }
  }
)
