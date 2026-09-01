import { t } from '@/lib/i18n'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useDirtyGuard, useDraftMirror, dropDraft } from '@/hooks/useDirtyGuard'
import { draftKey, readDraft } from '@/lib/dirty-guard'
import { useSettingsStore } from '@/stores/settings-store'
import { useUiStore } from '@/stores/ui-store'
import { toast } from '@/stores/toast-store'
import { cn } from '@/duin/lib/utils'

// Foundations — edit the vault-root foundation files that DUIN reads into its
// context every turn (ME.md / BRAIN.md) and the north-star tracks it parses on
// graph build (GOALS.md). Saves go through the path-whitelisted, snapshot-before-
// overwrite handler (brain:writeFoundationFile); the vault root is resolved
// main-side, never passed from here. Read-only visibility into the DUIN-curated
// MEMORY.md / .brain/* with a "don't hand-edit, the loops own this" tag.

// ── Pure config + helpers (exported for unit tests; the component is not
//    render-testable in this repo's node-only test env). ──────────────────────

export type FoundationName = 'SOUL.md' | 'ME.md' | 'BRAIN.md' | 'GOALS.md'

export interface FoundationMeta {
  name: FoundationName
  /** Hard/soft char cap surfaced to the operator. Infinity = no prompt-budget cap. */
  capChars: number
  /** Whether the cap is a hard truncation (BRAIN's <agents_md>) vs a soft/shared budget. */
  capKind: 'hard' | 'shared' | 'none'
  badge: string
  /** One-line "how this is used" note under the editor. */
  howUsed: string
}

/** The 6 KB memory grounding budget (`BRAIN_GROUNDING_CHAR_CAP`).
 *
 *  IMPORTANT — this applies to the MEMORY block only: root MEMORY.md plus the
 *  `.brain/memory` concepts. SOUL/ME/BRAIN are assembled into the separate
 *  IDENTITY block, which `loadBrain` never caps and nothing truncates
 *  downstream. The pane used to label ME.md as sharing this budget; it does not,
 *  and telling the operator a number that does not exist is worse than telling
 *  them there is no limit. */
export const MEMORY_GROUNDING_CAP = 6000
/** The 20 KB hard cap the agents-md loader truncates BRAIN.md's `<agents_md>` at. */
export const AGENTS_MD_CAP = 20000

export const FOUNDATION_FILES: readonly FoundationMeta[] = [
  {
    name: 'SOUL.md',
    capChars: Infinity,
    capKind: 'none',
    badge: 'always in context · read first · uncapped',
    howUsed:
      "Who DUIN is — character and voice. Loaded ahead of BRAIN.md, because rules are followed literally while character generalizes to whatever no rule covered. Hard constraints belong in BRAIN.md; this is who's applying them. Sent in full on EVERY turn and never truncated, so its length is a cost you pay per message."
  },
  {
    name: 'ME.md',
    capChars: Infinity,
    capKind: 'none',
    badge: 'always in context · uncapped',
    howUsed:
      'Who you are as the operator. Grounds every "who is the owner" answer, read fresh each turn. Sent in full on EVERY turn and never truncated, so its length is a cost you pay per message.'
  },
  {
    name: 'BRAIN.md',
    capChars: AGENTS_MD_CAP,
    capKind: 'hard',
    badge: 'always in context · also <agents_md>',
    howUsed:
      "DUIN's own identity + operating contract. Reaches the prompt twice (verbatim as <agents_md>, and inside the identity block) — one edit changes both. Over 20,000 chars, the <agents_md> copy truncates."
  },
  {
    name: 'GOALS.md',
    capChars: Infinity,
    capKind: 'none',
    badge: 'graph & forecasts only — not the identity block',
    howUsed:
      'North-star Strategic Tracks. Parsed into the brain graph on rebuild, not per turn — edits take effect after the next graph refresh (triggered on save).'
  }
] as const

