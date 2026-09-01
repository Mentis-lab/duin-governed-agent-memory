// agui-executors.ts — the /agui tool SCHEMAS + EXECUTORS, mechanically relocated out of the
// server.ts monolith (Architecture reconciled-plan step 2: pure import rewiring, no behavior
// change — server.ts imports every symbol back). This isolates the ~18 tool defs + their
// executors (file / discovery / exec / web / todos / background-command / spawn) behind one module
// boundary, shrinking the server hot-path file and setting up the shared dispatch registry.
//
// PURE control-flow: every executor takes its deps as arguments (notesDir, cwd, args) and returns a
// model-facing result string or {ok,...}. No SSE frames, no res, no gate — the caller in server.ts
// emits frames and screens the gate. Vault-jailing, sandbox seam, and the catastrophic
// command-screen are preserved exactly (same imports).

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'fs'
import { join, normalize, sep, dirname, extname, isAbsolute, relative, parse } from 'path'
import { execFile, spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { screenCommand } from './command-screen'
import { applyProfile, type SandboxTier } from '../sandbox'
import { operatorWritePaths, fullComputerAccess } from '../sandbox/operator-write-paths'
import { getActiveWorkspace } from '../workspace-state'

/**
 * Where a shell command should actually RUN.
 *
 * The same divergence agui-gate.ts already fixed on the policy side, still present on
 * the execution side: callers hand in the VAULT notes dir, while the user picks a
 * workspace with the ChatInput chip. The gate then honours that choice and the command
 * still ran — and, on macOS, still had its writes sandbox-jailed — in the vault. Picking
 * a project directory changed which policy applied and nothing about where work happened,
 * which reads as "it cannot write code".
 *
 * Resolved at the single point of use, for the reason the gate gives: no caller can then
 * get it wrong. getActiveWorkspace() falls back to the vault on its own, so when no
 * workspace has been chosen this is exactly the previous behaviour.
 */
export function resolveShellCwd(fallback: string): string {
  try {
    return getActiveWorkspace() || fallback
  } catch {
    return fallback
  }
}
import { SUBAGENT_TYPE_IDS } from './subagent-config'
// OCR consume-only (Tier 1). All three are gated so DUIN_OCR off ⇒ these paths
// are inert and read_file behaves byte-identically to today.
import { ocrEnabled, isImageExtension, ocrImage } from '../rag/loaders/ocr'
import { messageOf } from '../guarded'
import { tombstoneToTrash, snapshotToTrash } from './vault-trash'
// Foundation 2 (bounded-context): relevance-ranked truncation. When an embedder is threaded through
// (main loop provides embedForRecall; subagent/tests omit it), an over-budget tool output keeps the
// chunks most RELEVANT to the turn query instead of a blind head-slice. FAIL-OPEN by construction:
// no embed / cold embedder / throw ⇒ exactly today's head-slice, so this can only ever IMPROVE a
// truncation, never regress one (byte-identical when embed is absent).
import { boundToBudget } from './output-bound'
import type { EmbedFn } from '../brain/claim-entities'
import { createSkill } from '../skill-create'

// A real file-write tool exposed to the brain's chat generation. Without a tool
// the model can only produce TEXT — so "create a note / an HTML page" becomes a
// hallucinated "I saved it" with no file on disk. Jailed to the vault; text/code/
// artifact extensions only (see ALLOWED_WRITE_EXT).
export const ALLOWED_WRITE_EXT =
  /\.(md|markdown|txt|html?|css|jsx?|tsx?|mjs|cjs|json|jsonc|ya?ml|toml|csv|tsv|svg|xml|mermaid|mmd|py|sh)$/i
export const WRITE_NOTE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'write_file',
    description:
      'Create or overwrite a text/code/artifact file inside the user vault — a Markdown note, an HTML page, CSS, JS/TS, JSON, SVG, a Mermaid diagram, etc. Use this to ACTUALLY save whatever the user asks you to create; never merely describe it or claim you saved it. On success, tell the user the exact path. For a rich HTML/SVG/Mermaid artifact the user should preview, ALSO put the same source in a fenced code block in your reply (```html …```) so it renders in the artifact panel.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: {
          type: 'string',
          description:
            'Vault-relative path with a recognized extension, e.g. "DUIN/00 Inbox/my-note.md" or "DUIN/Outputs/dashboard.html". Must stay inside the vault.'
        },
        content: { type: 'string', description: 'The full file content to write.' }
      },
      required: ['path', 'content']
    }
  }
}

// create_skill — author a reusable skill from chat. Unlike write_file (vault-jailed),
// this writes a `<id>/SKILL.md` into DUIN's skills dir (outside the vault); the loader's
// chokidar watcher then shows it in the Skills panel live, no restart. Additive only:
// it never overwrites an existing skill (see skill-create.ts).
export const CREATE_SKILL_TOOL = {
  type: 'function' as const,
  function: {
    name: 'create_skill',
    description:
      "Create a NEW reusable skill in DUIN's skills library from a name plus an instruction body. " +
      'A skill is a durable how-to the agent can activate later (e.g. "draft BD follow-up emails", ' +
      '"turn meeting notes into a briefing"). On success it appears in the Skills panel immediately. ' +
      'Provide the INSTRUCTIONS ONLY as `body` — do NOT include YAML frontmatter; the name/description ' +
      'header is generated for you. Never overwrites an existing skill: if one with the same name exists, ' +
      'this fails and you should pick a different name or edit it in the Skills panel. Use this when the ' +
      'user asks to make/save a skill; use write_file for vault notes and create a `type: method` vault ' +
      'note for a method.',
    parameters: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'Human-readable skill name; the file id is slugified from it.' },
        description: {
          type: 'string',
          description: 'One-line summary of what the skill does (shown in the Skills panel). Optional.'
        },
        body: {
          type: 'string',
          description: 'The full skill instructions in Markdown (no frontmatter). This is the "how".'
        }
      },
      required: ['name', 'body']
    }
  }
}

/** Executor for create_skill — delegates to the skills-dir writer. Takes no vault dir:
 *  skills live in getSkillsDir(), outside the vault. */
export function executeCreateSkill(
  nameArg: unknown,
  descriptionArg: unknown,
  bodyArg: unknown
): { ok: true; id: string; path: string } | { ok: false; error: string } {
  return createSkill(nameArg, descriptionArg, bodyArg)
}

