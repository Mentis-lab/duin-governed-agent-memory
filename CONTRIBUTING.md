# Contributing to DUIN

Thanks for the interest. DUIN is opinionated and the contributor bar is "ship the simplest
thing that works, and prove it." Read this file before opening a PR.

DUIN started from the MIT-licensed [lamprey-harness](https://github.com/USS-Parks/Lamprey-Harness)
by Basho Parks. If a change is a general agent-shell improvement rather than something specific
to DUIN's brain, graph or governance, consider contributing it upstream too.

---

## Before you start

- **Open an issue first** for anything larger than a bug fix, so the design is agreed before
  the code exists.
- **One feature per PR.** Do not fold an unrelated refactor into a feature commit, and do not
  put tooling changes in a UI PR.
- **Keep PRs under about 600 changed lines.** Reviewers cannot hold more than that, and big
  PRs land slower. Split them.

## Prerequisites

- **Node.js 22.12 or newer** and npm.
- **git**.
- **Windows:** clone into a short path (for example `C:\src\DUIN`) or enable long paths.
- **Optional:** Python 3 and a C/C++ toolchain, only if you need to rebuild native modules
  yourself. `npm run setup` (which runs `npm ci --ignore-scripts` and then installs the Electron binary) uses
  the prebuilt `better-sqlite3` binding; a plain `npm ci` triggers a no-op native build that still
  needs Python and a C/C++ toolchain.

## Setup

```bash
git clone https://github.com/Mentis-lab/duin-governed-agent-memory
cd duin-governed-agent-memory
npm run setup
npm run dev              # electron-vite dev: launches Electron against the source tree
```

`npm run dev` shares port `8799` with an installed DUIN, so quit the installed app first.

## Required before every PR

```bash
npm run typecheck && npm run lint && npm test
```

`npm run typecheck` runs both tsc projects (`tsconfig.web.json`, `tsconfig.node.json`),
`npm run lint` is ESLint, and `npm test` is the vitest suite (`electron/**/*.test.ts`,
`src/**/*.test.{ts,tsx}`).

The full gate is `npm run verify:proof`: every lint in `package.json` (cohesion, signal,
language parity, reachability, preload surface, unsupplied input, bundle safety, loop
liveness), the lints' own tests, both typechecks and the unit suite, in one command.
`npm run verify:proof -- --no-tests` runs the static half; that is what CI's lint job runs.

`npm run build` (electron-vite) followed by `npm run smoke:bundle` and `npm run smoke:renderer`
loads the packaged main bundle and checks the renderer bundle. Run them for changes that touch
module initialization order or the preload bridge; vitest cannot observe those failures.

### Native SQLite suites

Some suites open a real SQLite database and are guarded by `describe.skipIf(!HAS_NATIVE_SQLITE)`.
They skip when the `better-sqlite3` binding in `node_modules` is built for Electron's ABI rather
than your Node's, which is the normal state after `npm ci`. A skipped suite is not a pass. If
your change touches persistence, schema or FTS, rebuild the binding for Node and run the suite
for real:

```bash
npm rebuild better-sqlite3 --build-from-source   # needs the optional toolchain
DUIN_REQUIRE_NATIVE_SQLITE=1 node scripts/verify-proof.cjs --list-native-skips
npm test
```

### What CI runs

- **lint** (Ubuntu): `npm run verify:proof -- --no-tests`.
- **test** (Ubuntu and Windows): `npm test -- --coverage`, with the coverage thresholds pinned
  in `vitest.config.ts`.

Both must be green before a PR is reviewed. Tagged releases run the installer workflow
(`build.yml`), which maintainers own; see [docs/RELEASING.md](docs/RELEASING.md).

## Git hooks (opt-in)

`scripts/hooks/` holds a `pre-commit` (ESLint plus both typechecks) and a `pre-push`
(`npm run verify:proof`). They are not installed by default. Turn them on for yourself with:

```bash
npm run hooks:install     # git config core.hooksPath scripts/hooks
npm run hooks:uninstall   # revert
```

`core.hooksPath` lives in the shared git config, so installing the hooks turns them on for every
worktree of the repository at once. `pre-commit` adds over a minute to each commit;
`git commit --no-verify` bypasses it for one commit.

## Commit messages

Conventional commits:

```
<type>(<scope>): <imperative summary under 72 chars>

<optional body explaining why, wrapped at 72 chars>
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `style`, `ci`, `build`.
The body explains why; the diff already shows what. Do not add `Co-Authored-By` trailers or
links to agent sessions; the commit stands on its own.

## Pull requests

The PR template asks for the problem, the change, how you verified it, and any user-visible
effect. Fill it in. A PR that changes behavior needs a test that fails without the change.

Never weaken a test to make it pass. Re-baselining a guard needs a measurement and a comment
naming what moved it; deleting an assertion is not a fix. Do not flip a safety default
(`backgroundAutonomy`, approval posture, sandbox bypass, full computer access) to make
something work: if a mechanism only works with its guard off, that is the finding.

## Where things live

Three processes and one preload bridge: `electron/main.ts` (main), `electron/preload.ts`
(the `window.api` contextBridge), `src/` (React 19 renderer). IPC handlers sit in
`electron/ipc/`, business logic in `electron/services/`, the in-process brain in
`electron/services/local-brain/` and `electron/services/brain/`. Cross-process contracts live
in `electron/shared/`. The full map is [docs/architecture.md](docs/architecture.md).

Two rules that reviewers enforce:

- Never call `ipcRenderer.invoke` from renderer code. Add a typed binding in the preload.
- Every IPC handler returns `{ success: true, data }` or `{ success: false, error }`.

Providers are declared in `electron/services/providers/registry.ts`; a parity test keeps the
`ProviderId` union and the `PROVIDERS` table identical, so add both. Bundled skills live in
`resources/skills/` ([docs/skills.md](docs/skills.md)).

## What we merge

- Bug fixes with a clear reproduction in the description.
- New skills under `resources/skills/` and new MCP server integrations.
- Performance improvements with before/after numbers.
- Documentation improvements, especially examples and corrections.

## What we probably will not merge

- Style-only churn (rename or reformat with no behavior change).
- Abstractions added "for future flexibility." Show three call sites today.
- A second implementation of a concept that already has an owner (see
  [docs/constitution.md](docs/constitution.md), property 1).

## Reporting bugs and requesting features

Use the issue templates. A bug report needs the DUIN version (the release tag or installer
file name; the commit SHA for a source build), platform and OS version, steps to reproduce, observed versus expected
behavior, and console output (View → Toggle DevTools). A feature request needs the user-facing
problem, why the existing surfaces (skills, MCP, settings) are not enough, and a specific UX you
would accept.

Security issues go through
[private vulnerability reporting](https://github.com/Mentis-lab/duin-governed-agent-memory/security/advisories/new).
See [SECURITY.md](SECURITY.md).

## Troubleshooting

Build and test environment problems (esbuild blocked by antivirus on Windows, long paths,
skipped native suites) are collected in [docs/faq.md](docs/faq.md).

## License

DUIN is MIT-licensed and contributions are accepted on the same terms: inbound equals outbound.
Every contribution is made under the
[Developer Certificate of Origin 1.1](https://developercertificate.org/): by opening a PR you
certify that you have the right to submit the work under the MIT License. Sign-off trailers
(`git commit -s`) are welcome; CI does not enforce them.

## Running a second DUIN beside an installed one

Give the second instance its own state: `DUIN_USER_DATA_DIR=<dir>` (user data) and
`DUIN_BRAIN_PORT=8899` (its brain listens there instead of `8799`; the bridge, the renderer and
every self-call follow the port). `BF_DEBUG_PORT=9444` adds DevTools over CDP. `DUIN_TURN_STALL_MS`
raises the 90 s idle budget when a slow local model is the engine.