export type CapState = 'under' | 'near' | 'over'

/** Indicator state for a length against a cap: over the cap, within 80% (near), else under. */
export function capState(len: number, cap: number): CapState {
  if (!Number.isFinite(cap)) return 'under'
  if (len > cap) return 'over'
  if (len >= cap * 0.8) return 'near'
  return 'under'
}

/** True when a read-only MEMORY.md is near/over the shared 6 KB memory grounding budget. */
export function memoryNearCap(len: number): boolean {
  return len >= MEMORY_GROUNDING_CAP * 0.8
}

// ── Types for the thin window.api surface we use ─────────────────────────────

interface FilesApi {
  readText: (filePath: string) => Promise<{ success: boolean; data?: { content: string; size: number }; error?: string }>
  listDir: (dirPath: string) => Promise<{ success: boolean; data?: { name: string; type: 'file' | 'dir'; path: string }[]; error?: string }>
  openInExplorer: (args?: { targetPath?: string }) => Promise<{ success: boolean; error?: string }>
}
interface BrainApi {
  writeFoundationFile: (
    name: string,
    body: string
  ) => Promise<{ success: boolean; data?: { name: string; wrote: boolean; replacedTrashRel?: string }; error?: string }>
  onUpdated?: (cb: () => void) => () => void
}
function filesApi(): FilesApi | undefined {
  return (window as unknown as { api?: { files?: FilesApi } }).api?.files
}
function brainApi(): BrainApi | undefined {
  return (window as unknown as { api?: { brain?: BrainApi } }).api?.brain
}

function joinVault(vault: string, name: string): string {
  return vault.replace(/[\\/]+$/, '') + '/' + name
}

type EditorStatus = 'loading' | 'loadError' | 'clean' | 'dirty' | 'saving' | 'saveError' | 'saved'

interface EditorState {
  content: string
  savedContent: string
  status: EditorStatus
  error?: string
  replacedTrashRel?: string
  /** true when the file did not exist on load (saving will create it). */
  absent: boolean
}

const INITIAL: EditorState = { content: '', savedContent: '', status: 'loading', absent: false }

// ── One editable file editor ─────────────────────────────────────────────────

