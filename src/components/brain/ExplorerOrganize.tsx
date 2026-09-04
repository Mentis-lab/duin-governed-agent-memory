import { t, tf } from '@/lib/i18n'
import { useEffect, useRef, useState } from 'react'
import type { BrainGraphData, BrainGraphNode } from '@/stores/brain-store'
import { createDoc, moveDoc, renameDoc, renameVaultFolder, setNodeLabel, type OrganizeOutcome } from '@/duin/lib/state'

// The Explorer's hands: rename a note, move it, rename a folder, start a note in a folder, name a
// derived entity. Small inline forms (no modal) that call the local brain's /state/organize
// routes and hand back what the panel needs to patch its in-memory graph at once, while the
// re-index catches up. The pure patch lives here too so it can be pinned in node tests.

export type OrganizeAction =
  | { kind: 'rename-note'; id: string; label: string }
  | { kind: 'move-note'; id: string; label: string }
  | { kind: 'rename-folder'; folder: string }
  | { kind: 'new-note'; folder: string }
  | { kind: 'label-node'; id: string; label: string }

export type OrganizeChange =
  | { kind: 'rename-note'; from: string; to: string; label: string; linksUpdated: number; notesTouched: number }
  | { kind: 'move-note'; from: string; to: string; linksUpdated: number; notesTouched: number }
  | { kind: 'rename-folder'; from: string; to: string; linksUpdated: number; notesTouched: number }
  | { kind: 'new-note'; path: string; label: string }
  | { kind: 'label-node'; id: string; label: string }

const posix = (p: string): string => p.replace(/\\/g, '/')
export const folderOf = (id: string): string => {
  const p = posix(id)
  const i = p.lastIndexOf('/')
  return i < 0 ? '' : p.slice(0, i)
}
export const topFolderOf = (id: string): string => {
  const p = posix(id)
  const i = p.indexOf('/')
  return i < 0 ? '' : p.slice(0, i)
}
const baseNoExt = (p: string): string => posix(p).split('/').pop()!.replace(/\.[^./]+$/, '')

/** A note node is a vault file: its id is the vault-relative path. */
export const isNoteId = (id: string): boolean => /\.(md|markdown|txt|canvas)$/i.test(id)

type LinkRef = { source: unknown; target: unknown; type?: string }
const idOf = (x: unknown): string => (x && typeof x === 'object' ? String((x as { id?: string }).id ?? '') : String(x ?? ''))

/** Apply an organize change to the in-memory graph so the tree, the detail pane and the map
 *  follow it immediately. The brain's re-index confirms it moments later. */
export function applyOrganizeToGraph(data: BrainGraphData, change: OrganizeChange): BrainGraphData {
  const remap = new Map<string, string>()
  let nodes = data.nodes
  switch (change.kind) {
    case 'rename-note':
    case 'move-note': {
      remap.set(change.from, change.to)
      nodes = data.nodes.map((n) =>
        n.id === change.from
          ? { ...n, id: change.to, label: change.kind === 'rename-note' ? change.label : n.label, group: topFolderOf(change.to) || n.group }
          : n
      )
      break
    }
    case 'rename-folder': {
      const prefix = change.from + '/'
      nodes = data.nodes.map((n) => {
        if (!n.id.startsWith(prefix)) return n
        const to = change.to + '/' + n.id.slice(prefix.length)
        remap.set(n.id, to)
        return { ...n, id: to, group: topFolderOf(to) || n.group }
      })
      break
    }
    case 'new-note': {
      const node: BrainGraphNode = { id: change.path, kind: 'note', label: change.label, layer: 'vault', group: topFolderOf(change.path) || undefined }
      nodes = [...data.nodes, node]
      break
    }
    case 'label-node':
      nodes = data.nodes.map((n) => (n.id === change.id ? { ...n, label: change.label, labelBy: 'operator' } : n))
      break
  }
  if (remap.size === 0) return { ...data, nodes }
  const links = (data.links as LinkRef[]).map((l) => {
    const s = idOf(l.source)
    const tg = idOf(l.target)
    const ns = remap.get(s)
    const nt = remap.get(tg)
    return ns || nt ? ({ ...l, source: ns ?? s, target: nt ?? tg } as BrainGraphData['links'][number]) : (l as BrainGraphData['links'][number])
  })
  return { ...data, nodes, links }
}

function summarize(o: OrganizeOutcome): string {
  const parts: string[] = []
  if (o.linksUpdated) parts.push(o.linksUpdated === 1 ? t('1 link updated') : tf('{n} links updated', { n: o.linksUpdated }))
  if (o.notesTouched) parts.push(o.notesTouched === 1 ? t('in 1 note') : tf('in {n} notes', { n: o.notesTouched }))
  return parts.join(' ')
}

interface OrganizeFormProps {
  action: OrganizeAction
  /** Existing top-level folders, for the move form's suggestions. */
  folders: string[]
  onDone: (change: OrganizeChange, note: string) => void
  onCancel: () => void
}

/** One inline form for every organize action: a label, one input, Save, Cancel, and the error
 *  next to the field. Enter saves, Escape cancels. */
