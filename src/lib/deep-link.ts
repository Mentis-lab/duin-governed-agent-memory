import type { CustomizeColumnId, SettingsTabId, ToolId } from '@/stores/ui-store'

// Deep links — the one thing that turns a notification from text into navigation.
//
// The app previously understood exactly one shape, `lamprey://conversation/<id>`, a
// spelling left over from the rename. The only link it ever emitted was
// `duin://home-digest`, so every notification click focused the window and stopped
// there. This parser is the shared vocabulary for both halves.
//
// `duin://` is NOT registered with the OS (no setAsDefaultProtocolClient) — it is an
// in-app convention, the same one canvas link-nodes already use. Nothing here should
// assume a link can arrive from outside the app.

export type DeepLink =
  | { kind: 'tool'; toolId: ToolId }
  | { kind: 'customize'; column: CustomizeColumnId }
  | { kind: 'settings'; tab: SettingsTabId }
  | { kind: 'conversation'; conversationId: string }

/** Every surface a `duin://tool/…` link may name. Typed as `Record<ToolId, true>`
 *  ON PURPOSE: deleting a surface from the union is a TYPE ERROR until it is deleted
 *  here too, and adding one is a type error until it is listed.
 *
 *  This was a plain `Set<string>`, and that is precisely how it rotted. The
 *  2026-07-07 surface consolidation folded Calibration into the Status hub and Loops
 *  into the Automations hub, retiring seven ToolIds — browser, environment, loop,
 *  status, people, orgs, calibration — and the Set went on cheerfully accepting all
 *  seven, because a `Set<string>` has no opinion about a union it was hand-copied
 *  from. Nothing looked broken from either end: producers still emitted the links,
 *  the parser still "resolved" them, so `followDeepLink` returned TRUE and callers
 *  skipped their "no longer available" fallback — while `setActiveTool` force-opened
 *  the right panel onto an id `ToolsPanel` has no case for. A blank panel with an
 *  undefined header, and no explanation. That is exactly the guess the contract
 *  below forbids. */
const TOOL_IDS: Record<ToolId, true> = {
  files: true, review: true, terminal: true, sources: true, artifacts: true,
  plan: true, background: true, afterAction: true, brain: true, learning: true,
  automations: true, graphReport: true, decisions: true, library: true,
  homeStatus: true, relations: true, home: true
}

const CUSTOMIZE_COLUMNS = new Set<string>(['skills', 'methods', 'connectors', 'plugins'])

/** Settings tabs a `duin://settings/…` link may open. An ALLOWLIST, not the whole
 *  SettingsTabId union, for the same reason TOOL_IDS is exhaustive: a link that opens
 *  the dialog on a tab id `SettingsDialog` has no case for renders a blank pane. Only
 *  tabs a notice actually deep-links to belong here — grow it when a new producer needs
 *  one. `executors` is the keep/discard review surface. */
const SETTINGS_TABS: Record<string, true> = {
  executors: true,
  // Where the provider order and keys live; the failure → notice watcher (proactive/watchers.ts)
  // links every model-failure notice here.
  models: true,
  api: true,
  // The corrupt-settings notice (ipc/settings.ts) points at the backups and import surface.
  persistence: true
}

/**
 * Parse a deep link into something the app can act on, or null when it names nothing
 * real. Returning null rather than guessing matters: a link that silently resolves to
 * the wrong surface is worse than one that visibly does nothing.
 *
 * Accepted:
 *   duin://tool/<toolId>              a right-panel surface
 *   duin://customize/<column>         a Customize column
 *   duin://conversation/<id>          a conversation
 *   conversation:<id>                 legacy, still emitted by the notify tool
 *   lamprey://conversation/<id>       legacy, pre-rename
 */
export function parseDeepLink(raw: string | null | undefined): DeepLink | null {
  if (typeof raw !== 'string') return null
  const link = raw.trim()
  if (!link) return null

  const legacy = link.match(/^(?:conversation:|lamprey:\/\/conversation\/)(.+)$/)
  if (legacy?.[1]) return { kind: 'conversation', conversationId: legacy[1] }

  const duin = link.match(/^duin:\/\/([^/]+)\/(.+)$/)
  if (!duin) return null
  const [, host, rest] = duin
  const value = decodeURIComponent(rest).replace(/\/+$/, '')
  if (!value) return null

  switch (host) {
    case 'tool':
      // hasOwnProperty, not `in`: `in` walks the prototype chain, so `duin://tool/toString`
      // would "resolve" to a surface that has never existed.
      return Object.prototype.hasOwnProperty.call(TOOL_IDS, value)
        ? { kind: 'tool', toolId: value as ToolId }
        : null
    case 'customize':
      return CUSTOMIZE_COLUMNS.has(value)
        ? { kind: 'customize', column: value as CustomizeColumnId }
        : null
    case 'settings':
      return Object.prototype.hasOwnProperty.call(SETTINGS_TABS, value)
        ? { kind: 'settings', tab: value as SettingsTabId }
        : null
    case 'conversation':
      return { kind: 'conversation', conversationId: value }
    default:
      return null
  }
}

/** Build a link to a surface. Producers should use this rather than hand-writing the
 *  string, so a renamed ToolId is a compile error instead of a dead notification. */
export function toolLink(toolId: ToolId): string {
  return `duin://tool/${toolId}`
}

// (No settingsLink() producer helper: the only producer is the executor review notice in the
//  MAIN process, which cannot import this renderer module and uses the literal string. The
//  SETTINGS_TABS allowlist above is the shared contract that keeps the two in step.)