function FoundationEditor({ meta, vault }: { meta: FoundationMeta; vault: string }): React.ReactElement {
  const [st, setSt] = useState<EditorState>(INITIAL)
  const savedRef = useRef('')
  // U3. Esc, or clicking any other Settings tab, used to destroy this draft:
  // SettingsDialog unmounts the tab conditionally, there was a dirty badge and NO
  // confirm anywhere, and PersonalitySettings — one tab away — writes on every
  // keystroke, which trains exactly the Esc reflex that destroys this.
  const guardId = `settings:foundations:${meta.name}`
  const dKey = draftKey('foundation', meta.name)
  const restoredRef = useRef(false)

  const load = useCallback(async () => {
    const api = filesApi()
    if (!api) {
      setSt({ ...INITIAL, status: 'loadError', error: 'File bridge unavailable' })
      return
    }
    setSt((s) => ({ ...s, status: 'loading' }))
    const res = await api.readText(joinVault(vault, meta.name))
    if (res.success && res.data) {
      savedRef.current = res.data.content
      // Restore a mirrored draft ONCE, on first load — a reload mid-edit is the
      // case no confirm can cover. Later reloads (the onUpdated broadcast below)
      // must not resurrect a draft the operator has since saved or abandoned.
      const draft = restoredRef.current ? null : readDraft(dKey)
      restoredRef.current = true
      if (draft !== null && draft !== res.data.content) {
        setSt({ content: draft, savedContent: res.data.content, status: 'dirty', absent: false })
        toast.info(`Restored your unsaved ${meta.name} draft`)
        return
      }
      setSt({ content: res.data.content, savedContent: res.data.content, status: 'clean', absent: false })
    } else if (/not found|no such file|ENOENT/i.test(res.error ?? '')) {
      // Absent file is NOT an error — offer an empty editable buffer.
      savedRef.current = ''
      setSt({ content: '', savedContent: '', status: 'clean', absent: true })
    } else {
      setSt({ ...INITIAL, status: 'loadError', error: res.error ?? 'Could not read file' })
    }
  }, [vault, meta.name])

  useEffect(() => {
    void load()
  }, [load])

  // Re-load when another writer (loops / external editor / this save) broadcasts.
  useEffect(() => {
    const off = brainApi()?.onUpdated?.(() => {
      // Only pull in external changes when we have nothing unsaved to lose.
      setSt((s) => {
        // 'saveError' belongs here too. A save that FAILED still holds the operator's
        // only copy of the edit — the guard listed the two states where work is
        // in-hand but not the third, so a failed save followed by any onUpdated
        // broadcast reloaded over it and the edit was gone.
        if (s.status === 'dirty' || s.status === 'saving' || s.status === 'saveError') return s
        void load()
        return s
      })
    })
    return () => off?.()
  }, [load])

  const onChange = (v: string): void => {
    setSt((s) => ({ ...s, content: v, status: v === savedRef.current ? 'clean' : 'dirty', error: undefined }))
  }

  const save = async (): Promise<void> => {
    const api = brainApi()
    if (!api?.writeFoundationFile) {
      setSt((s) => ({ ...s, status: 'saveError', error: 'Write bridge unavailable' }))
      return
    }
    const body = st.content
    setSt((s) => ({ ...s, status: 'saving', error: undefined }))
    const res = await api.writeFoundationFile(meta.name, body)
    if (res.success) {
      savedRef.current = body
      dropDraft(dKey)
      setSt((s) => ({
        ...s,
        savedContent: body,
        status: 'saved',
        absent: false,
        replacedTrashRel: res.data?.replacedTrashRel
      }))
      toast.success(
        res.data?.replacedTrashRel
          ? `Saved ${meta.name} · prior version → ${res.data.replacedTrashRel}`
          : `Saved ${meta.name}`
      )
    } else {
      setSt((s) => ({ ...s, status: 'saveError', error: res.error ?? 'Save failed' }))
    }
  }

  const len = st.content.length
  const cs = capState(len, meta.capChars)
  const dirty = st.status === 'dirty'
  useDirtyGuard(guardId, `the ${meta.name} editor`, dirty)
  // ready = the file has loaded. INITIAL is {content:'', savedContent:'', status:'loading'},
  // which compares equal and would clear the very draft the loader restores at :162.
  useDraftMirror(dKey, st.content, st.savedContent, st.status !== 'loading')
  const saving = st.status === 'saving'
  const capLabel = Number.isFinite(meta.capChars)
    ? `${len.toLocaleString()} / ${meta.capChars.toLocaleString()} chars`
    : `${len.toLocaleString()} chars`

  return (
    <div className="rounded-lg border border-[var(--panel-border)] p-3">
      <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono text-[13px] font-semibold text-[var(--text-primary)]">{meta.name}</span>
        <span className="rounded bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
          {meta.badge}
        </span>
        <div className="flex-1" />
        <span
          className={cn(
            'font-mono text-[11px]',
            cs === 'over' ? 'text-red-500' : cs === 'near' ? 'text-amber-500' : 'text-[var(--text-muted)]'
          )}
        >
          {capLabel}
        </span>
        {dirty && (
          <span className="flex items-center gap-1 text-[11px] text-amber-500">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden />
            dirty
          </span>
        )}
      </div>

      {st.status === 'loading' ? (
        <div className="h-28 animate-pulse rounded-md bg-[var(--bg-tertiary)]" aria-label="loading" />
      ) : st.status === 'loadError' ? (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 p-2 text-[12px] text-red-400">
          {st.error}{' '}
          <button className="underline" onClick={() => void load()}>
            retry
          </button>
        </div>
      ) : (
        <textarea
          value={st.content}
          onChange={(e) => onChange(e.target.value)}
          readOnly={saving}
          spellCheck={false}
          rows={meta.name === 'BRAIN.md' || meta.name === 'SOUL.md' ? 12 : 8}
          className="w-full resize-y rounded-md border border-[var(--panel-border)] bg-[var(--bg-primary)] px-3 py-2 font-mono text-[12px] leading-relaxed text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
        />
      )}

      {cs === 'over' && (
        <div className="mt-1 text-[11px] text-red-500">
          {meta.name === 'BRAIN.md'
            ? 'Over the 20 KB cap — the <agents_md> copy will be truncated with […truncated…].'
            : 'Over the surfaced budget — larger foundation files crowd curated memory out of the 6 KB grounding budget.'}
        </div>
      )}
      {cs === 'near' && (
        <div className="mt-1 text-[11px] text-amber-500">{t('Approaching the cap.')}</div>
      )}

      <div className="mt-1.5 text-[11px] text-[var(--text-muted)]">{meta.howUsed}</div>
      {st.absent && st.status !== 'saved' && (
        <div className="mt-1 text-[11px] text-[var(--text-muted)]">{t('Not yet created — saving will create it.')}</div>
      )}
      {st.status === 'saveError' && (
        <div className="mt-1 text-[11px] text-red-500">Save failed: {st.error} (your edit is preserved — retry).</div>
      )}

      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={() => void save()}
          disabled={!dirty || saving}
          className={cn(
            'rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors',
            !dirty || saving
              ? 'cursor-not-allowed bg-[var(--bg-tertiary)] text-[var(--text-muted)]'
              : 'bg-[var(--accent)] text-white hover:opacity-90'
          )}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {st.status === 'saved' && st.replacedTrashRel && (
          <span className="text-[11px] text-[var(--text-muted)]">
            prior version → <span className="font-mono">{st.replacedTrashRel}</span>
          </span>
        )}
      </div>
    </div>
  )
}

