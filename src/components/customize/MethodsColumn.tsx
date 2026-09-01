import { t } from '@/lib/i18n'
import { useEffect, useMemo, useState } from 'react'
import { prepareMethodRun, type Workflow, type WorkflowWire } from '@/duin/lib/state'
import { useSkillsStore } from '@/stores/skills-store'
import { useMethodsStore, type MethodDraft } from '@/stores/methods-store'
import { useUiStore } from '@/stores/ui-store'
import { useChatStore } from '@/stores/chat-store'
import { PanelEmptyState } from '@/components/ui/PanelEmptyState'
import { IconButton } from '@/components/ui/IconButton'
import { Button } from '@/components/ui/Button'
import { toast } from '@/stores/toast-store'

// The "Methods" capability layer — composed skill DAGs authored as `type: method`
// notes in your brain vault. A method WIRES skills together, plus (for operator-style
// vaults) judgment kinds value/framework/strategy/agent.
//
// Only `skill` wires resolve — against the live installed skills (useSkillsStore).
// A matched skill shows as a real, clickable chip; an unmatched one is shown muted
// ("not installed") so the user sees what a method WANTS vs. what they HAVE. Judgment
// kinds DUIN has no native equivalent for render as plain muted labels — never broken
// links — so the panel looks correct on a DUIN with only skills.

/** The bundled skill that interviews the user and writes the note. Authoring a method
 *  well takes a conversation, and Customize cannot run one — so the deep path hands off
 *  to chat rather than pretending a form is enough. */
const AUTHORING_SKILL = 'method-creator'

const EMPTY_DRAFT: MethodDraft = {
  name: '',
  description: '',
  deliverable: '',
  callsSkills: [],
  content: ''
}