// PRESERVE before overwriting. `write_file` advertises "Create or overwrite", and a whole-file
// rewrite of a hand-authored note ("tidy up my meeting notes") destroys the prior body exactly as
// permanently as the unlink that executeDeleteFile was already fixed to avoid: no backup covers
// vault markdown (moat-backup takes the claim ledger + construction cache only) and index-store's
// pruneToKeep drops the notes_chunks rows on the reindex this very write schedules, so even the
// indexed copy of the old body is gone. And unlike delete_file/move_file this tool is NOT gated
// (AGUI_GATED_TOOLS excludes it) — under the default 'trusted-afk' posture nobody confirms, and the
// gate's own denial message steers the model here ("use a read/search/write_file tool instead").
//
// So route the pre-existing bytes through the SAME .trash primitive the sibling executors use —
// snapshotToTrash copies rather than renames, leaving the original in place for the write. The guard
// already existed (vault-trash.ts:81, and memory-store's snapshotPriorVersion already does exactly
// this before its own overwrite); this call site was the one skipping it.
//
// Content-addressed: an identical rewrite snapshots nothing, so .trash gets one entry per ACTUAL
// alteration, not one per save. Creating a new file is untouched.
//
// If the snapshot FAILS we do not write. Matching executeMoveFile's displaced-file handling: the
// live bytes are the thing at risk here, and proceeding blind is the one outcome that cannot be
// undone. The model is told, and can retry with a different path.
export function executeWriteNote(
  notesDir: string,
  pathArg: unknown,
  content: unknown
): { ok: true; path: string; replaced?: string } | { ok: false; error: string } {
  try {
    // Resolve against the permitted roots (vault + active workspace + operator-granted
    // paths), exactly like edit_file/move_file/delete_file/create_dir. write_file was the
    // lone mutating tool still hard-jailed to the vault, so the agent could move/delete/edit
    // a file on a permitted Desktop but not CREATE one there — the sharpest asymmetry in the
    // file-tool surface, and the one that broke "organize my Desktop into folders with an
    // index". A write that ESCAPES the vault is earned, not free: it is gated at the approval
    // seam (agui-gate: write_file + pathEscapesVault → tier irreversible-file, the same
    // token + posture path as delete/move), so this widening does not loosen the deny-first
    // model — in-vault writes stay ungated, and an out-of-vault write is denied without the
    // exec token. Same resolveInVault the seam consults, so gate and executor never disagree.
    const r = resolveInVault(notesDir, pathArg)
    if (!r.ok) return r
    if (!r.rel) return { ok: false, error: 'path is required' }
    if (!ALLOWED_WRITE_EXT.test(r.rel))
      return {
        ok: false,
        error: 'unsupported file type — allowed: md, html, css, js/ts, json, yaml, svg, mermaid, csv, py, sh, txt, …'
      }
    const next = typeof content === 'string' ? content : String(content ?? '')
    let replaced: string | undefined
    if (existsSync(r.abs) && !statSync(r.abs).isDirectory()) {
      let prior: string | null = null
      try {
        prior = readFileSync(r.abs, 'utf-8')
      } catch {
        // Unreadable prior content is exactly the case worth preserving — fall through and snapshot.
      }
      if (prior !== next) {
        const s = snapshotToTrash(notesDir, r.abs, 'agent:write_file', `overwritten by write_file of ${r.rel}`)
        if (!s.ok) return { ok: false, error: `the existing file could not be preserved: ${s.error}` }
        replaced = s.trashRel
      }
    }
    mkdirSync(dirname(r.abs), { recursive: true })
    writeFileSync(r.abs, next, 'utf-8')
    // A hit outside the vault is reported ABSOLUTE (as search/glob already do) — a bare
    // relative path is ambiguous across roots, and the next reader may be the operator.
    const displayPath = normalize(r.root) === normalize(notesDir) ? r.rel : r.abs
    return { ok: true, path: displayPath, ...(replaced ? { replaced } : {}) }
  } catch (err) {
    return { ok: false, error: (err as Error)?.message ?? 'write failed' }
  }
}

// Render + VALIDATE a rich artifact (HTML/SVG/Mermaid/JSX) in a headless sandbox
// and, when clean, open it in the artifact panel. This is the write→render→
// validate→fix loop: on errors the model gets them back and can retry.
export const RENDER_ARTIFACT_TOOL = {
  type: 'function' as const,
  function: {
    name: 'render_artifact',
    description:
      'Render a rich visual artifact so the user SEES it in the artifact panel, AND validate it — the app renders the source in a sandbox and reports any runtime errors. Use for anything visual (an HTML page/dashboard, an SVG, a Mermaid diagram, a React/JSX component). If it returns errors, FIX the source and call this again. It does NOT save a file — also call write_file if the user wants it persisted.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: { type: 'string', description: 'One of: html, svg, mermaid, jsx.' },
        source: { type: 'string', description: 'The full source for the artifact.' },
        title: { type: 'string', description: 'A short title for the artifact panel (optional).' }
      },
      required: ['type', 'source']
    }
  }
}

export const ARTIFACT_TYPES = new Set(['html', 'svg', 'mermaid', 'jsx'])

// Read-only vault tools — let the model inspect the vault BEFORE editing (read
// an existing note to update it, discover what exists). Vault-jailed.
export const READ_FILE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'read_file',
    description:
      'Read the current contents of a file in the user vault (Markdown, code, etc.). Use this BEFORE editing an existing file with write_file, or to check what a note actually contains. Read-only; the path must stay inside the vault.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { path: { type: 'string', description: 'Vault-relative path, e.g. "DUIN/00 Inbox/my-note.md".' } },
      required: ['path']
    }
  }
}

export const LIST_DIR_TOOL = {
  type: 'function' as const,
  function: {
    name: 'list_dir',
    description:
      'List the files and subfolders of a directory in the user vault, so you can discover what exists before reading or writing. Read-only; vault-jailed. Omit path (or pass "") for the vault root.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Vault-relative directory, e.g. "DUIN/00 Inbox" (empty for the vault root).' }
      },
      required: []
    }
  }
}

