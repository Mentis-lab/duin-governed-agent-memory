import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { runBench, formatReport } from './harness'
import { BENCH_TASKS } from './tasks'
import type { RunAgent } from './types'

// LIVE agent benchmark — runs BENCH_TASKS through a REAL model (local Ollama by
// default), turning the harness's "measurable" into a measured pass-rate. Opt-in only
// (BENCH_LIVE=1) so it never runs in the deterministic suite:
//     BENCH_LIVE=1 npx vitest run agent-bench-live
// This is a single-shot edit loop (read files → model returns full edited files), a
// legitimate baseline that measures the MODEL on the tasks — not DUIN's full agentic
// tool-loop (which needs the Electron runtime). Swap BENCH_MODEL to compare models.
const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434'
const MODEL = process.env.BENCH_MODEL || 'qwen3:8b'

async function ollamaUp(): Promise<boolean> {
  try {
    const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(2500) })
    return r.ok
  } catch {
    return false
  }
}

/** Pull a JSON object of {filename: content} out of a model reply (strips qwen <think>
 *  blocks and ``` fences, takes the largest balanced object). */
function extractEdits(text: string): Record<string, unknown> | null {
  const noThink = text.replace(/<think>[\s\S]*?<\/think>/g, '')
  const fence = noThink.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fence ? fence[1] : noThink
  const m = body.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const o = JSON.parse(m[0])
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const ollamaAgent: RunAgent = async ({ dir, prompt }) => {
  const files = readdirSync(dir).filter((f) => f.endsWith('.js') && f !== '_check.js')
  const fileBlock = files.map((f) => `=== ${f} ===\n${readFileSync(join(dir, f), 'utf8')}`).join('\n\n')
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      options: { temperature: 0.1, num_ctx: 8192 },
      messages: [
        {
          role: 'system',
          content:
            'You are a precise coding agent. Edit the given files to satisfy the TASK. ' +
            'Respond with ONLY a JSON object mapping each CHANGED filename to its COMPLETE ' +
            'new file content (as a string). No prose, no markdown outside the JSON. Do not ' +
            'touch or output _check.js.'
        },
        { role: 'user', content: `TASK: ${prompt}\n\nFILES:\n${fileBlock}` }
      ]
    }),
    signal: AbortSignal.timeout(180000)
  })
  const data = (await res.json()) as { message?: { content?: string } }
  const edits = extractEdits(data.message?.content ?? '')
  if (!edits) return
  for (const [name, content] of Object.entries(edits)) {
    if (typeof content === 'string' && /^[\w.-]+\.js$/.test(name) && name !== '_check.js') {
      writeFileSync(join(dir, name), content)
    }
  }
}

describe('agent-bench LIVE', () => {
  it(
    'measures a real pass-rate on BENCH_TASKS',
    async () => {
      if (!process.env.BENCH_LIVE) {
        console.log('[bench] set BENCH_LIVE=1 to run the live benchmark — skipped')
        return
      }
      if (!(await ollamaUp())) {
        console.log(`[bench] Ollama not reachable at ${OLLAMA} — skipped`)
        return
      }
      console.log(`[bench] running BENCH_TASKS against ${MODEL} …`)
      const report = await runBench(BENCH_TASKS, ollamaAgent, {
        onResult: (r) => console.log(`  [${r.passed ? 'PASS' : 'FAIL'}] ${r.id} (${r.ms}ms)${r.detail ? ' — ' + r.detail : ''}`)
      })
      const summary = formatReport(report) + '\n' + JSON.stringify(report.results, null, 2)
      console.log('\n' + summary + '\n')
      if (process.env.BENCH_OUT) writeFileSync(process.env.BENCH_OUT, `model=${MODEL}\n${summary}\n`)
      // A measurement, not a pass/fail — assert only that the harness completed.
      expect(report.total).toBe(BENCH_TASKS.length)
    },
    600000
  )
})
