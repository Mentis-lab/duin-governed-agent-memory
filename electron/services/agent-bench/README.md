# agent-bench — a measured pass-rate for the DUIN agent

Turns "the agent looks capable" into a number. Each task sets up an isolated
workspace, an agent is asked to complete it, and an **objective grader runs the
resulting code** (spawns `node`) to decide pass/fail. Model-agnostic: the runner
takes an injected `RunAgent`, so the same suite scores the real headless agent, a
remote model, or a mock solver.

## Run the self-validation (no model needed)

```bash
npx vitest run agent-bench        # or: npm run bench:agent
```

This proves the harness + graders are correct:
- `PERFECT_SOLVER` (the ground-truth correct edit) must score **3/3** — graders
  accept a working solution.
- `NOOP_SOLVER` (changes nothing) must score **0/3** — graders reject the broken
  starting state (no false passes).

## Bench the real agent

Implement a `RunAgent` adapter that drives DUIN's headless agent over the workspace,
then pass it to `runBench`:

```ts
import { runBench, formatReport } from './harness'
import { BENCH_TASKS } from './tasks'
import type { RunAgent } from './types'
import { runHeadlessAgent } from '../headless-agent' // shape depends on the entry you expose

const realAgent: RunAgent = async ({ dir, prompt }) => {
  // Point the agent at `dir` as its workspace, hand it `prompt`, let it edit files.
  await runHeadlessAgent({ workspace: dir, prompt, model: process.env.BENCH_MODEL /* e.g. an Ollama id */ })
}

const report = await runBench(BENCH_TASKS, realAgent)
console.log(formatReport(report))
```

Notes:
- Run it against a **local Ollama** model (fully offline) or any configured provider —
  set `BENCH_MODEL`. Keep the model fixed across runs so the score is comparable.
- The real-agent run needs the Electron main-process services (permissions gate,
  tool-exec, shell sandbox). Invoke it from a main-process context / an
  `electron-vite` dev entry, not plain `node`, since `headless-agent` pulls the
  app's tool registry.

## Add a task

A task is `{ id, title, prompt, setup(dir), grade(dir) }` in `tasks.ts`. Keep graders
**execution-based** (run the code, check behavior) rather than string-matching, and
add the matching branch to `PERFECT_SOLVER` so the self-validation still proves the
grader accepts a correct answer. Each workspace is pinned to CommonJS via
`nodeProject(dir)` so ancestor `package.json` (`"type":"module"`) can't change how
Node interprets the `.js` files.

## Why this exists

The DUIN evaluation flagged the agent harness as "looks capable, unproven — no
benchmark." This is the smallest honest fix: a reproducible, self-validating baseline
you can run per change to catch agent-loop regressions and compare models.

## Baseline (measured 2026-07-03)

`qwen3:8b` (local Ollama, single-shot adapter) — **3/3 (100%)**:
implement-to-spec, fix-failing-test, refactor-rename. Run it yourself:

```bash
BENCH_LIVE=1 npx vitest run agent-bench-live          # skips if Ollama is down
BENCH_LIVE=1 BENCH_MODEL=llama3.1 npx vitest run agent-bench-live   # compare models
```

The current tasks are easy (a small model aces them) — they validate the harness
end-to-end; add harder multi-file / debugging tasks to make the score discriminating.
