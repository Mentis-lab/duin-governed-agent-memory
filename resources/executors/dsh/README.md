# The dsh executor runtime

DUIN's external executor spawns the DeepSeek Harness (dsh) headless runtime from this
directory as a child process and drives it over stdio JSON-RPC. See
`PLANNING/DUIN_EXTERNAL_EXECUTOR_PLAN.md` for the design and
`electron/services/executor/` for the code.

- `package.json` pins the runtime as ONE set (every `@deepseek-ai/dsh-*` package is a single
  workspace release; they must move together) plus `duin-gate`, DUIN's in-child tool gate.
- `node_modules/` is **staged, never committed**: `node scripts/stage-dsh-runtime.mjs` runs
  `npm ci` here from the lockfile. `--check` verifies the artifacts the executor needs
  (`bin.js`, the `koffi` and `node-pty` prebuilt binaries for this platform, `duin-gate`).
- The composition (`cordis.yml`) is generated per run by `executor-runtime.ts`, because the
  shell rows depend on what the machine has (`pwsh` → `bash` → file tools only) and the
  paths differ per worktree. Nothing here is a template to hand-edit.
- The runtime runs under DUIN's own Node (`ELECTRON_RUN_AS_NODE=1`, `process.execPath`), so a
  user needs no Node, npm or dsh install. The only credential is the DeepSeek key DUIN holds.
