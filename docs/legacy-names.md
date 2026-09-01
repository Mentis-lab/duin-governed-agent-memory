# Legacy names

DUIN started from the `lamprey-harness` agent shell, and a number of on-disk, environment and
internal identifiers still carry the `lamprey` name. They are listed here so nobody mistakes
one for a stray dependency or a bug. Renaming them means migrating user data, so they stay as
they are for now; a rename ships with a one-way migration when it happens.

Checked against the tree on 2026-09-01.

## On disk

| Identifier | Where | What it is |
| --- | --- | --- |
| `lamprey.db` | `<userData>/lamprey.db` (`electron/services/database.ts`) | The relational store: conversations, memory index, ledgers, hooks, sessions. |
| `lamprey-memory/` | `<userData>/lamprey-memory/<project>/<slug>.md` (`electron/services/memory-store.ts`) | "Remember this" memory files. The files are canonical; SQLite mirrors them. `.trash/` inside it holds soft-deleted memories. |
| `lamprey-YYYY-MM-DD.db` | `<userData>/backups/` (`electron/services/backup-runner.ts`) | Daily snapshots of `lamprey.db`. |
| `lamprey-git-tools`, `lamprey-research-helpers` | `resources/plugins/*/plugin.json`, copied to `<userData>/plugins/` | Bundled plugin ids. |
| `~/.lamprey-harness/plugins/` | The example plugin's documented path | Not read by DUIN; documentation residue in the example. |

`local-brain.db` (the notes index) and everything under a vault's `.brain/` and `.duin/`
already use the current names.

## Environment variables and build-time defines

| Name | Where | What it is |
| --- | --- | --- |
| `LAMPREY_HOOK_EVENT`, `LAMPREY_HOOK_TIMESTAMP`, `LAMPREY_HOOK_CONVERSATION_ID`, `LAMPREY_HOOK_TOOL_NAME`, `LAMPREY_HOOK_PROMPT_BODY`, `LAMPREY_HOOK_CWD` | `electron/services/hooks-runner.ts` | Environment given to legacy shell hooks. New hooks are JavaScript and do not use them. |
| `LAMPREY_BUILD_SHA`, `LAMPREY_BUILD_BRANCH`, `LAMPREY_BUILD_DIRTY`, `LAMPREY_BUILD_TIME`, `LAMPREY_BUILD_VERSION` | `electron.vite.config.ts` | Build provenance compiled into the main bundle. |
| `LAMPREY_GITHUB_CLIENT_ID`, `LAMPREY_GITHUB_CLIENT_SECRET` | `electron.vite.config.ts` | Optional build-time GitHub OAuth App credentials; see [github-setup.md](github-setup.md). |

## Flags, prefixes and internal ids

| Identifier | Where | What it is |
| --- | --- | --- |
| `--lamprey-headless` | `electron/services/headless-runner.ts` | Accepted as an alias of `--duin-headless` (the documented flag); `npm run lamprey` is an alias of `npm run duin`. |
| `lamprey-agent/<runId>` | `electron/services/executor/executor-review.ts` | Branch prefix for the git worktree an external executor run works in. |
| `lamprey://conversation/<id>` | `src/lib/deep-link.ts` | The legacy deep-link shape, still parsed. Current links use `duin://`. |
| `lamprey-mint` | `src/styles/theme-presets.ts` | A theme preset id. |
| `Lamprey*` type names (`LampreyToolDescriptor`, `LampreyAPI`, …) | `src/lib/types.ts` and imports | Internal TypeScript names. No runtime effect. |

## Retired

- `:8765`, the port of the former external engine. Nothing listens there; any target resolving
  to it is coerced to `:8799` by `resolveBrainUrl()`.
- **Brainframe**, the interim product name for the unpublished `0.1.0` and `0.2.0` builds. It
  survives only in the changelog and the lineage note in `brand.ts`. See [branding.md](branding.md).
