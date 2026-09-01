import { useEffect, useState, type ReactElement } from 'react'
import { CanvasEditor } from '@/components/artifacts/CanvasEditor'

// The standalone canvas window. Mounted INSTEAD of <App/> when the renderer is
// launched with `?canvas=<vault-relative path>` (see main.tsx and
// services/canvas/canvas-window.ts).
//
// It loads by PATH rather than receiving content, so the window and the side
// panel are two views of one file rather than two copies that drift.

export function CanvasWindow({ rel }: { rel: string }): ReactElement {
  const [value, setValue] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      const res = await window.api?.artifact?.readCanvas?.(rel)
      if (res?.success) setValue(res.data as string)
      else setError(res?.error ?? 'Could not read this canvas')
    })()
  }, [rel])

  if (error) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[var(--app-bg)] p-6 text-[13px] text-[var(--text-secondary)]">
        {error}
      </div>
    )
  }
  if (value === null) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[var(--app-bg)] text-[13px] text-[var(--text-muted)]">
        Loading {rel}…
      </div>
    )
  }
  return (
    <div className="h-screen w-screen bg-[var(--app-bg)]">
      <CanvasEditor value={value} onChange={setValue} fileRel={rel} />
    </div>
  )
}
