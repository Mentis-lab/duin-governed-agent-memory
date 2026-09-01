// agent-bench — a deterministic task-suite that turns "the agent looks capable"
// into a measured pass-rate. Each task sets up an isolated workspace, an agent is
// asked to complete it, and an OBJECTIVE grader (compile/run/inspect the result)
// decides pass/fail. The runner is decoupled from any specific model via an
// injected RunAgent, so the SAME suite scores the real headless agent, a remote
// model, or a mock solver (used to self-validate the graders).

export interface BenchTask {
  /** Stable id (also the temp-workspace prefix). */
  id: string
  /** One-line description for the scorecard. */
  title: string
  /** The instruction handed to the agent. */
  prompt: string
  /** Write the starting files into an empty workspace dir. */
  setup: (dir: string) => void
  /** Objectively decide whether the workspace now satisfies the task. Runs AFTER
   *  the agent; must not depend on anything outside `dir`. */
  grade: (dir: string) => BenchGrade
}

export interface BenchGrade {
  passed: boolean
  detail: string
}

export interface BenchTaskResult {
  id: string
  title: string
  passed: boolean
  detail: string
  /** Set when the task threw before grading (setup/agent error). */
  error?: string
  ms: number
}

export interface BenchReport {
  results: BenchTaskResult[]
  passed: number
  total: number
  /** passed / total, 0..1. */
  score: number
}

/** The pluggable agent under test. Receives the workspace dir + the prompt and
 *  should mutate files in `dir` to satisfy the task. May do anything (call a model,
 *  run tools); the harness only observes the resulting files via the grader. */
export type RunAgent = (input: { dir: string; prompt: string; task: BenchTask }) => Promise<void>