export const EDIT_FILE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'edit_file',
    description:
      'Make a surgical edit to an existing vault file by replacing an exact string. Prefer this over write_file when changing part of a file (it never clobbers the rest). old_string must appear EXACTLY once — include surrounding context to make it unique. Vault-jailed.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Vault-relative path of the file to edit.' },
        old_string: { type: 'string', description: 'The exact text to replace (must be unique in the file).' },
        new_string: { type: 'string', description: 'The replacement text.' }
      },
      required: ['path', 'old_string', 'new_string']
    }
  }
}

export const DELETE_FILE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'delete_file',
    description: 'Delete a file from the vault. Vault-jailed; only files (not directories) can be deleted.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { path: { type: 'string', description: 'Vault-relative path of the file to delete.' } },
      required: ['path']
    }
  }
}

export const MOVE_FILE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'move_file',
    description:
      'Move or rename a file within the vault (creates the destination folder if needed). Vault-jailed. If a DIFFERENT file already exists at the destination it is displaced: its contents are preserved in .trash and the result says so, but it stops being where the user left it. When filing notes in bulk, generic basenames (meeting-notes.md, README.md, index.md) collide across folders — check with read_file or glob_files first if unsure, and tell the user whenever a result reports a displacement.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        from: { type: 'string', description: 'Current vault-relative path.' },
        to: { type: 'string', description: 'New vault-relative path.' }
      },
      required: ['from', 'to']
    }
  }
}

export const CREATE_DIR_TOOL = {
  type: 'function' as const,
  function: {
    name: 'create_dir',
    description: 'Create a folder (and any missing parents) in the vault. Vault-jailed.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { path: { type: 'string', description: 'Vault-relative directory to create.' } },
      required: ['path']
    }
  }
}

export const SEARCH_FILES_TOOL = {
  type: 'function' as const,
  function: {
    name: 'search_files',
    description:
      'Search the TEXT of files across the vault for a regex (or literal substring) and return matching "path:line: text" hits. Use this to find where something is written before reading/editing. Read-only.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { query: { type: 'string', description: 'Regex or literal text to search for (case-insensitive).' } },
      required: ['query']
    }
  }
}

export const GLOB_FILES_TOOL = {
  type: 'function' as const,
  function: {
    name: 'glob_files',
    description:
      'Find files whose vault-relative path matches a glob (e.g. "DUIN/**/*.md", "*.html"). Use ** for any depth, * within a segment. Read-only.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { pattern: { type: 'string', description: 'Glob pattern, e.g. "DUIN/**/*.md".' } },
      required: ['pattern']
    }
  }
}

export const RUN_COMMAND_TOOL = {
  type: 'function' as const,
  function: {
    name: 'run_command',
    description:
      'Run a shell command (the terminal) in the vault directory and return its output. Use for git, builds, scripts, file inspection, or anything the dedicated tools do not cover. Times out at 30s; output is capped. This actually executes on the machine — be deliberate.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { command: { type: 'string', description: 'The shell command to run (PowerShell on Windows, bash on POSIX).' } },
      required: ['command']
    }
  }
}

export const WEB_FETCH_TOOL = {
  type: 'function' as const,
  function: {
    name: 'web_fetch',
    description:
      'Fetch a web page or API by URL and return its text (HTML is stripped to readable text). Use to pull in reference material or check a link. Read-only; http(s) only.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { url: { type: 'string', description: 'The http(s) URL to fetch.' } },
      required: ['url']
    }
  }
}

/**
 * Every location the agent is permitted to act in.
 *
 * The vault, the workspace the user picked, and the directories the operator listed in
 * settings.sandboxWritePaths. That last one is the SAME vetted allowlist the shell
 * sandbox uses, so "where DUIN may act" is one answer enforced identically by the
 * Seatbelt profile and by these file tools — rather than the shell being widened while
 * delete_file still refused, which is the state this replaces.
 *
 * Empty settings and no workspace picked ⇒ just the vault ⇒ the previous behaviour.
 */
function permittedRoots(notesDir: string): string[] {
  const roots: string[] = []
  const push = (candidate: string | undefined | null): void => {
    if (!candidate) return
    const n = normalize(candidate)
    if (n && !roots.includes(n)) roots.push(n)
  }
  push(notesDir)
  try {
    push(getActiveWorkspace() || undefined)
  } catch {
    /* workspace store unavailable — the vault alone is still correct */
  }
  for (const extra of operatorWritePaths()) push(extra)
  return roots
}

/**
 * Roots a SEARCH covers, and how to name a hit in each.
 *
 * search_files and glob_files hardcoded the vault, so once the agent could delete a file
 * on the Desktop it still could not FIND one — "organize my files" failed at the first
 * step. They now cover every permitted root.
 *
 * The vault stays the primary root and its hits keep their existing vault-relative form,
 * so nothing that worked before reads differently. Hits in any OTHER root are reported
 * absolute, because a bare relative path would be ambiguous across roots — and an
 * ambiguous path is worse than a long one when the next step is deleting it.
 */
function searchScopes(notesDir: string): { root: string; absolute: boolean }[] {
  const roots = permittedRoots(notesDir)
  const primary = normalize(notesDir)
  return roots.map((root) => ({ root, absolute: root !== primary }))
}

function isInsidePermitted(root: string, abs: string): boolean {
  return abs === root || abs.startsWith(root + sep)
}

/** Vault subtrees an agent may not write to, delete from, or move into WITHOUT an explicit
 *  operator approval (release M11, A4 F9). `.duin/agents/*.md` are LIVE-LOADED as subagent
 *  types (vault-agents-loader.ts), `.duin/skills` and `.duin/hooks` are executable capability
 *  definitions, and `.brain/` is the memory substrate the brain reads back as its own beliefs.
 *  In-vault write_file is otherwise ungated by design (agui-guard.ts) — a note is a note — but
 *  a write here is a capability grant or a memory edit, which an injected instruction in a note,
 *  a fetched page, or an inbound channel message must not be able to make silently. agui-gate
 *  routes these through the approval seam (tier capability-write); this is only the WHERE. */
const PROTECTED_VAULT_SUBTREES: string[][] = [['.duin', 'agents'], ['.duin', 'skills'], ['.duin', 'hooks'], ['.brain']]

export function isProtectedVaultPath(notesDir: string, abs: string): boolean {
  const root = normalize(notesDir)
  if (!root) return false
  const fold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)
  const target = fold(normalize(abs))
  for (const parts of PROTECTED_VAULT_SUBTREES) {
    const dir = fold(normalize(join(root, ...parts)))
    if (target === dir || target.startsWith(dir + sep)) return true
  }
  return false
}

