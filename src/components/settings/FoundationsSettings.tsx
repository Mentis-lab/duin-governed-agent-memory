import { t, tf } from '@/lib/i18n'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useDirtyGuard, useDraftMirror, dropDraft } from '@/hooks/useDirtyGuard'
import { draftKey, readDraft } from '@/lib/dirty-guard'
import { useSettingsStore } from '@/stores/settings-store'
import { toast } from '@/stores/toast-store'
import { invoke, query } from '@/lib/ipc-client'
import { describeError } from '@/lib/result'
import { panelError, panelLoading, panelReady, type PanelStatus } from '@/lib/panel-state'
import { PanelState } from '@/components/ui/PanelState'
import { Button } from '@/components/ui/Button'
import { cn } from '@/duin/lib/utils'
import {
  SettingsPage,
  SettingsSection,
  SettingsRow,
  SettingsLink,
  SettingsLoadError,
  SettingsLoading
} from '@/components/ui/settings'

// Foundations — edit the vault-root foundation files that DUIN reads into its
// context every turn (SOUL.md / BRAIN.md / ME.md) and the north-star tracks it
// parses on graph build (GOALS.md). Saves go through the path-whitelisted,
// snapshot-before-overwrite handler (brain:writeFoundationFile); the vault root is
// resolved main-side, never passed from here. Read-only visibility into the
// DUIN-curated MEMORY.md / .brain/* with a "don't hand-edit, the loops own this" tag.
//
// This page keeps the explicit Save + dirty-guard model on purpose: each editor holds
// a multi-line draft of the live system prompt, and auto-applying a half-typed
// BRAIN.md would degrade every answer until the operator finished the sentence.

// ── Pure config + helpers (exported for unit tests; the component is not
//    render-testable in this repo's node-only test env). ──────────────────────

export type FoundationName = 'SOUL.md' | 'ME.md' | 'BRAIN.md' | 'GOALS.md'

