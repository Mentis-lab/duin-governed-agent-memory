// feishu-write.ts — DUIN's "hands" for Feishu/Lark WRITE via the `lark-cli` subprocess
// (user identity), through the injected `Exec` seam (lark-exec.larkExec) so the
// deterministic ARG-SHAPING is unit-testable without spawning anything. Three writes:
//
//   • create a doc        → `drive +import` a markdown file into a new docx
//   • append a Base record→ `base +record-create` a record into a Bitable table
//   • create a cal event  → `calendar +event-create` on a Feishu calendar
//
// CONSEQUENCE TIER (set where the tools register, act-tool-pack.ts): create-doc and
// add-record are write-reversible (removable/editable afterwards); a Feishu calendar
// event create is likewise write-reversible.
//
// HUMAN-VERIFY (rule 5 — binary path, cannot run lark-cli here): the CLI *verbs/flags*
// below follow the established `<resource> +<verb> --flag value` convention (see the
// im +messages-send precedent in feishu-comms-native.ts and the lark-cli reference),
// but the exact subcommand names for docx-import / base record-create / calendar
// event-create are NOT executed in this worktree. The arg SHAPE is what's tested; the
// live invocation must be verified against the installed lark-cli. Content that could
// carry cmd.exe metacharacters (`& | < >`) is routed through a temp file + `@path`
// (the same trick the lark-doc reference uses) rather than an inline flced flag.

import { writeFileSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Exec, ExecResult } from '../brain/feishu-comms-native'
import { larkExec } from '../lark-exec'
import { messageOf } from '../guarded'

export interface FeishuWriteResult {
  ok: boolean
  /** Token/id of the created resource on success (doc token, record id, event id). */
  id?: string
  /** A short human preview / URL when the CLI returns one. */
  info?: string
  error?: string
}

// ──────────────────── pure arg builders ────────────────────

/** Build args to import a local markdown file as a new Feishu docx. `@`-file form
 *  keeps table pipes / metachars out of the shelled-out command line. PURE. */
export function buildCreateDocArgs(opts: { filePath: string; title?: string; type?: string; folderToken?: string }): string[] {
  const args = ['drive', '+import', '--file', opts.filePath, '--type', opts.type ?? 'docx']
  if (opts.title) args.push('--title', opts.title)
  if (opts.folderToken) args.push('--folder-token', opts.folderToken)
  return args
}

/** Build args to create a record in a Bitable table. `fieldsFile` is a temp JSON
 *  file referenced with `@` so arbitrary field values never hit the shell. PURE. */
export function buildBaseRecordArgs(opts: { appToken: string; tableId: string; fieldsFile: string }): string[] {
  return [
    'base',
    '+record-create',
    '--app-token',
    opts.appToken,
    '--table-id',
    opts.tableId,
    '--fields',
    `@${opts.fieldsFile}`
  ]
}

/** Build args to create a Feishu calendar event. Times are RFC3339 or unix seconds
 *  per the Feishu calendar API; the connector passes them through. PURE. */
export function buildCalendarEventArgs(opts: {
  calendarId?: string
  summary: string
  start: string
  end: string
  description?: string
}): string[] {
  const args = [
    'calendar',
    '+event-create',
    '--calendar-id',
    opts.calendarId ?? 'primary',
    '--summary',
    opts.summary,
    '--start-time',
    opts.start,
    '--end-time',
    opts.end
  ]
  if (opts.description) args.push('--description', opts.description)
  return args
}

// ──────────────────── result parsing ────────────────────

/** Interpret a lark-cli ExecResult into a FeishuWriteResult. lark-cli prints a JSON
 *  envelope on stdout; a non-zero exit or an `error` field is a failure. PURE. */