/**
 * Resolve an agent-supplied path against the permitted roots.
 *
 * A RELATIVE path stays vault-relative and unchanged — that is what every prompt and
 * every stored note path assumes. An ABSOLUTE path is accepted only when it lands inside
 * a permitted root, which is what makes "delete this file on my Desktop" work once the
 * operator has allowed Desktop, and still refuses everything they have not.
 *
 * This decides WHERE only. delete_file and move_file stay in AGUI_GATED_TOOLS, so each
 * destructive call is still gated and approved on its own terms.
 */
export function resolveInVault(notesDir: string, pathArg: unknown): { ok: true; root: string; rel: string; abs: string } | { ok: false; error: string } {
  const root = normalize(notesDir)
  if (!root) return { ok: false, error: 'no vault is configured' }
  const raw = String(pathArg ?? '').trim()

  if (raw && isAbsolute(raw)) {
    const abs = normalize(raw)
    // Full computer access (operator opt-in, OFF by default): any absolute path is permitted —
    // no vault / workspace jail. The filesystem root is reported as the owner so an out-of-vault
    // hit still renders ABSOLUTE (root !== the vault) and a destructive op on it is still gated
    // at the seam. When full access is OFF (the default), fall through to the permittedRoots
    // allowlist.
    if (fullComputerAccess()) {
      const owner = parse(abs).root || root
      return { ok: true, root: owner, rel: relative(owner, abs) || abs, abs }
    }
    const roots = permittedRoots(root)
    const owner = roots.find((r) => isInsidePermitted(r, abs))
    if (!owner) {
      return {
        ok: false,
        error:
          `path is outside every permitted location. Allowed: ${roots.join(', ')}. ` +
          'Add it under Settings → General → "Folders DUIN may act in" to permit it, or turn on full computer access.'
      }
    }
    return { ok: true, root: owner, rel: relative(owner, abs) || '', abs }
  }

  // Strip any leading separators so a vault-relative path cannot climb out via '/'.
  const rel = raw.replace(/^[\\/]+/, '')
  const abs = rel ? normalize(join(root, rel)) : root
  if (!isInsidePermitted(root, abs)) return { ok: false, error: 'path escapes the vault' }
  return { ok: true, root, rel, abs }
}

export async function executeReadFile(
  notesDir: string,
  pathArg: unknown,
  maxBytes = 100_000,
  query?: string,
  embed?: EmbedFn
): Promise<{ ok: true; path: string; content: string } | { ok: false; error: string }> {
  try {
    const r = resolveInVault(notesDir, pathArg)
    if (!r.ok) return r
    if (!r.rel) return { ok: false, error: 'path is required' }
    if (!existsSync(r.abs)) return { ok: false, error: 'file not found' }
    // OCR (DUIN_OCR, default OFF): reading an image as utf-8 yields garbage. When
    // enabled, transcribe it to text instead. Best-effort — ocrImage never throws
    // and returns '' on failure, so a placeholder is the worst case (never the
    // utf-8 garbage). Flag-off ⇒ this branch is skipped, so the utf-8 read below
    // runs exactly as today.
    if (ocrEnabled() && isImageExtension(r.rel)) {
      const { text } = await ocrImage(r.abs)
      return { ok: true, path: r.rel, content: text || '[image: no text found]' }
    }
    let content = readFileSync(r.abs, 'utf-8')
    if (Buffer.byteLength(content, 'utf8') > maxBytes) {
      content = embed
        ? await boundToBudget(content, query ?? '', maxBytes, embed)
        : content.slice(0, maxBytes) + '\n\n[…truncated…]'
    }
    return { ok: true, path: r.rel, content }
  } catch (err) {
    return { ok: false, error: (err as Error)?.message ?? 'read failed' }
  }
}

export function executeListDir(
  notesDir: string,
  pathArg: unknown
): { ok: true; path: string; entries: string[] } | { ok: false; error: string } {
  try {
    const r = resolveInVault(notesDir, pathArg)
    if (!r.ok) return r
    if (!existsSync(r.abs)) return { ok: false, error: 'directory not found' }
    const entries = readdirSync(r.abs, { withFileTypes: true })
      .filter((d) => !d.name.startsWith('.'))
      .map((d) => (d.isDirectory() ? d.name + '/' : d.name))
      .sort()
      .slice(0, 300)
    return { ok: true, path: r.rel || '.', entries }
  } catch (err) {
    return { ok: false, error: (err as Error)?.message ?? 'list failed' }
  }
}

// ──────────────────── agentic file mutation ────────────────────

// PRESERVE before editing in place. This executor was the ONE vault-mutating path in this file
// that still did a bare writeFileSync: executeWriteNote snapshots (:109), executeDeleteFile and
// executeMoveFile tombstone — only edit_file destroyed prior bytes with no copy, no journal line
// and no stamp. The guard was already imported at the top of this very module; this call site was
// the one skipping it.
//
// "Surgical" is not a synonym for "small". old_string is whatever span the model chose, so a
// perfectly CORRECT reply to "trim the outdated Q2 section from my board brief" passes the
// uniqueness check and amputates 300 lines of hand-authored markdown with new_string = "". No
// failure mode is required — the uniqueness check PASSING is the trigger. And nothing else catches
// it: edit_file is ungated (AGUI_GATED_TOOLS excludes it — defensibly, its blast radius is the
// vault), aguiTier is 'none', requiresApproval is false, and the default posture is 'trusted-afk'
// so no human confirms. Nor is the loss rebuildable: moat-backup copies the claim ledger and
// construction cache, never vault markdown, and index-store's pruneToKeep drops the notes_chunks
// rows on the reindex this write itself schedules (edit_file ∈ VAULT_MUTATING_TOOLS below).
//
// Sharpest detail: write_file's own safety stamp tells the model to "use edit_file for a targeted
// change instead" — the remediation text routed destruction onto the single unprotected call site.
//
// So snapshot the pre-edit bytes through the SAME primitive the siblings use. Content-addressed
// like write_file: an edit that changes nothing (new_string === old_string) snapshots nothing, so
// .trash gets one entry per ACTUAL alteration. Every real edit does cost one whole-file snapshot —
// that churn is the intended price, since the span a small edit replaces is exactly as
// unrecoverable as a big one and there is no honest way to guess which edits are "safe".
//
// If the snapshot FAILS we do not write, matching executeWriteNote:110 — the live bytes are the
// thing at risk and proceeding blind is the one outcome that cannot be undone.
export function executeEditFile(
  notesDir: string,
  pathArg: unknown,
  oldArg: unknown,
  newArg: unknown
): { ok: true; path: string; replaced?: string } | { ok: false; error: string } {
  try {
    const r = resolveInVault(notesDir, pathArg)
    if (!r.ok) return r
    if (!r.rel) return { ok: false, error: 'path is required' }
    if (!existsSync(r.abs)) return { ok: false, error: 'file not found' }
    const oldS = String(oldArg ?? '')
    if (!oldS) return { ok: false, error: 'old_string is required' }
    const newS = String(newArg ?? '')
    const content = readFileSync(r.abs, 'utf-8')
    const occurrences = content.split(oldS).length - 1
    if (occurrences === 0) return { ok: false, error: 'old_string not found in the file' }
    if (occurrences > 1)
      return { ok: false, error: `old_string matches ${occurrences} places — add surrounding context so it is unique` }
    let replaced: string | undefined
    if (newS !== oldS) {
      const s = snapshotToTrash(
        notesDir,
        r.abs,
        'agent:edit_file',
        `edited by edit_file of ${r.rel} (replaced ${oldS.length} chars with ${newS.length})`
      )
      if (!s.ok) return { ok: false, error: `the existing file could not be preserved: ${s.error}` }
      replaced = s.trashRel
    }
    writeFileSync(r.abs, content.replace(oldS, newS), 'utf-8')
    return { ok: true, path: r.rel, ...(replaced ? { replaced } : {}) }
  } catch (err) {
    return { ok: false, error: (err as Error)?.message ?? 'edit failed' }
  }
}

