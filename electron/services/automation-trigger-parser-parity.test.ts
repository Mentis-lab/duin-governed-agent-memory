import { describe, it, expect } from 'vitest'

// REGRESSION — there are now TWO 5-field cron parsers with DIFFERENT accept sets:
//   • automations-runner.parseCron  — what electron/ipc/automations.ts VALIDATES with
//     (automations:create / :update / :validateCron all call this one).
//   • automation-trigger.parseCron  — what automations-store WRITES with
//     (createAutomation → legacyCronTrigger → parseAutomationTrigger → parseCron) and
//     what parseStoredAutomationTrigger READS every row with, on every listAutomations().
//
// They disagree in both directions, and each disagreement is a defect:
//
//  (1) runner accepts, trigger rejects: `parseInt` leniency. The runner's numeric branch
//      dropped trunk's `String(n) !== piece` check, so `5abc` parses as 5. The CronEditor
//      therefore reports the expression VALID (with a description and a next-fire time),
//      and the very next call — store.createAutomation — throws. The user is told the
//      cron is good, then the save fails.
//
//  (2) trigger accepts, runner rejects: the DoS guard. The runner's step branch bounds
//      the explicit range before iterating, with a comment recording exactly why:
//      "Without this an unbounded `hi` (e.g. `1-20000000/1`) drives a multi-million
//      iteration Set.add loop on the main thread, freezing Electron." The ported
//      automation-trigger.ts step branch has NO such bound — it re-introduces the very
//      bug trunk fixed, in the parser that runs on the main process for every stored row.
import { parseCron as runnerParseCron } from './automations-runner'
import { parseCron as triggerParseCron, legacyCronTrigger } from './automation-trigger'

describe('cron parser parity — the IPC validator and the store writer must agree', () => {
  // NOTE (fix pass, 2026-07-25): as first written this case asserted
  //   expect(() => runnerParseCron('5abc * * * *')).not.toThrow()
  // which is the exact negation of the next case's
  //   expect(() => runnerParseCron('5abc * * * *')).toThrow()
  // — the two could never both be green, so the pair pinned the DISAGREEMENT rather
  // than the target state. The review's own prose says the runner "dropped trunk's
  // `String(n) !== piece` check" and that trunk's parser is the correct one, so the
  // target is: both REJECT. Rewritten below to assert the property the case is named
  // for — the IPC validator and the store writer reach the same verdict — over a
  // corpus that still includes the original expression. Strictly stronger than the
  // original two lines, and satisfiable.
  it('does not report a cron VALID that the store then refuses to persist', () => {
    const accepts = (fn: (expr: string) => unknown, expr: string): boolean => {
      try {
        fn(expr)
        return true
      } catch {
        return false
      }
    }
    const corpus = [
      '5abc * * * *', // parseInt leniency — the original case
      '+5 * * * *',
      ' 5 * * * *',
      '0-99/1 * * * *', // unbounded step range
      '1-2000000/1 * * * *',
      '0-99 * * * *',
      '30-10 * * * *',
      '0 9 * * 1-5', // …and expressions that must stay VALID in both
      '*/5 * * * *',
      '0-30/5 * * * *',
      '* * * * *'
    ]
    for (const expr of corpus) {
      // What ipc/automations.ts:26 does before store.createAutomation…
      const validatorAccepts = accepts(runnerParseCron, expr)
      // …and what store.createAutomation does immediately afterwards.
      expect(accepts(legacyCronTrigger, expr), expr).toBe(validatorAccepts)
      expect(accepts(triggerParseCron, expr), expr).toBe(validatorAccepts)
    }
    // And the corpus really does exercise both verdicts.
    expect(accepts(runnerParseCron, '0 9 * * 1-5')).toBe(true)
    expect(accepts(runnerParseCron, '5abc * * * *')).toBe(false)
  })

  it('rejects a trailing-garbage numeric field in both parsers', () => {
    expect(() => runnerParseCron('5abc * * * *')).toThrow()
    expect(() => triggerParseCron('5abc * * * *')).toThrow()
  })

  it('bounds an explicit step range in BOTH parsers (main-thread freeze guard)', () => {
    // Trunk's guard — still present in the runner.
    expect(() => runnerParseCron('1-2000000/1 * * * *')).toThrow()
    // The ported parser has no bound: it materialises a 2,000,000-entry Set for a
    // field whose legal domain is 0-59, synchronously, on the main process.
    expect(() => triggerParseCron('1-2000000/1 * * * *')).toThrow()
  })

  it('never admits an out-of-domain value into a parsed field set', () => {
    // `0-99` is correctly rejected by the plain-range branch...
    expect(() => triggerParseCron('0-99 * * * *')).toThrow()
    // ...but the same range wearing a `/1` step slips straight past it.
    expect(() => triggerParseCron('0-99/1 * * * *')).toThrow()
  })
})
