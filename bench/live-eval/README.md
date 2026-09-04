# bench/live-eval — the 2026-09-02 evaluation as a gate

`npm run bench:live` launches an **isolated** DUIN built from this tree, runs deterministic probes
for the seven evaluation lanes (L1 brain · L2 memory · L3 agentic · L4 governance · L5 renderer ·
L6 engines · L7 background) with a learning-exempt header on every turn, and writes a scorecard.
It is the suite named in `PLANNING/DUIN_COHESION_BUILD_PLAN_2026-09.md` §2.6 / W19: the number
the README and the Status card will show is computed here, never typed.

```
npm run bench:live                       # full run, tree's own build
node bench/live-eval/run.mjs --help      # options
node bench/live-eval/run.mjs --probe admission,governance --json
node bench/live-eval/run.mjs --keep      # leave the instance up for inspection
node scripts/live-eval-launch.mjs --stop bench/live-eval/runs/<ISO>/instance
```

## Nightly

`node scripts/live-eval-nightly.mjs` is the unattended entry point (plan §2.6: three consecutive
nightly runs at target). It resolves the app the same way `run.mjs` does — `dist/win-unpacked/DUIN.exe`
when present, else electron + `out/`, else `--exe` — and refuses to run when nothing is built
(exit 2, never a silent pass). It runs the suite under `runs/nightly/<YYYY-MM-DDTHHMM>/`, copies the
scorecard to `runs/nightly/latest.json` and appends one line per run to `runs/nightly/history.jsonl`
(`{ at, build, runDir, exit, lanes }`), then exits with the suite's code. `--dry-run` prints the
resolved binary and run directory without launching (verify a scheduled task with it first);
`--root <dir>` moves the output tree; `--probe` and `--exe` pass through. Provider keys come from
`LIVE_EVAL_KEY_<PROVIDER>` in the scheduler's environment. The scheduled task itself (Windows Task
Scheduler on the operator's machine) is created by the operator, not by this repo; its action is
`node scripts\live-eval-nightly.mjs` with this tree as the working directory. Tests:
`scripts/live-eval-nightly.test.mjs` (`npm run test:teeth`).

Output: `bench/live-eval/runs/<ISO>/scorecard.json` (`{ build, at, lanes: { L1..L7: { score,
passed, total, unverified, skipped, failed } }, probes: [...] }`), `summary.md`, `turns.jsonl`
(every turn's answer, tools, timings), `run.log`, and the instance itself under `instance/`
(userData with journals and `lamprey.db`, the vault copy, `app.log`). Runs are git-ignored.
Exit code 1 when any measured lane scores below `config.json` `threshold` (7 in P0).

## What it measures

| Lane | Module | Probes |
|---|---|---|
| L4 | `probes/admission.mjs` | the control-plane matrix: no token / bogus token / `Host: evil.com` / `Origin: http://evil.com` → 403, controlled GETs need a token, `/health` open, `/exec/mcp` Host+Origin rules, `GET /exec/mcp` 405, unknown `/exec/*` 404, the exec token admits |
| L6 | `probes/engines.mjs` | per seeded provider: grounded question (A), abstention (B), listing (C), multi-step file task (G), missing-file honesty (E), JSON format (F), with rounds/seconds/cost from `/debug/turns`; the failover probe (a turn pinned to a model whose provider holds a deliberately invalid key must still answer, `recovered` true) |
| L3 | `probes/tools.mjs` | list+read, write at an absolute path OUTSIDE the vault, byte-exact edit, delete → recoverable, `run_command dir`, missing-file honesty, a scoped `rm -rf` passes the catastrophic screen, abort beacon, two concurrent turns, and **no file may appear under the fixture vault** (app state under `.duin/.brain/.obsidian` excepted; `.trash` is not excepted — S3) |
| L1 | `probes/brain.mjs` | the ten fixture questions scored with the vault-eval scorer, plus citation existence |
| L4 | `probes/governance.mjs` | anonymous MCP `tools/list` = pairing tools only, anonymous data tool refused; posture matrix on `run_command dir`: `omitted`/`full` allow, `default`/`auto-review` prompt and the prompt ENDS (no zombie); a prompt nothing ends is denied over CDP and recorded as a failure |
| L2 | `probes/memory.mjs`, `probes/exemption.mjs` | 3-turn thread continuity with replayed history; `memory.add`/`delete` over CDP verified on disk and recalled; after all turns: 0 new candidates in `operator-model.json`, no belief notice, no new correction row |
| L7 | `probes/observability.mjs` | `/debug/stalls` sampled through the run (≥ 60 s; max/median reported, no threshold in P0), backend-health integrity (or `PRAGMA quick_check` on the instance DB), every suite turn has a journal `TURN_END`, `/debug/log-tail`, a forced background failure produces a notice within one tick |
| L5 | `probes/renderer.mjs` | preload bridge reachable, zero uncaught renderer exceptions during the run |

Lane score = 10 × passed / total over measured probes, rounded to 0.1.

**Unverified probes.** Contracts that later lanes deliver are measured now and excluded from the
score until the build honours them: lane A (`x-duin-bench` accepted with the exec token →
learning/taste/turn-beats off, journal `bench: true`; classified failover with `recovered`) is
detected through `bench: true` in a suite turn's `TURN_START`; lane C (log sink, failure →
notice) through `GET /debug/log-tail` answering. The scorecard lists them under `unverified`
with the observed value, so the day a lane lands the suite starts scoring it with no edit here.

