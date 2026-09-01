import { t } from '@/lib/i18n'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'

// D2 — "to-write" pip surface for broken memory `[[link]]` markers.
//
// The memory store extracts every `[[name]]` reference from each entry's
// body and reports back the targets that don't yet resolve to a file.
// This component shows them as a quiet sidebar pip so the user can
// promote casual cross-references into real entries.
//
// Wired post-D3: D3's MemoryEditor opens with `target` pre-filled when
// the user clicks a pip. For now we expose `onPick` so the eventual
// editor mount can do that; if no handler is provided we just render
// the pip list.

interface BrokenLink {
  from: string
  fromFilePath: string
  target: string
}

interface Props {
  projectSlug?: string
  onPick?: (target: string, fromSlug: string) => void
}

export function MemoryLinkGraph({ projectSlug, onPick }: Props) {
  const [links, setLinks] = useState<BrokenLink[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false

    const refresh = async () => {
      const api = (window as any).api
      if (!api?.memory?.listBrokenLinks) return
      const res = await api.memory.listBrokenLinks(projectSlug)
      if (cancelled) return
      if (res?.success) {
        setLinks((res.data as BrokenLink[]) ?? [])
        setLoaded(true)
      }
    }

    void refresh()

    // Re-fetch when any memory write/delete fires the `memory:changed`
    // broadcast so the pip count stays in sync with the editor.
    const api = (window as any).api
    const unsubscribe = api?.memory?.onChanged?.(() => {
      void refresh()
    })

    return () => {
      cancelled = true
      if (typeof unsubscribe === 'function') unsubscribe()
    }
  }, [projectSlug])

  if (!loaded) return null

  // Dedupe by target — the same `[[name]]` referenced from N entries
  // should surface as one pip with a count, not N pips.
  const grouped = new Map<string, BrokenLink[]>()
  for (const link of links) {
    const bucket = grouped.get(link.target) ?? []
    bucket.push(link)
    grouped.set(link.target, bucket)
  }
  const pips = [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))

  if (pips.length === 0) return null

  return (
    <div className="mt-2 border-t border-[var(--panel-border)] px-2 pt-2">
      <div className="mb-1 flex items-center gap-1.5 px-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
          {t('To write')}
        </span>
        <span className="rounded bg-[var(--bg-tertiary)] px-1 text-[11px] text-[var(--text-secondary)]">
          {pips.length}
        </span>
      </div>
      <div className="flex flex-wrap gap-1 px-1">
        {pips.map(([target, refs]) => (
          <Button variant="secondary" className="border-dashed bg-[var(--bg-tertiary)] hover:border-[var(--accent)]"
            key={target}
            onClick={() => onPick?.(target, refs[0]?.from ?? '')}
            title={`Referenced by: ${refs.map((r) => r.from).join(', ')}`}
          >
            [[{target}]]{refs.length > 1 ? ` ×${refs.length}` : ''}
          </Button>
        ))}
      </div>
    </div>
  )
}