export interface FoundationMeta {
  name: FoundationName
  /** Hard/soft char cap surfaced to the operator. Infinity = no prompt-budget cap. */
  capChars: number
  /** Whether the cap is a hard truncation (BRAIN's second copy) vs a soft/shared budget. */
  capKind: 'hard' | 'shared' | 'none'
  /** Short uppercase tag beside the file name. Resolves lazily so it follows the UI language. */
  badge: () => string
  /** One-line "how this is used" note under the editor. Lazy, as above. */
  howUsed: () => string
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
/** The 20 KB hard cap the agents-md loader truncates BRAIN.md's second copy at. */
export const AGENTS_MD_CAP = 20000

/** The editable files, in the order the model receives them. IDENTITY_FOUNDATION_ORDER
 *  (electron/services/brain/foundation-files.ts) is SOUL → BRAIN → ME; GOALS.md follows
 *  because it reaches the model through the graph rather than the identity block. */
export const FOUNDATION_FILES: readonly FoundationMeta[] = [
  {
    name: 'SOUL.md',
    capChars: Infinity,
    capKind: 'none',
    badge: () => t('always in context · read first · no limit'),
    howUsed: () =>
      t('Who DUIN is: character and voice. Read before BRAIN.md, because rules are followed literally while character covers what no rule anticipated. Sent in full every turn, so its length is a cost you pay per message.')
  },
  {
    name: 'BRAIN.md',
    capChars: AGENTS_MD_CAP,
    capKind: 'hard',
    badge: () => t('always in context · sent twice'),
    howUsed: () =>
      t('DUIN’s own identity and operating contract. It reaches the prompt twice, so one edit changes both. Over 20,000 characters, the second copy is cut short.')
  },
  {
    name: 'ME.md',
    capChars: Infinity,
    capKind: 'none',
    badge: () => t('always in context · no limit'),
    howUsed: () =>
      t('Who you are as the operator. Grounds every “who is the owner” answer, read fresh each turn. Sent in full every turn, so its length is a cost you pay per message.')
  },
  {
    name: 'GOALS.md',
    capChars: Infinity,
    capKind: 'none',
    badge: () => t('graph and forecasts only'),
    howUsed: () =>
      t('Your north-star tracks. Parsed into the brain graph on rebuild, not per turn, so an edit takes effect after the next graph refresh (triggered on save).')
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

/** A read that failed because the file is not there — a real state ("not created yet"),
 *  distinct from a permission error or a dead bridge. */
function isMissingFile(error: string | undefined): boolean {
  return /not found|no such file|ENOENT/i.test(error ?? '')
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

const CAP_TEXT: Record<CapState, string> = {
  under: 'text-[var(--text-muted)]',
  near: 'text-[var(--warning)]',
  over: 'text-[var(--error)]'
}
const CAP_TONE: Record<CapState, 'default' | 'warning' | 'danger'> = {
  under: 'default',
  near: 'warning',
  over: 'danger'
}

// ── One editable file editor ─────────────────────────────────────────────────

function FoundationEditor({ meta, vault }: { meta: FoundationMeta; vault: string }): React.ReactElement {
  const [st, setSt] = useState<EditorState>(INITIAL)
  const savedRef = useRef('')
  // U3. Esc, or clicking any other Settings tab, used to destroy this draft:
  // SettingsDialog unmounts the tab conditionally, there was a dirty badge and NO
  // confirm anywhere. The guard below is what makes leaving the tab ask first.
  const guardId = `settings:foundations:${meta.name}`
  const dKey = draftKey('foundation', meta.name)
  const restoredRef = useRef(false)

  const load = useCallback(async () => {
    const api = filesApi()
    setSt((s) => ({ ...s, status: 'loading' }))
    const r = await query(meta.name, api ? () => api.readText(joinVault(vault, meta.name)) : undefined)
    if (r.ok) {
      savedRef.current = r.data.content
      // Restore a mirrored draft ONCE, on first load — a reload mid-edit is the
      // case no confirm can cover. Later reloads (the onUpdated broadcast below)
      // must not resurrect a draft the operator has since saved or abandoned.
      const draft = restoredRef.current ? null : readDraft(dKey)
      restoredRef.current = true
      if (draft !== null && draft !== r.data.content) {
        setSt({ content: draft, savedContent: r.data.content, status: 'dirty', absent: false })
        toast.info(tf('Restored your unsaved {name} draft', { name: meta.name }))
        return
      }
      setSt({ content: r.data.content, savedContent: r.data.content, status: 'clean', absent: false })
    } else if (isMissingFile(r.error)) {
      // Absent file is NOT an error — offer an empty editable buffer.
      savedRef.current = ''
      setSt({ content: '', savedContent: '', status: 'clean', absent: true })
    } else {
      setSt({ ...INITIAL, status: 'loadError', error: r.error })
    }
  }, [vault, meta.name, dKey])

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
    const body = st.content
    setSt((s) => ({ ...s, status: 'saving', error: undefined }))
    try {
      const data = await invoke(
        tf('save {name}', { name: meta.name }),
        api ? () => api.writeFoundationFile(meta.name, body) : undefined
      )
      savedRef.current = body
      dropDraft(dKey)
      const replacedTrashRel = data?.replacedTrashRel
      setSt((s) => ({ ...s, savedContent: body, status: 'saved', absent: false, replacedTrashRel }))
      toast.success(
        replacedTrashRel
          ? tf('Saved {name}. Previous version moved to {path}', { name: meta.name, path: replacedTrashRel })
          : tf('Saved {name}', { name: meta.name })
      )
    } catch (e) {
      // The edit stays in the box: a failed save still holds the operator's only copy.
      setSt((s) => ({ ...s, status: 'saveError', error: describeError(e, t('Save failed')) }))
    }
  }

  const len = st.content.length
  const cs = capState(len, meta.capChars)
  const dirty = st.status === 'dirty'
  useDirtyGuard(guardId, tf('the {name} editor', { name: meta.name }), dirty)
  // ready = the file has loaded. INITIAL is {content:'', savedContent:'', status:'loading'},
  // which compares equal and would clear the very draft the loader restores above.
  useDraftMirror(dKey, st.content, st.savedContent, st.status !== 'loading')
  const saving = st.status === 'saving'
  const capLabel = Number.isFinite(meta.capChars)
    ? tf('{n} / {cap} characters', { n: len.toLocaleString(), cap: meta.capChars.toLocaleString() })
    : tf('{n} characters', { n: len.toLocaleString() })

  return (
    <SettingsRow
      tone={CAP_TONE[cs]}
      label={
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono">{meta.name}</span>
          <span className="rounded bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wide text-[var(--text-muted)]">
            {meta.badge()}
          </span>
        </span>
      }
      hint={meta.howUsed()}
      control={
        <span className="flex items-center gap-2">
          <span className={cn('font-mono text-[11px]', CAP_TEXT[cs])}>{capLabel}</span>
          {dirty && (
            <span className="flex items-center gap-1 text-[11px] text-[var(--warning)]">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--warning)]" aria-hidden />
              {t('Unsaved')}
            </span>
          )}
        </span>
      }
    >
      {st.status === 'loading' ? (
        <div
          role="status"
          aria-label={tf('Loading {what}…', { what: meta.name })}
          className="h-28 animate-pulse rounded-md bg-[var(--bg-tertiary)]"
        />
      ) : st.status === 'loadError' ? (
        <SettingsLoadError what={meta.name} message={st.error ?? t('Could not read file')} onRetry={() => void load()} />
      ) : (
        <textarea
          aria-label={meta.name}
          value={st.content}
          onChange={(e) => onChange(e.target.value)}
          readOnly={saving}
          spellCheck={false}
          rows={meta.name === 'BRAIN.md' || meta.name === 'SOUL.md' ? 12 : 8}
          className="w-full resize-y rounded-md border border-[var(--panel-border)] bg-[var(--bg-primary)] px-3 py-2 font-mono text-[12px] leading-relaxed text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
        />
      )}

      {/* Only BRAIN.md has a finite cap (its second copy is truncated at 20 KB); the
          identity block itself is never cut, so there is no "over" message for the rest. */}
      {cs === 'over' && (
        <p className="mt-1 text-[11px] text-[var(--error)]">
          {t('Over the 20,000-character limit. The second copy DUIN sends is cut short at that point.')}
        </p>
      )}
      {cs === 'near' && <p className="mt-1 text-[11px] text-[var(--warning)]">{t('Approaching the cap.')}</p>}
      {st.absent && st.status !== 'saved' && (
        <p className="mt-1 text-[11px] text-[var(--text-muted)]">{t('Not yet created — saving will create it.')}</p>
      )}
      {st.status === 'saveError' && (
        <p className="mt-1 text-[11px] text-[var(--error)]">
          {tf('Save failed: {error}. Your edit is kept, so you can retry.', { error: st.error ?? '' })}
        </p>
      )}

      <div className="mt-2 flex items-center gap-2">
        <Button variant="primary" onClick={() => void save()} disabled={!dirty || saving}>
          {saving ? t('Saving…') : t('Save')}
        </Button>
        {st.status === 'saved' && st.replacedTrashRel && (
          <span className="font-mono text-[11px] text-[var(--text-muted)]">
            {tf('Previous version moved to {path}', { path: st.replacedTrashRel })}
          </span>
        )}
      </div>
    </SettingsRow>
  )
}

// ── Read-only DUIN-curated section ───────────────────────────────────────────

interface MemoryRead {
  content: string
  /** The file does not exist yet — a real state, never painted as a read failure. */
  absent: boolean
}

function ReadOnlyCurated({ vault }: { vault: string }): React.ReactElement {
  const [memory, setMemory] = useState<PanelStatus<MemoryRead>>(panelLoading())
  const [brainFiles, setBrainFiles] = useState<PanelStatus<string[]>>(panelLoading())

  const load = useCallback(async () => {
    const api = filesApi()
    setMemory(panelLoading())
    setBrainFiles(panelLoading())
    const mem = await query('MEMORY.md', api ? () => api.readText(joinVault(vault, 'MEMORY.md')) : undefined)
    if (mem.ok) setMemory(panelReady({ content: mem.data.content, absent: false }))
    else if (isMissingFile(mem.error)) setMemory(panelReady({ content: '', absent: true }))
    else setMemory(panelError<MemoryRead>(mem.error, mem.cause))
    // The .brain root, listed for visibility only.
    const dir = await query(t('the .brain folder'), api ? () => api.listDir(joinVault(vault, '.brain')) : undefined)
    if (dir.ok) setBrainFiles(panelReady(dir.data.map((e) => (e.type === 'dir' ? e.name + '/' : e.name))))
    else if (isMissingFile(dir.error)) setBrainFiles(panelReady<string[]>([]))
    else setBrainFiles(panelError<string[]>(dir.error, dir.cause))
  }, [vault])

  useEffect(() => {
    void load()
  }, [load])

  const reveal = async (rel: string): Promise<void> => {
    const api = filesApi()
    try {
      await invoke(t('reveal in files'), api ? () => api.openInExplorer({ targetPath: joinVault(vault, rel) }) : undefined)
    } catch (e) {
      toast.error(describeError(e, t('Could not reveal that file')))
    }
  }

  const memLen = memory.phase === 'ready' ? memory.data.content.length : 0
  // loadBrain keeps the SMALLEST memory files first and drops the biggest until the block
  // fits, so a MEMORY.md over the budget is itself the file that gets cut — `over`, not "near".
  const memCs = capState(memLen, MEMORY_GROUNDING_CAP)
  const brainWhat = t('the .brain folder')

  return (
    <>
      <SettingsRow
        tone={CAP_TONE[memCs]}
        label={<span className="font-mono">MEMORY.md</span>}
        hint={t('Maintained by DUIN’s memory loops.')}
        control={
          <span className="flex items-center gap-2">
            <span className={cn('font-mono text-[11px]', CAP_TEXT[memCs])}>
              {tf('{n} / {cap} characters', { n: memLen.toLocaleString(), cap: MEMORY_GROUNDING_CAP.toLocaleString() })}
            </span>
            <Button size="sm" onClick={() => void reveal('MEMORY.md')}>
              {t('Reveal in files')}
            </Button>
          </span>
        }
      >
        {memCs === 'over' && (
          <p className="mb-2 text-[11px] text-[var(--error)]">
            {t('Over 6 KB, MEMORY.md is cut from the prompt before smaller memories.')}
          </p>
        )}
        {memCs === 'near' && (
          <p className="mb-2 text-[11px] text-[var(--warning)]">
            {t('Near the 6 KB memory budget. Over 6 KB, MEMORY.md is cut from the prompt before smaller memories.')}
          </p>
        )}
        <PanelState
          state={memory}
          loading={<SettingsLoading what="MEMORY.md" />}
          error={(message, retry) => <SettingsLoadError what="MEMORY.md" message={message} onRetry={retry} />}
          empty={<p className="text-[11px] text-[var(--text-muted)]">{t('No MEMORY.md yet. DUIN creates it as it learns.')}</p>}
          isEmpty={(d) => d.absent}
          onRetry={() => void load()}
        >
          {(d) => (
            <pre className="max-h-40 overflow-auto rounded-md border border-[var(--panel-border)] bg-[var(--bg-secondary)] p-2 text-[11px] leading-relaxed text-[var(--text-secondary)]">
              {d.content.split('\n').slice(0, 40).join('\n') || t('(empty)')}
            </pre>
          )}
        </PanelState>
      </SettingsRow>

      <PanelState
        state={brainFiles}
        loading={null}
        error={(message, retry) => <SettingsLoadError what={brainWhat} message={message} onRetry={retry} />}
        empty={null}
        onRetry={() => void load()}
      >
        {(files) => (
          <SettingsRow label={<span className="font-mono">.brain/</span>} hint={t('DUIN’s own identity and memory files, kept beside your notes.')}>
            <details>
              <summary className="cursor-pointer text-[12px] text-[var(--text-secondary)]">
                {tf('Show {n} items', { n: files.length })}
              </summary>
              <ul className="mt-1 space-y-0.5">
                {files.map((f) => (
                  <li key={f} className="flex items-center gap-2 font-mono text-[11px] text-[var(--text-muted)]">
                    <span>.brain/{f}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={tf('Reveal {path} in files', { path: '.brain/' + f })}
                      onClick={() => void reveal('.brain/' + f)}
                    >
                      {t('Reveal')}
                    </Button>
                  </li>
                ))}
              </ul>
            </details>
          </SettingsRow>
        )}
      </PanelState>
    </>
  )
}

// ── The pane ─────────────────────────────────────────────────────────────────

export function FoundationsSettings(): React.ReactElement {
  const vault = useSettingsStore((s) => s.settings.localBrainNotesDir ?? '')

  if (!vault) {
    return (
      <SettingsPage purpose={t('These files are read into DUIN’s context every turn.')}>
        <SettingsRow
          label={t('Set your brain folder first')}
          hint={t('These files live in your vault, so DUIN needs to know where that is.')}
          control={<SettingsLink tab="brain">{t('Open Brain settings')}</SettingsLink>}
        />
      </SettingsPage>
    )
  }

  return (
    <SettingsPage
      purpose={
        <>
          {t('These files are read into DUIN’s context every turn.')}{' '}
          {t('SOUL.md, BRAIN.md and ME.md apply from your next message; GOALS.md after the next graph refresh.')}
          <br />
          <span className="font-mono text-[11px]" title={vault}>
            {vault}
          </span>
        </>
      }
    >
      <SettingsRow
        tone="warning"
        label={t('Edit with care')}
        hint={
          <>
            {t('These files are DUIN’s live instructions, so a broken edit degrades answers until you fix it. Every save keeps the previous version in .trash.')}{' '}
            {t('Re-running Scaffold regenerates them and keeps your edits in .trash too.')}{' '}
            <SettingsLink tab="brain">{t('Scaffold is under Brain')}</SettingsLink>
          </>
        }
      />

      <SettingsSection label={t('Files you edit')}>
        {FOUNDATION_FILES.map((meta) => (
          <FoundationEditor key={meta.name} meta={meta} vault={vault} />
        ))}
      </SettingsSection>

      <SettingsSection
        label={t('Curated by DUIN (read-only)')}
        description={t('Written by DUIN’s memory loops. Hand edits here are overwritten, so change them only if you know the loop that owns them.')}
      >
        <ReadOnlyCurated vault={vault} />
      </SettingsSection>

      <p className="text-[11px] text-[var(--text-muted)]">
        {t('Looking for how DUIN talks?')} <SettingsLink tab="personality">{t('Open Personality')}</SettingsLink>
      </p>
    </SettingsPage>
  )
}
