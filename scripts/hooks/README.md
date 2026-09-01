# scripts/hooks

Git hooks for this repo, plus the guard that bounds what a single commit may contain.

| file | what it does |
|---|---|
| `pre-commit` | lane guard, then `npm run lint` + both tsc projects |
| `pre-push` | merge/board guard, then `npm run verify:proof` |
| `lane-guard.mjs` | blocks over-wide and cross-lane commits (see below) |
| `lane-guard.selftest.mjs` | proves the guard fires, in throwaway git repos |
| `merge-board-guard.mjs` | blocks a merge that closes a lane the board still calls live |
| `merge-board-guard.selftest.mjs` | proves it fires, against real `git push` exit codes |

## Arming them

Hooks live here rather than in `.git/hooks` so they are version-controlled, but git does
not look here until `core.hooksPath` points at it:

```
npm run hooks:install     # git config core.hooksPath scripts/hooks
npm run hooks:uninstall   # remove it again
```

**The hooks are opt-in.** `npm install` does not arm them: `package.json` has no
`postinstall` (it used to chain `hooks:install`, which also made `npm ci` fail in any
directory that is not a git checkout — a tarball extract, a Docker `COPY` layer — because
`git config` exited non-zero there). Run `npm run hooks:install` once per clone to arm
them; `npm run hooks:uninstall` removes them.

What the hooks do depends on the tree they run in:

| tree | `pre-commit` | `pre-push` |
|---|---|---|
| private trunk (has `SESSION-LANES.md`) | lane guard, then lint + tsc | merge/board guard, then `verify:proof` |
| public checkout (no board) | lint + tsc | `verify:proof` |

The board-dependent guards are skipped, not failed, when `SESSION-LANES.md` is absent: a
guard that blocks work nobody can unblock gets uninstalled. The same rule holds for the
script lints inside `verify:proof` (`lint:lanes`, `lint:orientation`, `handbook:check`
each PASS when their input file is not present).

`core.hooksPath` is stored in the **common** `.git/config`, so setting it in one worktree
arms every worktree sharing that git dir. That is why it must not be armed while parallel
lanes are mid-flight.

## The lane guard

`lane-guard.mjs` runs first in `pre-commit` and aborts the commit when either is true:

1. **more than 12 paths are staged** — the shape `git add -A` makes in a shared tree;
2. **a staged path falls outside this session's lane**.

The lane is resolved from `$LANE_FILES` (comma/space separated patterns), else from the
row in `SESSION-LANES.md` matching `$LANE` or the current branch name. If no lane can be
resolved the scope check downgrades to a printed notice — an unresolvable lane must never
wedge a commit, or the guard gets uninstalled instead of consulted.

### Escape hatch

```
LANE_OVERRIDE=1 git commit -m "…"
```

One escape, documented in the abort message itself. Wide commits are legitimate
sometimes; unnoticed wide commits are not.

### Why

`6545f48` swept seven of a parallel session's **uncommitted** source files into a commit
whose message described none of them, and `dacf8c7` had to be written purely to disclose
it. `SESSION-LANES.md` had mandated separate worktrees a week earlier. The prose was
already correct and did not prevent it, which is the whole argument for a mechanism.

## The merge/board guard

`merge-board-guard.mjs` runs first in `pre-push` and aborts the push when the commit being
pushed is a **merge** whose merged branch still holds a `Building now? yes` row in
`SESSION-LANES.md`. It prints the row (with its file:line) and the exact
`npm run lane:close -- <lane>` that closes it.

### Why

The board is declared the single coordination authority, and on 2026-08-04 it was wrong in
**both** directions at once: it still carried the 2026-08-03 roster with every row marked
MERGED and called `frontend` UNCLAIMED — while `duin/lane-frontend` had merged at `9c98416`
and `duin/lane-ipc` had never had a row at all. Rows expire in 48h (protocol 5) and
`ship-gate --group=INSTRUCTION` check I6 fails on stale dated rows, but only if someone runs
it. `npm run lane:close` already closes a row correctly — resolving the merge SHA from git
and refusing to close a branch trunk does not contain. The missing piece was never the
mechanism, it was the **invocation**: nothing connected the act of landing a lane to the act
of closing its row, so the board drifted by default.

### Fail-safe, deliberately

Only a positive, confident detection aborts. No board file, not a merge, an unparseable
table, an unresolvable branch, or any internal throw → notice and exit 0. `core.hooksPath`
is stored in the **common** `.git/config`, so a wedge here wedges every worktree sharing
that git dir at once — a guard that blocks a push nobody can unblock gets uninstalled
rather than consulted.

Two consequences worth knowing:

- **A row that was never created cannot be caught.** The guard closes stale-open rows, not
  never-opened ones. `duin/lane-ipc` merging with no row at all is invisible to it. That
  half needs a check that a merged branch has a row *at all* — a different, noisier rule
  that would fire on every non-lane merge, so it is not bundled in here.
- On today's live board it finds nothing, because every row already says `no`.

### Escape hatch

The same single one `lane-guard` uses — one escape for the hook layer, not one per script:

```
LANE_OVERRIDE=1 git push ...
```

### Checking the guards still work

```
node scripts/hooks/lane-guard.selftest.mjs
node scripts/hooks/merge-board-guard.selftest.mjs
```

Both run in CI (`.github/workflows/ci.yml`, `lint` job). Both build throwaway repos in the
OS temp dir, install these exact hook files into them, and assert on real git exit codes —
`git commit` for the lane guard, `git push` against real bare remotes for the merge/board
guard, including the full round trip: push blocked → `lane-close.mjs` → same push succeeds.
Nothing outside the scratch directories is touched, and `core.hooksPath` is set only inside
them.

`lane-guard.selftest.mjs` also carries an opt-in assertion that **this** checkout is not
armed (`LANE_GUARD_ASSERT_UNARMED=1`). It is opt-in because arming the hooks is the goal,
not the hazard — the hazard is arming them mid-wave, when `git config` writes to the common
`.git/config` and every parallel worktree inherits a guard it did not expect.
