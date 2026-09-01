// Customize C6: bundled connector catalog rendered by AddConnectorFlow.
// Mirrors `resources/connectors/catalog.json` (the on-disk source of
// truth installers can copy verbatim) — keeping both is intentional so
// the renderer ships a typed module and the on-disk file can be edited
// without a rebuild.
import type { McpServerConfig, Requirement } from '@/lib/types'

// Every entry below spawns through `npx`, which is npm's shim and is NOT part of
// DUIN. The app bundles Electron's own Node for its OWN servers (mcp-defaults uses
// process.execPath + ELECTRON_RUN_AS_NODE), but a catalog entry resolves `npx` from
// PATH like any other command. On a machine without Node every one of these fails
// identically and late, at connect, as a generic transport error. Declaring the
// dependency turns that into one honest sentence before anything is spawned.
const NEEDS_NPX: Requirement = {
  kind: 'binary',
  name: 'npx',
  hint: 'Install Node.js (nodejs.org) — npx ships with it — then reconnect.'
}

export interface CatalogEntry extends Omit<McpServerConfig, 'status'> {
  env?: Record<string, string>
  description: string
  category: string
}

export const CONNECTORS_CATALOG: CatalogEntry[] = [
  {
    id: 'terminator',
    name: 'Windows Desktop (Terminator)',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'terminator-mcp-agent'],
    auth: 'none',
    enabled: false,
    description:
      'Computer use: drive real Windows apps (WeChat, Excel, native tools) via the UI Automation ' +
      'accessibility tree — click, type, and read controls by name/role. Attended by default: every ' +
      'actuating tool requires approval and is CAP-floored in unattended runs. Off until you enable it.',
    requires: [NEEDS_NPX],
    category: 'Computer Use'
  },
  {
    id: 'computer-use',
    name: 'Computer Use (screen + mouse + keyboard)',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@zavora-ai/computer-use-mcp'],
    auth: 'none',
    enabled: false,
    description:
      'Computer use: screenshot the desktop and drive mouse/keyboard on any Windows app (UIA with a ' +
      'pixel fallback). Attended by default — actuating tools require approval. Off until you enable it.',
    requires: [NEEDS_NPX],
    category: 'Computer Use'
  },
  {
    id: 'playwright',
    name: 'Playwright Browser',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    auth: 'none',
    enabled: true,
    description:
      'Headless Chromium driving via Playwright. Lets the agent navigate URLs, click elements, and snapshot pages.',
    requires: [NEEDS_NPX],
    category: 'Browser'
  },
  {
    id: 'filesystem',
    name: 'Filesystem',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', './'],
    auth: 'none',
    enabled: true,
    description:
      'Read + write files inside the current workspace. Defaults to the project root; pass an explicit directory in args to scope it.',
    requires: [NEEDS_NPX],
    category: 'Files'
  },
  {
    id: 'github',
    name: 'GitHub',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_TOKEN: '' },
    auth: 'none',
    enabled: true,
    description:
      'Read repositories, open PRs, manage issues. Set GITHUB_TOKEN in the env block to authenticate.',
    requires: [
      NEEDS_NPX,
      {
        kind: 'env',
        name: 'GITHUB_TOKEN',
        hint: 'Create a GitHub personal access token and paste it into the env block on this connector.'
      }
    ],
    category: 'Dev tools'
  },
  {
    id: 'postgres',
    name: 'Postgres',
    transport: 'stdio',
    command: 'npx',
    args: [
      '-y',
      '@modelcontextprotocol/server-postgres',
      'postgresql://user:pass@localhost:5432/dbname'
    ],
    auth: 'none',
    // Off by default: the args carry a PLACEHOLDER connection string, so auto-connecting on Add would
    // drop the user into an instant "connection refused" error. Added disabled → the user edits the
    // string to their real DB, THEN enables. (github/slack use empty ENV tokens, harmless until set;
    // a placeholder DB target is not.)
    enabled: false,
    description:
      'Run read-only queries against a Postgres database. Replace the placeholder connection string in args, then enable.',
    requires: [NEEDS_NPX],
    category: 'Databases'
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sqlite', './db.sqlite'],
    auth: 'none',
    // Off by default: `./db.sqlite` is a PLACEHOLDER path, so auto-connecting on Add would error on a
    // missing file. Added disabled → the user points args at their real `.sqlite`, THEN enables.
    enabled: false,
    description:
      'Query a SQLite database file. Replace the placeholder path in args with your `.sqlite` file, then enable.',
    requires: [NEEDS_NPX],
    category: 'Databases'
  },
  {
    id: 'memory',
    name: 'Knowledge Graph Memory',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    auth: 'none',
    enabled: true,
    description:
      'Persistent knowledge-graph memory the agent can write to and recall from across turns.',
    requires: [NEEDS_NPX],
    category: 'Knowledge'
  },
  {
    id: 'fetch',
    name: 'HTTP Fetch',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-fetch'],
    auth: 'none',
    enabled: true,
    description:
      'Fetch arbitrary URLs and convert them to Markdown for grounded reading.',
    requires: [NEEDS_NPX],
    category: 'Web'
  },
  {
    id: 'slack',
    name: 'Slack',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    env: { SLACK_BOT_TOKEN: '', SLACK_TEAM_ID: '' },
    auth: 'none',
    enabled: true,
    description:
      'Read channels, messages, and threads, and post messages. Set SLACK_BOT_TOKEN + SLACK_TEAM_ID in the env block. (Slack ingest into your brain is configured separately under Connections.)',
    requires: [
      NEEDS_NPX,
      {
        kind: 'env',
        name: 'SLACK_BOT_TOKEN',
        hint: 'Create a Slack app, install it to the workspace, and paste its bot token into the env block.'
      },
      {
        kind: 'env',
        name: 'SLACK_TEAM_ID',
        hint: 'Your Slack workspace/team id — starts with T.'
      }
    ],
    category: 'Communication'
  }
]