// SOFT-delete, never unlink. The model is the actor here and it is GUESSING (e.g. "clean
// up duplicate notes in 00 Inbox" ⇒ it picks which note is a duplicate), and under the
// default 'trusted-afk' posture no human confirms. A hard unlink of a hand-authored note
// is unrecoverable: no backup covers vault notes and the index rows are pruned on the
// reindex the unlink itself triggers. So route through the SAME .trash tombstone the
// renderer's Delete button uses (see vault-trash.ts) — the guard already existed in this
// codebase; this call site was the one skipping it.
export function executeDeleteFile(
  notesDir: string,
  pathArg: unknown
): { ok: true; path: string; trashed: string } | { ok: false; error: string } {
  try {
    const r = resolveInVault(notesDir, pathArg)
    if (!r.ok) return r
    if (!r.rel) return { ok: false, error: 'path is required' }
    if (!existsSync(r.abs)) return { ok: false, error: 'file not found' }
    if (statSync(r.abs).isDirectory()) return { ok: false, error: 'path is a directory; only files can be deleted' }
    const t = tombstoneToTrash(notesDir, r.abs, 'agent:delete_file')
    if (!t.ok) return { ok: false, error: t.error }
    return { ok: true, path: r.rel, trashed: t.trashRel }
  } catch (err) {
    return { ok: false, error: (err as Error)?.message ?? 'delete failed' }
  }
}

export function executeMoveFile(
  notesDir: string,
  fromArg: unknown,
  toArg: unknown
): { ok: true; from: string; to: string; displaced?: string } | { ok: false; error: string } {
  try {
    const f = resolveInVault(notesDir, fromArg)
    if (!f.ok) return f
    const t = resolveInVault(notesDir, toArg)
    if (!t.ok) return t
    if (!f.rel || !t.rel) return { ok: false, error: 'both from and to are required' }
    if (!existsSync(f.abs)) return { ok: false, error: 'source not found' }
    mkdirSync(dirname(t.abs), { recursive: true })
    // renameSync silently overwrites an existing destination — same unrecoverable shape as
    // a bare unlink, just harder to notice. Tombstone whatever is already at `to` first so
    // a mis-targeted move can be undone from .trash.
    let displaced: string | undefined
    if (existsSync(t.abs) && t.abs !== f.abs && !statSync(t.abs).isDirectory()) {
      const d = tombstoneToTrash(notesDir, t.abs, 'agent:move_file', `displaced by move from ${f.rel}`)
      if (!d.ok) return { ok: false, error: `destination exists and could not be preserved: ${d.error}` }
      displaced = d.trashRel
    }
    renameSync(f.abs, t.abs)
    return { ok: true, from: f.rel, to: t.rel, ...(displaced ? { displaced } : {}) }
  } catch (err) {
    return { ok: false, error: (err as Error)?.message ?? 'move failed' }
  }
}

export function executeCreateDir(
  notesDir: string,
  pathArg: unknown
): { ok: true; path: string } | { ok: false; error: string } {
  try {
    const r = resolveInVault(notesDir, pathArg)
    if (!r.ok) return r
    if (!r.rel) return { ok: false, error: 'path is required' }
    mkdirSync(r.abs, { recursive: true })
    return { ok: true, path: r.rel }
  } catch (err) {
    return { ok: false, error: (err as Error)?.message ?? 'mkdir failed' }
  }
}

// ──────────────────── agentic discovery ────────────────────

export const TEXT_EXT = new Set([
  '.md', '.markdown', '.txt', '.html', '.htm', '.css', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.csv', '.tsv', '.svg', '.xml', '.mermaid', '.mmd', '.py', '.sh'
])

