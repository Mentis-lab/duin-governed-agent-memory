import { t } from '@/lib/i18n'
import { useEffect, useMemo, useRef, useState } from 'react'
import { IconButton } from '@/components/ui/IconButton'
import { PopoverMenu } from '@/components/ui/PopoverMenu'
import { Button } from '@/components/ui/Button'
import { Toggle } from '@/components/ui/Toggle'
import type { Skill } from '@/lib/types'
import { toast } from '@/stores/toast-store'
import { useSkillsStore } from '@/stores/skills-store'
import { NewSkillWizard } from './NewSkillWizard'
import { SkillFileBrowser } from './SkillFileBrowser'

interface SkillDraft {
  name: string
  description: string
  content: string
}

function isBundledSkill(skill: Skill): boolean {
  // Sourced from the seed manifest by skill-loader, not sniffed from the path.
  // The old path test (`filePath.includes('/resources/skills/')`) could never
  // be true in EITHER mode: dev read `<repo>/skills` and prod reads a copy in
  // `userData/skills`. So this returned false for every skill, always, and the
  // bundled/user distinction silently never rendered.
  return skill.bundled === true
}

function validateDraft(draft: SkillDraft): string[] {
  const errors: string[] = []
  if (!draft.name.trim()) errors.push('name is required')
  if (!draft.description.trim()) errors.push('description is required')
  if (!draft.content.trim()) errors.push('content is required')
  return errors
}

interface EditDrawerProps {
  skill: Skill
  onClose: () => void
}

function EditDrawer({ skill, onClose }: EditDrawerProps) {
  const updateSkill = useSkillsStore((s) => s.updateSkill)
  const [draft, setDraft] = useState<SkillDraft>({
    name: skill.name,
    description: skill.description,
    content: skill.content
  })
  const errors = useMemo(() => validateDraft(draft), [draft])
  const bundled = isBundledSkill(skill)

  const onSave = async () => {
    if (errors.length) {
      toast.error(errors[0])
      return
    }
    await updateSkill(skill.id, draft)
    toast.success(`Skill "${draft.name}" saved`)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-40 flex items-stretch justify-end bg-black/40">
      <div className="flex h-full w-[480px] flex-col border-l border-[var(--panel-border)] bg-[var(--bg-secondary)] shadow-2xl">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--panel-border)] px-4">
          <span className="text-[14px] font-semibold text-[var(--text-primary)]">
            {t('Edit skill')}
          </span>
          {bundled && (
            <span className="rounded bg-[var(--bg-tertiary)] px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
              bundled
            </span>
          )}
          <div className="flex-1" />
          <IconButton
            onClick={onClose}
            aria-label={t('Close')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </IconButton>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          <div className="truncate font-mono text-[11px] text-[var(--text-muted)]" title={skill.filePath}>
            {skill.filePath}
          </div>

          <label className="block text-[11px] text-[var(--text-muted)]">
            Name
            <input
              value={draft.name}
              onChange={(e) => setDraft((s) => ({ ...s, name: e.target.value }))}
              className="mt-1 w-full rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] px-2 py-1.5 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            />
          </label>

          <label className="block text-[11px] text-[var(--text-muted)]">
            Description
            <input
              value={draft.description}
              onChange={(e) => setDraft((s) => ({ ...s, description: e.target.value }))}
              className="mt-1 w-full rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] px-2 py-1.5 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            />
          </label>

          {/* Picking `SKILL.md` keeps the editable textarea; any other file opens
              read-only, so browsing a skill's assets can't corrupt them. */}
          <SkillFileBrowser
            skillId={skill.id}
            definitionSlot={
              <textarea
                value={draft.content}
                onChange={(e) => setDraft((s) => ({ ...s, content: e.target.value }))}
                spellCheck={false}
                aria-label={t('Skill content (Markdown)')}
                className="h-72 w-full resize-y rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] p-2 font-mono text-[12px] leading-relaxed text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              />
            }
          />

          <div
            className={
              'rounded border px-2 py-1.5 text-[11px] ' +
              (errors.length
                ? 'border-[var(--error)] bg-[var(--error)]/10 text-[var(--error)]'
                : 'border-[var(--success)] bg-[var(--success)]/10 text-[var(--success)]')
            }
          >
            {errors.length ? `Issues: ${errors.join(', ')}` : 'Ready to save'}
          </div>
        </div>

        <footer className="flex shrink-0 items-center gap-2 border-t border-[var(--panel-border)] px-4 py-3">
          <button
            onClick={onClose}
            className="rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] px-3 py-1.5 text-[12px] hover:border-[var(--accent)]"
          >
            {t('Cancel')}
          </button>
          <div className="flex-1" />
          <Button variant="primary" className="border-[var(--accent)]"
            onClick={() => void onSave()}
            disabled={errors.length > 0}
          >
            {t('Save')}
          </Button>
        </footer>
      </div>
    </div>
  )
}