export function MethodsColumn() {
  const methods = useMethodsStore((s) => s.methods)
  const loading = useMethodsStore((s) => s.loading)
  const error = useMethodsStore((s) => s.error)
  const loadMethods = useMethodsStore((s) => s.loadMethods)
  const deleteMethod = useMethodsStore((s) => s.deleteMethod)
  const readMethod = useMethodsStore((s) => s.readMethod)

  const [filter, setFilter] = useState('')
  const [editing, setEditing] = useState<(MethodDraft & { path?: string }) | null>(null)
  const skills = useSkillsStore((s) => s.skills)
  const openCustomize = useUiStore((s) => s.openCustomize)
  const closeCustomize = useUiStore((s) => s.closeCustomize)

  useEffect(() => {
    void loadMethods()
  }, [loadMethods])

  // Mutations broadcast, so a method written from chat (or another window) shows up
  // without reopening the panel.
  useEffect(() => {
    if (!window.api?.methods?.onChanged) return
    const dispose = window.api.methods.onChanged(() => {
      void loadMethods()
    }) as unknown
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  }, [loadMethods])

  // RUN a method: resolve its wired skills against the installed set, activate the
  // matches, and send a grounded prompt through the normal chat loop (which injects
  // active skills). This is the "consume" half — the method actually produces output.
  const runMethod = async (m: Workflow) => {
    try {
      const run = await prepareMethodRun(m.path)
      if (!run) {
        toast.error('Could not prepare this method')
        return
      }
      const wanted = new Set(run.skillWires)
      const matchedIds = skills.filter((s) => wanted.has(s.id) || wanted.has(s.name)).map((s) => s.id)
      const store = useSkillsStore.getState()
      // Merge the method's skills into the active set AND pass them into THIS turn — the
      // backend resolves skills from sendMessage's arg, not the store, so an empty array
      // here would make the just-activated skills miss the very turn they were activated for.
      const activeForRun = [...new Set([...store.activeSkillIds, ...matchedIds])]
      store.setActiveSkillIds(activeForRun)
      void useChatStore.getState().sendMessage(run.prompt, activeForRun)
      closeCustomize()
      const total = run.skillWires.length
      const missing = total - matchedIds.length
      toast.success(
        `Running "${run.name}" — activated ${matchedIds.length}/${total} skill${total === 1 ? '' : 's'}` +
          (missing > 0 ? ` (${missing} not installed)` : '')
      )
    } catch (e) {
      toast.error(`Couldn't run method: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** Hand authoring to the skill, in chat, with it active for that turn. */
  const authorWithDuin = () => {
    const store = useSkillsStore.getState()
    const authoring = skills.find((s) => s.id === AUTHORING_SKILL || s.name === AUTHORING_SKILL)
    if (!authoring) {
      toast.error(`The "${AUTHORING_SKILL}" skill isn't installed.`)
      return
    }
    const active = [...new Set([...store.activeSkillIds, authoring.id])]
    store.setActiveSkillIds(active)
    void useChatStore
      .getState()
      .sendMessage('Help me build a new method. Interview me for what it should produce.', active)
    closeCustomize()
  }

  const onEdit = async (m: Workflow) => {
    const draft = await readMethod(m.path)
    if (draft) setEditing(draft)
  }

  const onDelete = async (m: Workflow) => {
    if (!confirm(`Delete the method "${m.name}"? A copy is kept in the methods archive.`)) return
    if (await deleteMethod(m.path)) toast.success(`Deleted "${m.name}"`)
  }

  const onImport = async () => {
    const r = await window.api?.methods?.pickAndImport?.()
    if (!r) return
    if (!r.success) {
      toast.error(r.error ?? 'Import failed')
      return
    }
    if (r.data?.canceled) return
    const imported: string[] = r.data?.imported ?? []
    const skipped: unknown[] = r.data?.skipped ?? []
    if (imported.length === 0) {
      toast.error(
        skipped.length
          ? `No new methods imported (${skipped.length} skipped — already present or not a method note).`
          : 'No methods found in that folder.'
      )
      return
    }
    toast.success(
      `Imported ${imported.length} method${imported.length === 1 ? '' : 's'}` +
        (skipped.length ? `, skipped ${skipped.length}` : '')
    )
  }

  // Live skill index — a `skill` wire resolves if its name matches a loaded DUIN
  // skill by id OR frontmatter name (the wikilink leaf is usually the skill slug).
  const skillNames = useMemo(() => {
    const set = new Set<string>()
    for (const s of skills) {
      set.add(s.id)
      set.add(s.name)
    }
    return set
  }, [skills])

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return methods
    return methods.filter(
      (m) => m.name.toLowerCase().includes(q) || (m.desc ?? '').toLowerCase().includes(q)
    )
  }, [methods, filter])

  const revealSkills = () => openCustomize('skills')

  const header = (
    <div className="flex shrink-0 items-center gap-2 border-b border-[var(--panel-border)] px-3 py-2">
      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder={
          loading
            ? 'Loading methods…'
            : `Filter ${methods.length} method${methods.length === 1 ? '' : 's'}…`
        }
        className="min-w-0 flex-1 rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] px-2 py-1 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
      />
      <button
        onClick={() => void onImport()}
        className="rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] px-2 py-1 text-[12px] hover:border-[var(--accent)]"
        title={t('Import methods from another vault or a shared folder')}
      >
        Import…
      </button>
      <button
        onClick={() => setEditing({ ...EMPTY_DRAFT })}
        className="rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] px-2 py-1 text-[12px] hover:border-[var(--accent)]"
        title={t('Create a new method')}
      >
        + New
      </button>
    </div>
  )

  const editor = editing && (
    <MethodEditor draft={editing} onClose={() => setEditing(null)} onAuthor={authorWithDuin} />
  )

  // A failed read is not an empty library — name which one it was, so "no vault
  // configured" never reads as "you have no methods".
  if (error) {
    return (
      <div className="flex h-full flex-col">
        {header}
        <div className="flex-1 overflow-y-auto p-2">
          <PanelEmptyState
            icon={<span className="text-[20px]">🧩</span>}
            title={t("Couldn't load methods")}
            body={<>{error}</>}
          />
        </div>
        {editor}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {header}
      <div className="flex-1 overflow-y-auto p-2">
        {methods.length === 0 && !loading && (
          <PanelEmptyState
            icon={<span className="text-[20px]">🧩</span>}
            title={t('No methods yet')}
            body={
              <>
                A method wires skills into a way of working — what it produces, and the
                steps to get there. Start one with <strong>+ New</strong>, or import a
                folder of them.
              </>
            }
          />
        )}
        {methods.length > 0 && filtered.length === 0 && (
          <div className="px-3 py-6 text-center text-[12px] text-[var(--text-muted)]">
            {t('No methods match this filter.')}
          </div>
        )}
        {filtered.map((m) => (
          <MethodCard
            key={m.path}
            method={m}
            skillNames={skillNames}
            onRevealSkills={revealSkills}
            onRun={() => runMethod(m)}
            onEdit={() => void onEdit(m)}
            onDelete={() => void onDelete(m)}
          />
        ))}
      </div>
      {editor}
    </div>
  )
}