// Bounded recursive walk of the vault, returning vault-relative file paths. Skips
// dotfiles/dirs + node_modules so a stray dependency tree can't blow the budget.
export function walkVault(root: string, maxFiles = 5000): string[] {
  const out: string[] = []
  const stack: string[] = ['']
  while (stack.length && out.length < maxFiles) {
    const relDir = stack.pop() as string
    let entries: import('fs').Dirent[]
    try {
      entries = readdirSync(join(root, relDir), { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const rel = relDir ? relDir + '/' + e.name : e.name
      if (e.isDirectory()) stack.push(rel)
      else out.push(rel)
      if (out.length >= maxFiles) break
    }
  }
  return out
}

export function executeSearchFiles(
  notesDir: string,
  queryArg: unknown,
  maxMatches = 100
): { ok: true; matches: string[]; capped: boolean } | { ok: false; error: string } {
  try {
    const root = normalize(notesDir)
    if (!root) return { ok: false, error: 'no vault is configured' }
    const scopes = searchScopes(root)
    const q = String(queryArg ?? '').trim()
    if (!q) return { ok: false, error: 'query is required' }
    let rx: RegExp | null = null
    try {
      rx = new RegExp(q, 'i')
    } catch {
      rx = null // fall back to a case-insensitive substring match
    }
    const ql = q.toLowerCase()
    const matches: string[] = []
    for (const scope of scopes)
    for (const rel of walkVault(scope.root)) {
      if (!TEXT_EXT.has(extname(rel).toLowerCase())) continue
      let text: string
      try {
        text = readFileSync(join(scope.root, rel), 'utf-8')
      } catch {
        continue
      }
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const hit = rx ? rx.test(lines[i]) : lines[i].toLowerCase().includes(ql)
        if (hit) {
          // Vault hits keep their relative form; hits in any OTHER permitted root are
          // reported absolute — a bare relative path would be ambiguous across roots,
          // and ambiguity is worse than length when the next step is deleting it.
          const label = scope.absolute ? join(scope.root, rel) : rel
          matches.push(`${label}:${i + 1}: ${lines[i].trim().slice(0, 200)}`)
          if (matches.length >= maxMatches) return { ok: true, matches, capped: true }
        }
      }
    }
    return { ok: true, matches, capped: false }
  } catch (err) {
    return { ok: false, error: (err as Error)?.message ?? 'search failed' }
  }
}

export function globToRegExp(glob: string): RegExp {
  const BS = String.fromCharCode(92) // backslash — avoids source-escaping issues
  const SPECIAL = '.+^${}()|[]' // regex metachars to escape ($ is literal in a single-quoted string)
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'
        i++
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '.'
    } else if (SPECIAL.indexOf(c) !== -1) {
      re += BS + c
    } else {
      re += c
    }
  }
  return new RegExp('^' + re + '$', 'i')
}

export function executeGlobFiles(
  notesDir: string,
  patternArg: unknown,
  maxResults = 300
): { ok: true; results: string[] } | { ok: false; error: string } {
  try {
    const root = normalize(notesDir)
    if (!root) return { ok: false, error: 'no vault is configured' }
    const pat = String(patternArg ?? '')
      .replace(/^[\\/]+/, '')
      .trim()
    if (!pat) return { ok: false, error: 'pattern is required' }
    let rx: RegExp
    try {
      rx = globToRegExp(pat)
    } catch {
      return { ok: false, error: 'invalid pattern' }
    }
    // Every permitted root, same rule as search_files: vault hits stay relative, hits
    // elsewhere are absolute so the path is unambiguous about which root it belongs to.
    const results: string[] = []
    for (const scope of searchScopes(root)) {
      for (const rel of walkVault(scope.root)) {
        if (!rx.test(rel)) continue
        results.push(scope.absolute ? join(scope.root, rel) : rel)
        if (results.length >= maxResults) return { ok: true, results }
      }
    }
    return { ok: true, results }
  } catch (err) {
    return { ok: false, error: (err as Error)?.message ?? 'glob failed' }
  }
}

// ──────────────────── agentic execution ────────────────────

// Run a shell command (the "terminal"). Runs in the vault cwd with a timeout +
// output cap. This is powerful (arbitrary shell on the user's machine, no
// confirmation) — it's their own local agent, matching Claude/codex Bash.
export function executeRunCommand(
  command: unknown,
  cwd: string,
  timeoutMs = 30_000,
  query?: string,
  embed?: EmbedFn
): Promise<
  { ok: true; output: string; sandboxTier?: SandboxTier } | { ok: false; error: string; sandboxTier?: SandboxTier }
> {
  return new Promise((resolve) => {
    const cmd = String(command ?? '').trim()
    if (!cmd) return resolve({ ok: false, error: 'command is required' })
    // Catastrophic-command backstop (defense-in-depth under the exec-token gate): refuse
    // irreversible host-destruction even on an authorized turn. See command-screen.ts.
    const screen = screenCommand(cmd)
    if (!screen.ok) return resolve({ ok: false, error: `refused: ${screen.reason} (blocked by the safety screen)` })
    // Invoke the shell explicitly with its OWN flag convention — Node's
    // exec(shell:'powershell.exe') would pass cmd.exe's `/d /s /c`, which
    // PowerShell rejects. PowerShell uses -Command; bash uses -c.
    const isWin = process.platform === 'win32'
    const file = isWin ? 'powershell.exe' : '/bin/bash'
    const fileArgs = isWin ? ['-NoProfile', '-NonInteractive', '-Command', cmd] : ['-c', cmd]
    // OS sandbox seam: wrap the shell invocation with kernel-level isolation
    // where the host supports it (macOS sandbox-exec, Linux bubblewrap — fs-write
    // jailed to the vault + tmp). On Windows this is an honest pass-through
    // (tier 'none') — the compensating controls there are the exec-token gate +
    // catastrophic command-screen + per-action approval. The brain loop
    // previously spawned RAW, bypassing this seam entirely (only shell-tool.ts
    // used it); now host-exec on any platform routes through it.
    const workspaceRoot = resolveShellCwd(cwd || process.cwd())
    const sb = applyProfile({
      spawnCmd: file,
      spawnArgs: fileArgs,
      cwd: workspaceRoot,
      fullAccess: fullComputerAccess(),
      // fsWritePaths carries the operator's allowlist. Without it the shell can only
      // write inside the vault and $TMPDIR, so "write a script into ~/code" failed with
      // EPERM and the only escape was DUIN_SANDBOX=0 — disabling the sandbox entirely
      // to gain one directory. Empty by default; the sandbox stays deny-by-default.
      opts: { workspaceRoot, networkPolicy: 'open', fsWritePaths: operatorWritePaths() }
    })
    execFile(
      sb.cmd,
      sb.args,
      {
        cwd: workspaceRoot,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true
      },
      async (err, stdout, stderr) => {
        let out = String(stdout || '')
        if (stderr && String(stderr).trim()) out += (out ? '\n' : '') + '[stderr]\n' + String(stderr)
        if (out.length > 20_000) {
          out = embed
            ? await boundToBudget(out, query ?? '', 20_000, embed)
            : out.slice(0, 20_000) + '\n[…truncated…]'
        }
        if (err && !out.trim()) resolve({ ok: false, error: messageOf(err), sandboxTier: sb.sandboxTier })
        else resolve({ ok: true, output: out.trim() || '(command finished with no output)', sandboxTier: sb.sandboxTier })
      }
    )
  })
}