export function SkillsColumn() {
  const skills = useSkillsStore((s) => s.skills)
  const activeSkillIds = useSkillsStore((s) => s.activeSkillIds)
  const loadSkills = useSkillsStore((s) => s.loadSkills)
  const setSkillsFromEvent = useSkillsStore((s) => s.setSkillsFromEvent)
  const toggleSkill = useSkillsStore((s) => s.toggleSkill)
  const deleteSkill = useSkillsStore((s) => s.deleteSkill)

  const [filter, setFilter] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [importMenuOpen, setImportMenuOpen] = useState(false)
  const importBtnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    void loadSkills()
  }, [loadSkills])

  useEffect(() => {
    if (!window.api?.skills?.onChanged) return
    const dispose = window.api.skills.onChanged((rows) => {
      setSkillsFromEvent(rows as Skill[])
    }) as unknown
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  }, [setSkillsFromEvent])

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return skills
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
    )
  }, [skills, filter])

  const editing = useMemo(
    () => skills.find((s) => s.id === editingId) ?? null,
    [skills, editingId]
  )

  const onDelete = async (skill: Skill) => {
    if (!confirm(`Delete skill "${skill.name}"?`)) return
    await deleteSkill(skill.id)
  }

  // Import skills from a folder (Claude Code, a vault `.claude/skills`, another
  // agent's collection) or from a packaged .zip. Both land through the same importer,
  // so both get the never-overwrite rule; the list live-updates via skills:changed.
  const runImport = async (
    pick: (() => Promise<{ success: boolean; error?: string; data?: Record<string, unknown> } | undefined>) | undefined,
    emptyMessage: string
  ) => {
    setImportMenuOpen(false)
    const r = await pick?.()
    if (!r) return
    if (!r.success) {
      toast.error(r.error ?? 'Import failed')
      return
    }
    if (r.data?.canceled) return
    const imported = (r.data?.imported as string[]) ?? []
    const skipped = (r.data?.skipped as unknown[]) ?? []
    if (imported.length === 0) {
      toast.error(
        skipped.length
          ? `No new skills imported (${skipped.length} skipped — already present or missing a name).`
          : emptyMessage
      )
      return
    }
    toast.success(
      `Imported ${imported.length} skill${imported.length === 1 ? '' : 's'}` +
        (skipped.length ? `, skipped ${skipped.length}` : '')
    )
  }

  // Hand a skill to someone else whole — definition plus every bundled asset.
  const onExport = async (skill: Skill) => {
    const r = await window.api?.skills?.exportPackage?.(skill.id)
    if (!r) return
    if (!r.success) {
      toast.error(r.error ?? 'Export failed')
      return
    }
    if (r.data?.canceled) return
    const files: number = r.data?.files ?? 0
    toast.success(`Exported "${skill.name}" — ${files} file${files === 1 ? '' : 's'}`)
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--panel-border)] px-3 py-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={`Filter ${skills.length} skill${skills.length === 1 ? '' : 's'}…`}
          className="min-w-0 flex-1 rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] px-2 py-1 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
        />
        <button
          ref={importBtnRef}
          onClick={() => setImportMenuOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={importMenuOpen}
          className="rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] px-2 py-1 text-[12px] hover:border-[var(--accent)]"
          title={t('Import skills from a folder or a packaged .zip')}
        >
          Import…
        </button>
        <PopoverMenu
          open={importMenuOpen}
          onClose={() => setImportMenuOpen(false)}
          anchorRef={importBtnRef}
          align="bottom-end"
          minWidth={220}
          ariaLabel="Import skills"
        >
          <button
            role="menuitem"
            onClick={() =>
              void runImport(window.api?.skills?.pickAndImport, 'No skills found in that folder.')
            }
            className="block w-full px-3 py-1.5 text-left text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
          >
            From a folder…
            <span className="block text-[11px] text-[var(--text-muted)]">
              A Claude Code or <span className="font-mono">.claude/skills</span> library
            </span>
          </button>
          <button
            role="menuitem"
            onClick={() =>
              void runImport(window.api?.skills?.importPackage, 'That package had no skills in it.')
            }
            className="block w-full px-3 py-1.5 text-left text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
          >
            From a package…
            <span className="block text-[11px] text-[var(--text-muted)]">
              A <span className="font-mono">.zip</span> exported from DUIN or claude.ai
            </span>
          </button>
        </PopoverMenu>
        <button
          onClick={() => setWizardOpen(true)}
          className="rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] px-2 py-1 text-[12px] hover:border-[var(--accent)]"
          title={t('Create a new skill')}
        >
          + New
        </button>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto p-2">
        {filtered.length === 0 && (
          <div className="px-3 py-6 text-center text-[12px] text-[var(--text-muted)]">
            {skills.length === 0 ? 'No skills installed yet.' : 'No skills match this filter.'}
          </div>
        )}
        {filtered.map((skill) => {
          const enabled = activeSkillIds.includes(skill.id)
          const bundled = isBundledSkill(skill)
          return (
            <div
              key={skill.id}
              className="group mb-1 flex items-start gap-2 rounded border border-transparent p-2 hover:border-[var(--panel-border)] hover:bg-[var(--bg-tertiary)]"
            >
              <Toggle
                checked={enabled}
                onChange={() => toggleSkill(skill.id)}
                aria-label={enabled ? 'Disable skill' : 'Enable skill'}
                className="mt-0.5"
              />

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[12px] font-medium text-[var(--text-primary)]">
                    {skill.name}
                  </span>
                  {skill.pluginId && (
                    <span
                      className="rounded bg-[var(--bg-tertiary)] px-1 py-0 font-mono text-[11px] uppercase tracking-wider text-[var(--accent)]"
                      title={`From plugin: ${skill.pluginId}`}
                    >
                      plugin: {skill.pluginId}
                    </span>
                  )}
                  {bundled && !skill.pluginId && (
                    <span className="rounded bg-[var(--bg-tertiary)] px-1 py-0 font-mono text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
                      bundled
                    </span>
                  )}
                </div>
                <div className="mt-0.5 truncate text-[11px] text-[var(--text-secondary)]">
                  {skill.description || 'No description'}
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100">
                <button
                  onClick={() => void onExport(skill)}
                  className="rounded p-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-primary)] hover:text-[var(--text-primary)]"
                  title={t('Export as a package (.zip) — definition plus every bundled file')}
                  aria-label={t('Export')}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                </button>
                <button
                  onClick={() => setEditingId(skill.id)}
                  className="rounded p-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-primary)] hover:text-[var(--text-primary)]"
                  title={t('Edit')}
                  aria-label={t('Edit')}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                </button>
                <button
                  onClick={() => void onDelete(skill)}
                  className="rounded p-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-primary)] hover:text-[var(--error)]"
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
          )
        })}
      </div>

      {editing && <EditDrawer skill={editing} onClose={() => setEditingId(null)} />}
      {wizardOpen && <NewSkillWizard onClose={() => setWizardOpen(false)} />}
    </div>
  )
}