export function OrganizeForm({ action, folders, onDone, onCancel }: OrganizeFormProps): React.ReactElement {
  const initial =
    action.kind === 'rename-note' ? baseNoExt(action.id)
    : action.kind === 'move-note' ? folderOf(action.id)
    : action.kind === 'rename-folder' ? action.folder
    : action.kind === 'label-node' ? action.label
    : ''
  const [value, setValue] = useState(initial)
  const [updateLinks, setUpdateLinks] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const label =
    action.kind === 'rename-note' ? t('New name')
    : action.kind === 'move-note' ? t('Move to folder')
    : action.kind === 'rename-folder' ? t('New folder name')
    : action.kind === 'new-note' ? t('New note name')
    : t('Name for this node')
  const hint =
    action.kind === 'rename-note' ? t('Links to this note are updated across your notes.')
    : action.kind === 'move-note' ? t('Leave empty for the vault root. A folder that does not exist yet is created.')
    : action.kind === 'rename-folder' ? t('Every note inside moves with it; links that name the folder are updated.')
    : action.kind === 'new-note' ? t('Created as a Markdown file in this folder and opened for editing.')
    : t('Your name for it; the extractor cannot overwrite it. Leave empty to go back to the extracted name.')

  const submit = async (): Promise<void> => {
    if (busy) return
    const v = value.trim()
    if (action.kind !== 'label-node' && action.kind !== 'move-note' && !v) {
      setError(t('A name is required.'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      switch (action.kind) {
        case 'rename-note': {
          const r = await renameDoc(action.id, v, updateLinks)
          onDone({ kind: 'rename-note', from: action.id, to: r.path, label: baseNoExt(r.path), linksUpdated: r.linksUpdated ?? 0, notesTouched: r.notesTouched ?? 0 }, summarize(r))
          break
        }
        case 'move-note': {
          const r = await moveDoc(action.id, v)
          onDone({ kind: 'move-note', from: action.id, to: r.path, linksUpdated: r.linksUpdated ?? 0, notesTouched: r.notesTouched ?? 0 }, summarize(r))
          break
        }
        case 'rename-folder': {
          const r = await renameVaultFolder(action.folder, v)
          onDone({ kind: 'rename-folder', from: action.folder, to: r.path, linksUpdated: r.linksUpdated ?? 0, notesTouched: r.notesTouched ?? 0 }, summarize(r))
          break
        }
        case 'new-note': {
          const r = await createDoc(action.folder, v)
          onDone({ kind: 'new-note', path: r.path, label: baseNoExt(r.path) }, '')
          break
        }
        case 'label-node': {
          await setNodeLabel(action.id, v)
          onDone({ kind: 'label-node', id: action.id, label: v || action.label }, '')
          break
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="my-1 rounded-md border border-[var(--accent)]/40 bg-[var(--bg-primary)] p-2" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel() } }}>
      <label className="block text-[11px] font-medium text-[var(--text-secondary)]">
        {label}
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submit() } }}
          list={action.kind === 'move-note' ? 'explorer-folders' : undefined}
          placeholder={action.kind === 'move-note' ? t('(vault root)') : undefined}
          disabled={busy}
          className="mt-1 w-full rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg)] px-2 py-1 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
        />
      </label>
      {action.kind === 'move-note' && (
        <datalist id="explorer-folders">
          {folders.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
      )}
      {action.kind === 'rename-note' && (
        <label className="mt-1.5 flex cursor-pointer items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
          <input type="checkbox" checked={updateLinks} onChange={(e) => setUpdateLinks(e.target.checked)} disabled={busy} />
          {t('Update links in other notes')}
        </label>
      )}
      <p className="mt-1 text-[11px] text-[var(--text-muted)]">{hint}</p>
      {error && <p className="mt-1 text-[11px] text-[var(--error)]">{error}</p>}
      <div className="mt-1.5 flex items-center gap-1.5">
        <button
          onClick={() => void submit()}
          disabled={busy}
          className="rounded-md bg-[var(--accent)] px-2.5 py-1 text-[11px] font-semibold text-[var(--accent-fg,#fff)] hover:opacity-90 active:translate-y-px disabled:opacity-50"
        >
          {busy ? t('Saving…') : t('Save')}
        </button>
        <button onClick={onCancel} disabled={busy} className="rounded-md px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]">
          {t('Cancel')}
        </button>
      </div>
    </div>
  )
}

export interface RowMenuItem {
  label: string
  onSelect: () => void
}

/** A quiet "⋯" that opens a small menu of actions for one row. Shown on hover and focus, always
 *  reachable by keyboard. Closes on outside click, Escape, or a pick. */
export function RowMenu({ items, title }: { items: RowMenuItem[]; title: string }): React.ReactElement {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v) }}
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`rounded px-1 text-[12px] leading-none text-[var(--text-muted)] transition-opacity hover:text-[var(--text-primary)] focus:opacity-100 ${open ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
      >
        ⋯
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-5 z-20 min-w-[150px] rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg)] py-1 shadow-lg">
          {items.map((it) => (
            <button
              key={it.label}
              role="menuitem"
              onClick={(e) => { e.stopPropagation(); setOpen(false); it.onSelect() }}
              className="block w-full px-2.5 py-1 text-left text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