// ──────────────────── web ────────────────────

export async function executeWebFetch(
  urlArg: unknown,
  maxChars = 40_000,
  query?: string,
  embed?: EmbedFn
): Promise<{ ok: true; url: string; content: string } | { ok: false; error: string }> {
  try {
    const url = String(urlArg ?? '').trim()
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'a valid http(s) url is required' }
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 15_000)
    let resp: Response
    try {
      resp = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'DUIN/1.0' } })
    } finally {
      clearTimeout(timer)
    }
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` }
    const ct = resp.headers.get('content-type') || ''
    let text = await resp.text()
    if (/html/i.test(ct)) {
      text = text
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s*\n\s*\n/g, '\n\n')
        .trim()
    }
    if (text.length > maxChars) {
      text = embed
        ? await boundToBudget(text, query ?? '', maxChars, embed)
        : text.slice(0, maxChars) + '\n\n[…truncated…]'
    }
    return { ok: true, url, content: text }
  } catch (err) {
    return { ok: false, error: (err as Error)?.message ?? 'fetch failed' }
  }
}

// ──────────────────── web search ────────────────────

export async function executeWebSearch(
  queryArg: unknown,
  maxChars = 8_000
): Promise<{ ok: true; results: string } | { ok: false; error: string }> {
  try {
    const q = String(queryArg ?? '').trim()
    if (!q) return { ok: false, error: 'query is required' }
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 15_000)
    let resp: Response
    try {
      resp = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), {
        signal: ctl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0' }
      })
    } finally {
      clearTimeout(timer)
    }
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` }
    const html = await resp.text()
    const strip = (s: string): string =>
      s
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#x27;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim()
    const decodeUddg = (href: string): string => {
      const m = href.match(/[?&]uddg=([^&]+)/)
      if (m) {
        try {
          return decodeURIComponent(m[1])
        } catch {
          return href
        }
      }
      return href
    }
    // Snippets, in document order.
    const snippets: string[] = []
    const snippetRe = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\//g
    let sm: RegExpExecArray | null
    while ((sm = snippetRe.exec(html)) !== null) snippets.push(strip(sm[1]))
    // Result anchors (href + title).
    const blocks: string[] = []
    const anchorRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
    let am: RegExpExecArray | null
    let i = 0
    while ((am = anchorRe.exec(html)) !== null && blocks.length < 8) {
      const url = decodeUddg(am[1])
      const title = strip(am[2])
      const snip = snippets[i] || ''
      i++
      if (title) blocks.push(`${title}\n${url}${snip ? '\n' + snip : ''}`)
    }
    let out: string
    if (blocks.length) {
      out = blocks.join('\n\n')
    } else if (html && html.length > 500) {
      // Fetch succeeded (non-trivial HTML) yet nothing parsed → the provider
      // likely changed its markup. Surface that distinctly, not a silent "No results".
      out =
        'No parseable results — the web search provider may have changed its page format. Try web_fetch on a specific URL instead.'
    } else {
      out = 'No results.'
    }
    if (out.length > maxChars) out = out.slice(0, maxChars) + '\n\n[…truncated…]'
    return { ok: true, results: out }
  } catch (err) {
    return { ok: false, error: (err as Error)?.message ?? 'search failed' }
  }
}

// ──────────────────── task list (write_todos) ────────────────────

export type TodoItem = { content: string; status: 'pending' | 'in_progress' | 'completed' }
export const TODO_STORE = new Map<string, TodoItem[]>()

export function executeWriteTodos(
  threadKey: string,
  todosArg: unknown
): { ok: true; rendered: string } | { ok: false; error: string } {
  if (!Array.isArray(todosArg)) return { ok: false, error: 'todos must be an array of {content, status}' }
  const todos: TodoItem[] = []
  for (const t of todosArg) {
    const content = typeof t?.content === 'string' ? t.content.trim() : String(t?.content ?? '').trim()
    if (!content) continue
    const status: TodoItem['status'] =
      t?.status === 'in_progress' || t?.status === 'completed' ? t.status : 'pending'
    todos.push({ content, status })
  }
  TODO_STORE.set(threadKey, todos)
  const mark = (s: TodoItem['status']): string => (s === 'completed' ? '[x]' : s === 'in_progress' ? '[~]' : '[ ]')
  const rendered = todos.length ? todos.map((t) => `${mark(t.status)} ${t.content}`).join('\n') : '(no todos)'
  return { ok: true, rendered }
}

// ──────────────────── background commands (Monitor-style) ────────────────────

export type BgEntry = { proc: ReturnType<typeof spawn>; chunks: string[]; done: boolean; exit: number | null }
export const BG_PROCS = new Map<string, BgEntry>()

// Tools that change vault contents → a successful call should schedule a reindex
// so same-turn retrieval reflects the write.
export const VAULT_MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'move_file', 'create_dir'])

// Kill any surviving background children when the app quits — Windows does not
// reap child processes with the parent, so a leaked dev server would linger.
// Lazy + guarded so this module stays importable outside an Electron main
// process (e.g. headless tests).
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate guarded lazy load: a static `import 'electron'` would make this module unimportable outside an Electron main process (headless tests).
  const electron = require('electron') as { app?: { on?: (e: string, cb: () => void) => void } }
  electron.app?.on?.('before-quit', () => {
    for (const e of BG_PROCS.values()) {
      try {
        e.proc.kill()
      } catch (e) { console.debug('[agui-executors] already dead:', messageOf(e)) }
    }
  })
} catch (e) { console.debug('[agui-executors] not running inside an Electron main process  nothing to clean up:', messageOf(e)) }