export function parseLarkResult(r: ExecResult): FeishuWriteResult {
  if (r.code !== 0 && !r.stdout.trim()) {
    return { ok: false, error: (r.stderr || 'lark-cli failed').slice(0, 300) }
  }
  let out: Record<string, unknown>
  try {
    out = JSON.parse(r.stdout || '{}') as Record<string, unknown>
  } catch {
    // Not JSON — treat a zero exit as success with the raw text as info.
    return r.code === 0
      ? { ok: true, info: (r.stdout || '').slice(0, 200) }
      : { ok: false, error: (r.stderr || r.stdout || 'lark-cli failed').slice(0, 300) }
  }
  const err = out.error
  if (err) {
    const msg = typeof err === 'object' ? String((err as Record<string, unknown>).message ?? JSON.stringify(err)) : String(err)
    return { ok: false, error: msg.slice(0, 300) }
  }
  const data = (out.data ?? out) as Record<string, unknown>
  const id =
    (data.document_id as string) ??
    (data.doc_token as string) ??
    (data.token as string) ??
    (data.record_id as string) ??
    (data.event_id as string) ??
    ((data.record as Record<string, unknown>)?.record_id as string) ??
    ((data.event as Record<string, unknown>)?.event_id as string) ??
    undefined
  const url = (data.url as string) ?? (data.doc_url as string) ?? undefined
  return { ok: out.ok !== false, id, info: url }
}

// ──────────────────── temp-file helper ────────────────────

/** Write `content` to a fresh temp file and return its path. Used to keep table
 *  pipes / metachars out of the shelled-out lark-cli command line. */
function writeTemp(content: string, ext: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'duin-feishu-'))
  const p = join(dir, `payload.${ext}`)
  writeFileSync(p, content, 'utf8')
  return p
}

// ──────────────────── runners ────────────────────

export interface FeishuExecDeps {
  /** Injected exec (tests). Defaults to the real larkExec subprocess. */
  exec?: Exec
}

async function runLark(args: string[], deps: FeishuExecDeps): Promise<FeishuWriteResult> {
  const exec = deps.exec ?? larkExec()
  let r: ExecResult
  try {
    r = await exec(args)
  } catch (e) {
    return { ok: false, error: `lark-cli invocation failed: ${messageOf(e)}` }
  }
  return parseLarkResult(r)
}

/** Create a Feishu doc from markdown content (write-reversible). */
export async function feishuCreateDoc(
  opts: { title: string; markdown: string; folderToken?: string },
  deps: FeishuExecDeps = {}
): Promise<FeishuWriteResult> {
  if (!opts.markdown?.trim()) return { ok: false, error: 'doc content (markdown) is required' }
  let filePath: string
  try {
    filePath = writeTemp(opts.markdown, 'md')
  } catch (e) {
    return { ok: false, error: `could not stage doc content: ${messageOf(e)}` }
  }
  return runLark(buildCreateDocArgs({ filePath, title: opts.title, folderToken: opts.folderToken }), deps)
}

/** Append a record to a Feishu Base (Bitable) table (write-reversible). */
export async function feishuBaseAddRecord(
  opts: { appToken: string; tableId: string; fields: Record<string, unknown> },
  deps: FeishuExecDeps = {}
): Promise<FeishuWriteResult> {
  if (!opts.appToken || !opts.tableId) return { ok: false, error: 'appToken and tableId are required' }
  if (!opts.fields || typeof opts.fields !== 'object') return { ok: false, error: 'fields object is required' }
  let fieldsFile: string
  try {
    fieldsFile = writeTemp(JSON.stringify(opts.fields), 'json')
  } catch (e) {
    return { ok: false, error: `could not stage record fields: ${messageOf(e)}` }
  }
  return runLark(buildBaseRecordArgs({ appToken: opts.appToken, tableId: opts.tableId, fieldsFile }), deps)
}

/** Create a Feishu calendar event (write-reversible). */
export async function feishuCreateCalendarEvent(
  opts: { calendarId?: string; summary: string; start: string; end: string; description?: string },
  deps: FeishuExecDeps = {}
): Promise<FeishuWriteResult> {
  if (!opts.summary?.trim()) return { ok: false, error: 'event summary is required' }
  if (!opts.start || !opts.end) return { ok: false, error: 'event start and end are required' }
  return runLark(buildCalendarEventArgs(opts), deps)
}
