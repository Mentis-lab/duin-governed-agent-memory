import type { McpServerConfig } from '@/lib/types'

// "stdio" is a protocol word, not a product word. Users read it as noise, and nothing
// in the app ever defined it — so a connector row said STDIO and left the reader no
// way to know what would happen when they connected. These labels answer the only
// question that matters at that moment: does this run on my machine, or reach out?

export interface TransportLabel {
  /** Column value — the word the user reads. */
  label: string
  /** Tooltip — what connecting actually does. */
  hint: string
}

const LOCAL: TransportLabel = {
  label: 'Local',
  hint: 'Runs as a program on this computer. It can reach whatever you can reach.'
}

const REMOTE: TransportLabel = {
  label: 'Remote',
  hint: 'Connects over the web to a server someone else runs. Your requests leave this machine.'
}

/** Local byte-stream schemes: a `url` does NOT by itself mean the server is remote. */
const LOCAL_URL_SCHEME = /^(unix|pipe):/i

export function transportLabel(
  transport: McpServerConfig['transport'],
  url?: string
): TransportLabel {
  if (transport === 'stdio') return LOCAL
  if (url && LOCAL_URL_SCHEME.test(url)) return LOCAL
  return REMOTE
}

/** True when adding this server means handing data to someone else's infrastructure —
 *  the case that deserves a trust warning. */
export function isRemote(transport: McpServerConfig['transport'], url?: string): boolean {
  return transportLabel(transport, url) === REMOTE
}