**The 10/10 target** (plan §0 item 6, §4 P5): every probe passes — no `FAIL`, nothing left
`unverified` — on three consecutive runs of the same build. One run at 10 is a sample; three are
a gate.

## What it can never touch

The owner's instance. `scripts/live-eval-launch.mjs` enforces this by construction:
`assertIsolated()` refuses ports 8799/9333 and any userData under `%APPDATA%\DUIN` or the
installed app; the child env drops every inherited `DUIN_*`/`BF_*`/`LAMPREY_*` pin and sets
`DUIN_USER_DATA_DIR=<run>/instance/userdata`, `DUIN_BRAIN_PORT=8899`, `BF_DEBUG_PORT=9444`,
`DUIN_TURN_STALL_MS=600000`, `DUIN_TRANSFER_AB_TICK=0`, `DUIN_RSI_TICK_MS=0`,
`DUIN_EXEC_TOKEN_FILE=1`; `settings.json` is pre-seeded (fixture vault, `language: en`,
`providerPolicy` from `config.json`, `backgroundAutonomy: false`, `loopsEnabled: false`,
`fullComputerAccess: true` per decision D1, `approvalTimeoutMs`); and `stop()` kills only
processes whose **executable path is the binary it launched AND whose command line names this
instance's userData** (the main process carries `--live-eval-user-data=<dir>`, Chromium children
carry `--user-data-dir=<dir>`). A process is never selected by name.

The app under test: `dist/win-unpacked/DUIN.exe` when it exists (`npm run build:win`), else
`node_modules/electron/dist/electron.exe .` over `out/` (`npm run build`); `--exe <path>`
overrides. Build the tree you want to measure; never build in another lane's worktree.

## Search model

The packaged app ships the embedding model under `resources/models/transformers` (offline-first). The
dev launch (`electron` + `out/`) reads `userData/models/transformers` and downloads on a miss, and a
blocked download stalls every grounding on its timeout before the engine is even called (measured
2026-09-03: a 240 s turn with no model request). The launcher therefore seeds the cache for dev-target
runs from `LIVE_EVAL_EMBEDDER_CACHE=<dir>` or, by default, `<repo>/resources/models/transformers`
(absent in a worktree without the extraResources checkout — point the env var at
`lamprey-unified\resources\models\transformers` or at an installed app's `resources\models\transformers`).
Packaged-exe runs need nothing.

## Keys

`LIVE_EVAL_KEY_<PROVIDER>` (provider ids from `electron/services/providers/registry.ts`:
`DEEPSEEK`, `OPENAI`, `ANTHROPIC`, `ZHIPU`, `MOONSHOT`, `GOOGLE`, `DASHSCOPE`, …) are seeded into
the isolated instance with `window.api.settings.saveProviderKey(provider, key)` over CDP after
the renderer bridge is up. The owner's `keys.json` is never copied or read. Model ids per
provider are in `config.json` (`LIVE_EVAL_MODEL_<PROVIDER>` overrides); the first seeded provider
in policy order is the primary engine every non-engine probe pins. Saving a key is the app's
cloud-consent signal, so the instance may run its extraction pass over the 43-note fixture vault
in the background (cents). With no key set the suite runs the keyless probes and reports every
engine-dependent probe as `skipped`.

Every `/agui` turn and beacon carries `x-duin-exec: <token>` (read from the instance's
`exec-token` file) and `x-duin-bench: 1`.

## Fixture

`fixtures/vault/` is the fictional Kestrel Labs sample vault from git history (`b87d0cb`,
`examples/sample-vault`), plus one added superseded decision and one confidential note —
provenance and the exact delta in `fixtures/README.md`. `fixtures/questions.json` holds the ten
questions and their hand-verified gold facts.

## Files

```
scripts/live-eval-launch.mjs   isolated launch, env scrubbing, exe+userData kill filter, --stop
bench/live-eval/run.mjs        CLI, context, probe loop, scorecard
bench/live-eval/config.json    ports, provider policy + model ids, threshold, timeouts
bench/live-eval/lib/           http (raw + SSE + beacons + MCP), cdp, sql (node:sqlite, read-only),
                               score (vault-eval port), fs-snap, scorecard, probe-utils
bench/live-eval/probes/        one module per lane; each exports { name, lane, run(ctx) }
bench/live-eval/test/          node --test bench/live-eval/test/*.test.mjs
```

Python is not needed: the evaluation's `agui_ask.py`, `agui_ctl.py`, `mcp_call.py`,
`cdp-eval.mjs`, `l1_score.py`, `l6_run.py` and `l7_stalls_sampler.py` are ported to the modules
above.