export function executeStartCommand(
  command: unknown,
  cwd: string
): { ok: true; id: string } | { ok: false; error: string } {
  const cmd = String(command ?? '').trim()
  if (!cmd) return { ok: false, error: 'command is required' }
  let running = 0
  for (const v of BG_PROCS.values()) if (!v.done) running++
  if (running >= 8) return { ok: false, error: 'too many background commands running (max 8) — stop one first' }
  // GC finished entries so the registry can't grow unbounded across a session
  // (Map preserves insertion order → the oldest done entries drop first). Keep a
  // small tail so read_command still works shortly after a command exits.
  if (BG_PROCS.size >= 24) {
    for (const [k, v] of BG_PROCS) {
      if (v.done) BG_PROCS.delete(k)
      if (BG_PROCS.size < 16) break
    }
  }
  try {
    const isWin = process.platform === 'win32'
    // Same OS-sandbox seam as run_command (real jail on macOS/Linux; honest
    // pass-through on Windows). Background commands route through it too.
    const workspaceRoot = resolveShellCwd(cwd || process.cwd())
    const sb = applyProfile({
      spawnCmd: isWin ? 'powershell.exe' : '/bin/bash',
      spawnArgs: isWin ? ['-NoProfile', '-NonInteractive', '-Command', cmd] : ['-c', cmd],
      cwd: workspaceRoot,
      fullAccess: fullComputerAccess(),
      // fsWritePaths carries the operator's allowlist. Without it the shell can only
      // write inside the vault and $TMPDIR, so "write a script into ~/code" failed with
      // EPERM and the only escape was DUIN_SANDBOX=0 — disabling the sandbox entirely
      // to gain one directory. Empty by default; the sandbox stays deny-by-default.
      opts: { workspaceRoot, networkPolicy: 'open', fsWritePaths: operatorWritePaths() }
    })
    const proc = isWin
      ? spawn(sb.cmd, sb.args, { cwd: workspaceRoot, windowsHide: true })
      : spawn(sb.cmd, sb.args, { cwd: workspaceRoot })
    const id = randomUUID().slice(0, 8)
    const entry: BgEntry = { proc, chunks: [], done: false, exit: null }
    const push = (d: Buffer): void => {
      entry.chunks.push(d.toString())
      // Keep only the last ~50k chars so a chatty process can't grow unbounded.
      let total = 0
      for (let k = entry.chunks.length - 1; k >= 0; k--) {
        total += entry.chunks[k].length
        if (total > 50_000) {
          entry.chunks = entry.chunks.slice(k + 1)
          break
        }
      }
    }
    proc.stdout?.on('data', push)
    proc.stderr?.on('data', push)
    proc.on('close', (code) => {
      entry.done = true
      entry.exit = code ?? null
    })
    proc.on('error', (e) => {
      entry.chunks.push('[spawn error] ' + e.message)
      entry.done = true
      entry.exit = -1
    })
    BG_PROCS.set(id, entry)
    return { ok: true, id }
  } catch (err) {
    return { ok: false, error: (err as Error)?.message ?? 'spawn failed' }
  }
}

export function executeReadCommand(
  idArg: unknown
): { ok: true; status: string; output: string } | { ok: false; error: string } {
  const id = String(idArg ?? '').trim()
  const entry = BG_PROCS.get(id)
  if (!entry) return { ok: false, error: 'no background command with that id' }
  const status = entry.done ? `exited(${entry.exit})` : 'running'
  let output = entry.chunks.join('')
  if (output.length > 20_000) output = output.slice(-20_000)
  return { ok: true, status, output: output || '(no output yet)' }
}

export function executeStopCommand(idArg: unknown): { ok: true } | { ok: false; error: string } {
  const id = String(idArg ?? '').trim()
  const entry = BG_PROCS.get(id)
  if (!entry) return { ok: false, error: 'no background command with that id' }
  try {
    entry.proc.kill()
  } catch (e) { console.debug('[agui-executors] already dead:', messageOf(e)) }
  entry.done = true
  return { ok: true }
}

// ──────────────────── tool defs for the new tools ────────────────────

export const WEB_SEARCH_TOOL = {
  type: 'function' as const,
  function: {
    name: 'web_search',
    description:
      'Search the web and return the top results (title, url, snippet). Use to find current information or pages to then read with web_fetch. Read-only.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { query: { type: 'string', description: 'The search query.' } },
      required: ['query']
    }
  }
}

export const WRITE_TODOS_TOOL = {
  type: 'function' as const,
  function: {
    name: 'write_todos',
    description:
      'Record or update the task checklist for this conversation (replaces the whole list). Use to plan and track multi-step work; the list persists across turns.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        todos: {
          type: 'array',
          description: 'The full task list.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              content: { type: 'string', description: 'The task text.' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Task status.' }
            },
            required: ['content']
          }
        }
      },
      required: ['todos']
    }
  }
}

export const START_COMMAND_TOOL = {
  type: 'function' as const,
  function: {
    name: 'start_command',
    description:
      'Start a long-running shell command in the BACKGROUND (dev server, build, watch, tail) and return an id. Unlike run_command it does not block or time out; poll its output with read_command and end it with stop_command.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { command: { type: 'string', description: 'The shell command to run in the background.' } },
      required: ['command']
    }
  }
}

export const READ_COMMAND_TOOL = {
  type: 'function' as const,
  function: {
    name: 'read_command',
    description: 'Read the accumulated output and status (running / exited) of a background command started with start_command.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { id: { type: 'string', description: 'The background command id from start_command.' } },
      required: ['id']
    }
  }
}

export const STOP_COMMAND_TOOL = {
  type: 'function' as const,
  function: {
    name: 'stop_command',
    description: 'Stop (kill) a background command started with start_command.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { id: { type: 'string', description: 'The background command id to stop.' } },
      required: ['id']
    }
  }
}

export const SPAWN_AGENT_TOOL = {
  type: 'function' as const,
  function: {
    name: 'spawn_agent',
    description:
      'Delegate a self-contained sub-task to a subagent that runs its OWN bounded tool loop (file/shell/web tools) in a fresh context and returns only its final result. Use to parallelize or isolate a chunk of work so it does not clutter the main thread. Optionally pick an agent_type (curated toolset+role), a model, and a reasoning_effort. A subagent may itself delegate deeper (bounded depth), but nested subagents are READ-ONLY (no shell/write/delete).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        task: { type: 'string', description: 'A complete, self-contained description of the sub-task.' },
        agent_type: {
          type: 'string',
          enum: SUBAGENT_TYPE_IDS,
          description:
            'Optional subagent role: "general" (full toolset, default), "researcher" (read-only files + web, no mutation/shell), "coder" (file edits + shell, no web).'
        },
        model: { type: 'string', description: 'Optional model id to run the subagent on (defaults to this turn\'s model).' },
        reasoning_effort: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Optional reasoning effort for the subagent (default low).'
        }
      },
      required: ['task']
    }
  }
}