// ── Read-only DUIN-curated section (Phase 2) ─────────────────────────────────

function ReadOnlyCurated({ vault }: { vault: string }): React.ReactElement {
  const [memory, setMemory] = useState<{ content: string; error?: string } | null>(null)
  const [brainFiles, setBrainFiles] = useState<string[]>([])

  useEffect(() => {
    const api = filesApi()
    if (!api) return
    void (async () => {
      const res = await api.readText(joinVault(vault, 'MEMORY.md'))
      if (res.success && res.data) setMemory({ content: res.data.content })
      else setMemory({ content: '', error: res.error })
      // Best-effort listing of the .brain root (read-only visibility only).
      const bd = await api.listDir(joinVault(vault, '.brain'))
      if (bd.success && bd.data) setBrainFiles(bd.data.map((e) => (e.type === 'dir' ? e.name + '/' : e.name)))
    })()
  }, [vault])

  const reveal = (rel: string): void => {
    void filesApi()?.openInExplorer({ targetPath: joinVault(vault, rel) })
  }

  const memLen = memory?.content.length ?? 0
  const near = memoryNearCap(memLen)

  return (
    <div className="rounded-lg border border-[var(--panel-border)] p-3">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">{t('Curated by DUIN (read-only)')}</h3>
        <span className="rounded bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
          edits get overwritten
        </span>
      </div>
      <p className="mb-2 text-[11px] text-[var(--text-muted)]">
        Written by DUIN&apos;s memory loops. Hand-edits here get overwritten — edit them only if you know the loop that
        owns them.
      </p>

      <div className="mb-2 flex items-center gap-2">
        <span className="font-mono text-[12px] font-semibold text-[var(--text-primary)]">{t('MEMORY.md')}</span>
        <span className="rounded bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
          read-only
        </span>
        <span className={cn('font-mono text-[11px]', near ? 'text-amber-500' : 'text-[var(--text-muted)]')}>
          {memLen.toLocaleString()} / {MEMORY_GROUNDING_CAP.toLocaleString()} chars
        </span>
        <div className="flex-1" />
        <button className="text-[11px] text-[var(--accent)] underline" onClick={() => reveal('MEMORY.md')}>
          {t('Reveal in files')}
        </button>
      </div>
      {near && (
        <div className="mb-1 text-[11px] text-amber-500">
          MEMORY.md is near the 6 KB memory budget; larger files here evict smaller memories first.
        </div>
      )}
      {memory?.error ? (
        <div className="text-[11px] text-[var(--text-muted)]">No MEMORY.md yet ({memory.error}).</div>
      ) : (
        <pre className="max-h-40 overflow-auto rounded-md border border-[var(--panel-border)] bg-[var(--bg-primary)] p-2 text-[11px] leading-relaxed text-[var(--text-secondary)]">
          {(memory?.content ?? '').split('\n').slice(0, 40).join('\n') || '(empty)'}
        </pre>
      )}

      {brainFiles.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[12px] text-[var(--text-secondary)]">
            .brain/ ({brainFiles.length}) — identity.md, memory/*.md
          </summary>
          <ul className="mt-1 space-y-0.5">
            {brainFiles.map((f) => (
              <li key={f} className="flex items-center gap-2 font-mono text-[11px] text-[var(--text-muted)]">
                <span>.brain/{f}</span>
                <button className="text-[var(--accent)] underline" onClick={() => reveal('.brain/' + f)}>
                  reveal
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

// ── The pane ─────────────────────────────────────────────────────────────────

export function FoundationsSettings(): React.ReactElement {
  const vault = useSettingsStore((s) => s.settings.localBrainNotesDir ?? '')
  const openSettings = useUiStore((s) => s.openSettings)

  if (!vault) {
    return (
      <div className="space-y-4">
        <div>
          <h2 className="text-[14px] font-semibold text-[var(--text-primary)]">{t('Foundations')}</h2>
          <p className="mt-1 text-[12px] text-[var(--text-muted)]">
            {t('The vault-root files DUIN reads into its context every turn.')}
          </p>
        </div>
        <div className="rounded-lg border border-[var(--panel-border)] p-4 text-[12px] text-[var(--text-secondary)]">
          Set your brain folder first — <span className="font-medium text-[var(--text-primary)]">Settings → Brain</span>.
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[14px] font-semibold text-[var(--text-primary)]">{t('Foundations')}</h2>
          <span className="font-mono text-[11px] text-[var(--text-muted)]" title={vault}>
            vault: {vault}
          </span>
        </div>
        <p className="mt-1 text-[12px] text-[var(--text-muted)]">
          These files are read into DUIN&apos;s context every turn. DUIN picks up SOUL.md / ME.md / BRAIN.md on the
          next message, GOALS.md after the next graph refresh. This is your{' '}
          <span className="font-medium text-[var(--text-primary)]">Settings → Brain</span> folder.
        </p>
        <div className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-500">
          This is DUIN&apos;s live system prompt — malformed edits degrade answers until you fix them. Every save
          snapshots the prior version to <span className="font-mono">.trash</span> first, so edits are recoverable.
          Re-running Scaffold (Settings → Brain) regenerates these and snapshots your edits too.
        </div>
      </div>

      {FOUNDATION_FILES.map((meta) => (
        <FoundationEditor key={meta.name} meta={meta} vault={vault} />
      ))}

      <ReadOnlyCurated vault={vault} />

      <p className="text-[11px] text-[var(--text-muted)]">
        Looking for how DUIN talks? That&apos;s{' '}
        <button className="text-[var(--accent)] underline" onClick={() => openSettings('personality')}>
          Settings → Personality
        </button>
        .
      </p>
    </div>
  )
}
