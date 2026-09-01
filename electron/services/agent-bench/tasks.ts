// The starter benchmark suite — small, objective, execution-graded coding tasks.
// Graders SPAWN node to actually run the resulting code (not just string-match), so
// a pass means the code works, not that it looks right. Deliberately model-agnostic
// and language-minimal (Node, no deps) so the suite runs anywhere the app builds.
import { writeFileSync, readFileSync, existsSync } from 'fs'
import { execFileSync } from 'child_process'
import { join } from 'path'
import type { BenchTask, BenchGrade, RunAgent } from './types'
import { messageOf } from '../guarded'

/** Make the workspace a hermetic CommonJS project. Without this, Node resolves the
 *  nearest ancestor package.json (e.g. a user-home `"type":"module"`) and treats the
 *  `.js` files as ESM, breaking `require` — so pin the module system per workspace. */
function nodeProject(dir: string): void {
  writeFileSync(join(dir, 'package.json'), '{ "type": "commonjs" }\n')
}

/** Run a node script inside the workspace; pass = exit 0 within the timeout. */
function runNode(dir: string, file: string): BenchGrade {
  try {
    execFileSync('node', [file], { cwd: dir, timeout: 15_000, stdio: 'pipe' })
    return { passed: true, detail: 'check script exited 0' }
  } catch (e) {
    const err = e as { stderr?: Buffer; message?: string }
    const msg = (err.stderr?.toString() || messageOf(err) || 'non-zero exit').trim().split('\n')[0]
    return { passed: false, detail: msg.slice(0, 120) }
  }
}

export const BENCH_TASKS: BenchTask[] = [
  {
    id: 'implement-to-spec',
    title: 'Implement a function to spec',
    prompt:
      'Edit add.js so the exported function returns the sum of its two arguments (a + b). ' +
      'Keep module.exports a function of two args.',
    setup: (dir) => {
      nodeProject(dir)
      writeFileSync(
        join(dir, 'add.js'),
        "// add(a, b) must return a + b\nmodule.exports = function add(a, b) {\n  throw new Error('not implemented')\n}\n"
      )
      writeFileSync(
        join(dir, '_check.js'),
        "const add = require('./add.js')\nif (add(2, 3) !== 5) { console.error('add(2,3) !== 5'); process.exit(1) }\nif (add(-1, 1) !== 0) { console.error('add(-1,1) !== 0'); process.exit(1) }\nprocess.exit(0)\n"
      )
    },
    grade: (dir) => runNode(dir, '_check.js')
  },
  {
    id: 'fix-failing-test',
    title: 'Fix a bug so a check passes',
    prompt:
      'sub.js is wrong — it adds instead of subtracts. Fix sub.js so the check in _check.js passes ' +
      '(sub(a, b) must return a - b). Do not edit _check.js.',
    setup: (dir) => {
      nodeProject(dir)
      writeFileSync(join(dir, 'sub.js'), 'module.exports = function sub(a, b) {\n  return a + b // BUG\n}\n')
      writeFileSync(
        join(dir, '_check.js'),
        "const sub = require('./sub.js')\nif (sub(5, 3) !== 2) { console.error('sub(5,3) !== 2'); process.exit(1) }\nif (sub(0, 4) !== -4) { console.error('sub(0,4) !== -4'); process.exit(1) }\nprocess.exit(0)\n"
      )
    },
    grade: (dir) => runNode(dir, '_check.js')
  },
  {
    id: 'refactor-rename',
    title: 'Rename a symbol without breaking behavior',
    prompt:
      'In calc.js, rename the function `tally` to `total` everywhere (declaration and all call sites). ' +
      'Behavior must stay identical and the module must still export a working function.',
    setup: (dir) => {
      nodeProject(dir)
      writeFileSync(
        join(dir, 'calc.js'),
        'function tally(xs) {\n  return xs.reduce((a, b) => a + b, 0)\n}\n' +
          'function twice(xs) {\n  return tally(xs) + tally(xs)\n}\n' +
          'module.exports = { tally, twice }\n'
      )
      writeFileSync(
        join(dir, '_check.js'),
        "const m = require('./calc.js')\nconst fn = m.total\nif (typeof fn !== 'function') { console.error('total not exported'); process.exit(1) }\nif (fn([1,2,3]) !== 6) { console.error('total wrong'); process.exit(1) }\nif (m.twice([1,2,3]) !== 12) { console.error('twice wrong'); process.exit(1) }\nprocess.exit(0)\n"
      )
    },
    grade: (dir) => {
      const src = existsSync(join(dir, 'calc.js')) ? readFileSync(join(dir, 'calc.js'), 'utf8') : ''
      if (/\btally\b/.test(src)) return { passed: false, detail: 'stale `tally` still present' }
      return runNode(dir, '_check.js')
    }
  }
]

/** A deterministic "perfect" solver — makes exactly the correct edit per task id.
 *  Used to SELF-VALIDATE the graders (they must pass a correct solution) without a
 *  live model. This is the ground truth the real agent is measured against. */
export const PERFECT_SOLVER: RunAgent = async ({ dir, task }) => {
  if (task.id === 'implement-to-spec') {
    writeFileSync(join(dir, 'add.js'), 'module.exports = function add(a, b) {\n  return a + b\n}\n')
  } else if (task.id === 'fix-failing-test') {
    writeFileSync(join(dir, 'sub.js'), 'module.exports = function sub(a, b) {\n  return a - b\n}\n')
  } else if (task.id === 'refactor-rename') {
    const p = join(dir, 'calc.js')
    writeFileSync(p, readFileSync(p, 'utf8').replace(/\btally\b/g, 'total'))
  }
}

/** A no-op solver that changes nothing — every task must FAIL. Validates that the
 *  graders don't false-pass an untouched (broken) workspace. */
export const NOOP_SOLVER: RunAgent = async () => {
  /* leave the broken starting files as-is */
}