function MethodCard({
  method,
  skillNames,
  onRevealSkills,
  onRun,
  onEdit,
  onDelete
}: {
  method: Workflow
  skillNames: Set<string>
  onRevealSkills: () => void
  onRun: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const wires = method.wires ?? []
  // Count how many of the method's skill wires are actually installed — a compact
  // "have vs. wants" signal in the header.
  const skillWires = wires.filter((w) => w.kind === 'skill')
  const installedCount = skillWires.filter((w) => skillNames.has(w.name)).length

  return (
    <div className="group mb-1.5 rounded-lg border border-[var(--panel-border)] bg-[var(--bg-primary)] p-2.5">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-[var(--text-primary)]">
          {method.name}
        </span>
        {method.stages ? (
          <span className="shrink-0 rounded-full bg-[var(--bg-tertiary)] px-2 py-0.5 text-[11px] tabular-nums text-[var(--text-muted)]">
            {method.stages} stage{method.stages === 1 ? '' : 's'}
          </span>
        ) : null}
        <div className="flex shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100">
          <button
            onClick={onEdit}
            className="rounded p-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
            title={t('Edit')}
            aria-label={t('Edit')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
          </button>
          <button
            onClick={onDelete}
            className="rounded p-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--error)]"
            title={t('Delete')}
            aria-label={t('Delete')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        </div>
      </div>
      {method.desc && (
        <p className="mt-1 text-[12px] leading-snug text-[var(--text-secondary)]">{method.desc}</p>
      )}
      {method.deliverable && (
        <p className="mt-1 text-[11px] leading-snug text-[var(--text-muted)]">
          <span className="uppercase tracking-wide">produces</span> · {method.deliverable}
        </p>
      )}
      {wires.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <span className="mr-0.5 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
            wires
            {skillWires.length > 0 && (
              <span className="ml-1 normal-case tracking-normal">
                ({installedCount}/{skillWires.length} skills)
              </span>
            )}
          </span>
          {wires.map((w, i) => (
            <WireChip
              key={`${w.kind}:${w.name}:${i}`}
              wire={w}
              skillNames={skillNames}
              onRevealSkills={onRevealSkills}
            />
          ))}
        </div>
      )}
      <div className="mt-2.5 flex items-center justify-end">
        <Button
          variant="primary"
          size="sm"
          onClick={onRun}
          title={t("Activate this method's skills and run it in chat to produce the deliverable")}
        >
          {t('Run method')}
        </Button>
      </div>
    </div>
  )
}

function MethodEditor({
  draft: initial,
  onClose,
  onAuthor
}: {
  draft: MethodDraft & { path?: string }
  onClose: () => void
  onAuthor: () => void
}) {
  const createMethod = useMethodsStore((s) => s.createMethod)
  const updateMethod = useMethodsStore((s) => s.updateMethod)
  const skills = useSkillsStore((s) => s.skills)
  const [draft, setDraft] = useState<MethodDraft>({
    name: initial.name,
    description: initial.description,
    deliverable: initial.deliverable,
    callsSkills: initial.callsSkills,
    content: initial.content
  })
  const [saving, setSaving] = useState(false)
  const isNew = !initial.path

  const onSave = async () => {
    if (!draft.name.trim()) {
      toast.error('A method needs a name')
      return
    }
    setSaving(true)
    try {
      const ok = initial.path ? await updateMethod(initial.path, draft) : await createMethod(draft)
      if (ok) onClose()
    } finally {
      setSaving(false)
    }
  }

  // Picked from the installed set rather than typed: `calls-skills` only resolves when
  // the name matches a real skill, and a typo produces a silent "not installed" chip.
  const toggleSkill = (name: string) => {
    setDraft((d) => ({
      ...d,
      callsSkills: d.callsSkills.includes(name)
        ? d.callsSkills.filter((s) => s !== name)
        : [...d.callsSkills, name]
    }))
  }

  return (
    <div className="fixed inset-0 z-40 flex items-stretch justify-end bg-black/40">
      <div className="flex h-full w-[480px] flex-col border-l border-[var(--panel-border)] bg-[var(--bg-secondary)] shadow-2xl">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--panel-border)] px-4">
          <span className="text-[14px] font-semibold text-[var(--text-primary)]">
            {isNew ? 'New method' : 'Edit method'}
          </span>
          <div className="flex-1" />
          <IconButton onClick={onClose} aria-label={t('Close')}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </IconButton>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {isNew && (
            <div className="rounded-md border border-[var(--accent-dim)] bg-[var(--accent-dim)]/10 px-3 py-2 text-[12px] text-[var(--text-secondary)]">
              Not sure what the steps should be?{' '}
              <button
                onClick={onAuthor}
                className="font-medium text-[var(--accent)] underline-offset-2 hover:underline"
              >
                {t('Author it with DUIN')}
              </button>{' '}
              — it interviews you in chat and writes the method for you.
            </div>
          )}

          <label className="block text-[11px] text-[var(--text-muted)]">
            Name
            <input
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              className="mt-1 w-full rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] px-2 py-1.5 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            />
          </label>

          <label className="block text-[11px] text-[var(--text-muted)]">
            Description
            <input
              value={draft.description}
              onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              className="mt-1 w-full rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] px-2 py-1.5 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            />
          </label>

          <label className="block text-[11px] text-[var(--text-muted)]">
            Produces
            <input
              value={draft.deliverable}
              onChange={(e) => setDraft((d) => ({ ...d, deliverable: e.target.value }))}
              placeholder="a debrief that preserves insider judgment verbatim"
              className="mt-1 w-full rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] px-2 py-1.5 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            />
          </label>

          <div className="text-[11px] text-[var(--text-muted)]">
            Composes these skills
            <div className="mt-1 flex flex-wrap gap-1">
              {skills.length === 0 && <span>{t('No skills installed yet.')}</span>}
              {skills.map((s) => {
                const on = draft.callsSkills.includes(s.name) || draft.callsSkills.includes(s.id)
                return (
                  <button
                    key={s.id}
                    onClick={() => toggleSkill(s.name)}
                    className={
                      'rounded-full border px-2 py-0.5 text-[11px] transition-colors ' +
                      (on
                        ? 'border-[var(--accent)]/40 bg-[var(--accent)]/10 text-[var(--accent)]'
                        : 'border-[var(--panel-border)] text-[var(--text-muted)] hover:border-[var(--accent)]')
                    }
                  >
                    {s.name}
                  </button>
                )
              })}
            </div>
          </div>

          <label className="block text-[11px] text-[var(--text-muted)]">
            Body (Markdown)
            <textarea
              value={draft.content}
              onChange={(e) => setDraft((d) => ({ ...d, content: e.target.value }))}
              spellCheck={false}
              placeholder={'## Method\n\nWhen to reach for this.\n\n## Steps\n\n1. First move.\n2. Then this.'}
              className="mt-1 h-64 w-full resize-y rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] p-2 font-mono text-[12px] leading-relaxed text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            />
          </label>
          <p className="text-[11px] text-[var(--text-muted)]">
            Running a method lifts its <code className="font-mono">## Steps</code> section into
            the prompt, so keep that heading — the rest is yours.
          </p>
        </div>

        <footer className="flex shrink-0 items-center gap-2 border-t border-[var(--panel-border)] px-4 py-3">
          <button
            onClick={onClose}
            className="rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] px-3 py-1.5 text-[12px] hover:border-[var(--accent)]"
          >
            {t('Cancel')}
          </button>
          <div className="flex-1" />
          <Button
            variant="primary"
            className="border-[var(--accent)]"
            onClick={() => void onSave()}
            disabled={saving || !draft.name.trim()}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </footer>
      </div>
    </div>
  )
}

