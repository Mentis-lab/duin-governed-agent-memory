// A shared `components` object for ReactMarkdown that hands links to the shell.
//
// A bare <a href> inside the renderer is a DEAD CLICK: same-window navigation is blocked
// by main.ts's global navigation guard, so the link does nothing at all. Three surfaces
// rendered untrusted or model-supplied markdown this way — the Brain note reader, the
// Library document viewer (ingested PDF/HTML/MD text), and the chat transcript's markdown
// fences — which is why this lives in one place rather than being pasted a fourth time.
//
// Same handoff the artifact MarkdownRenderer uses, so every markdown surface behaves alike.

import type { ReactNode } from 'react'

export function openExternalHref(href: string | undefined): void {
  if (!href) return
  if (window.api?.artifact?.openExternal) window.api.artifact.openExternal(href)
  else window.open(href, '_blank', 'noreferrer')
}

/** Spread into `<ReactMarkdown components={{ ...externalLinkComponents }}>`. */
export const externalLinkComponents = {
  a: ({ href, children, ...rest }: { href?: string; children?: ReactNode }) => (
    <a
      href={href}
      {...rest}
      onClick={(e) => {
        if (!href) return
        e.preventDefault()
        openExternalHref(href)
      }}
    >
      {children}
    </a>
  )
}