function WireChip({
  wire,
  skillNames,
  onRevealSkills
}: {
  wire: WorkflowWire
  skillNames: Set<string>
  onRevealSkills: () => void
}) {
  if (wire.kind === 'skill') {
    if (skillNames.has(wire.name)) {
      // Installed skill → a real, clickable chip that jumps to the Skills column.
      return (
        <button
          type="button"
          onClick={onRevealSkills}
          title={`Skill "${wire.name}" — open the Skills column`}
          className="rounded-full border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-2 py-0.5 text-[11px] font-medium text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/20"
        >
          {wire.name}
        </button>
      )
    }
    // Wanted but not installed in DUIN — visible gap, not a broken link.
    return (
      <span
        title={`Skill "${wire.name}" is not installed in DUIN`}
        className="rounded-full border border-dashed border-[var(--panel-border)] px-2 py-0.5 text-[11px] text-[var(--text-muted)] opacity-70"
      >
        {wire.name} · not installed
      </span>
    )
  }
  // Judgment kinds (value / framework / strategy / agent / method / note) — DUIN
  // has no native equivalent, so a plain muted label. The `title` keeps the kind legible.
  return (
    <span
      title={`${wire.kind}: ${wire.name}`}
      className="rounded-full bg-[var(--bg-tertiary)] px-2 py-0.5 text-[11px] text-[var(--text-muted)]"
    >
      {wire.name}
    </span>
  )
}
