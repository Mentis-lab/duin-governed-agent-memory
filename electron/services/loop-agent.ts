// loop-agent.ts — run a loop through the headless agentic executor so it
// actually produces its artifact (vs the old text-into-the-void). Gated by the
// `backgroundAutonomy` kill switch (default OFF).
//
// Reads the loop from .duin/loops/loops.yaml: only `executor: brain` (incl. the
// legacy `duin` alias) loops are agentic; `signal`/`script` loops are
// skipped (no agent). The loop's declared `allowed_tools` (Claude-Code-era
// names) are mapped onto the app's native tool ids and become the run's
// capability allow-list. `daily-digest` uses a curated prompt; other brain loops
// run their own `run.target` prompt with an apply_patch write convention.

import { join } from 'path'
import { appendFileSync, mkdirSync, readFileSync } from 'fs'
import yaml from 'js-yaml'
import { readSettings } from './settings-helper'
import { readLoopConfig } from './loop-config'
import { runHeadlessAgent, type HeadlessAgentResult, type HeadlessAgentSpec } from './headless-agent'
import { recordEvent, boundedJsonPreview } from './event-log'
import { mapCcToolNames } from './cc-tool-map'
import { messageOf } from './guarded'

export interface LoopAgenticOutcome {
  ran: boolean
  loop: string
  reason?: string
  result?: HeadlessAgentResult
}

interface LoopDef {
  name: string
  enabled?: boolean
  run?: { executor?: string; target?: string; allowed_tools?: string }
}

const AGENTIC_EXECUTORS = new Set(['brain', 'duin'])

function mapAllowedTools(csv: string | undefined): string[] {
  // A brain loop always keeps apply_patch + read/list so it can ground itself and
  // write its artifact, PLUS the shared retrieval spine (hybrid search_notes +
  // graph walk_links) so it grounds the same way the chat does instead of blindly
  // listing dirs. Declared tools are mapped onto native ids via the shared
  // CC→native map (cc-tool-map.ts). Unmappable CC names are dropped.
  const out = new Set<string>(['apply_patch', 'read_file', 'list_dir', 'search_notes', 'walk_links'])
  for (const t of mapCcToolNames((csv ?? '').split(','))) out.add(t)
  return [...out]
}

function todayIso(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function loadLoopDef(vault: string, name: string): LoopDef | null {
  try {
    const doc = yaml.load(readFileSync(join(vault, '.duin', 'loops', 'loops.yaml'), 'utf-8'), {
      schema: yaml.JSON_SCHEMA
    }) as {
      loops?: LoopDef[]
    } | null
    return (doc?.loops ?? []).find((l) => l.name === name) ?? null
  } catch {
    return null
  }
}

function buildSpec(loop: LoopDef, vault: string, model: string): Omit<HeadlessAgentSpec, 'signal'> {
  const allowedTools = mapAllowedTools(loop.run?.allowed_tools)

  if (loop.name === 'daily-digest') {
    const date = todayIso()
    const rel = `DUIN/Planning/daily notes/${date}.md`
    return {
      workspacePath: vault,
      model,
      allowedTools: ['read_file', 'list_dir', 'apply_patch'],
      label: 'daily-digest',
      timeoutMs: 180_000,
      prompt:
        `You are DUIN's scheduled daily-digest run for ${date} (no human is present). Produce ` +
        `today's end-of-day digest and SAVE it as a markdown file.\n\n` +
        `Optionally ground it first: you may use list_dir / read_file to glance at the vault for ` +
        `today's activity (e.g. list "DUIN/Tasks", "DUIN/Decisions", or "DUIN/Planning/daily notes"). ` +
        `Keep this brief — at most a few reads. Do NOT invent specifics you can't see.\n\n` +
        `Then write the file with apply_patch to exactly this path (relative to the workspace root):\n` +
        `  ${rel}\n` +
        `Use an "*** Add File: ${rel}" directive. Each body line is "+" immediately followed by the ` +
        `content (NO extra space after "+"). The note opens with "# ${date} — Daily digest" and has ` +
        `the sections "## Done today", "## Open / tomorrow", and "## Notes". If you found nothing ` +
        `specific, write a clean scaffold with those headers. Call apply_patch once, then stop.`
    }
  }

  if (loop.name === 'daily-news-sweep') {
    const date = todayIso()
    const rel = `DUIN/Planning/intel/news-sweep/${date}.md`
    // Topics are NOT hardcoded — they come from this vault's loop `target` so the
    // sweep is per-user (no baked-in game/company names). Only the STRUCTURE (query
    // budget, write-once, dated path, format) lives here as the runaway guard.
    const topics = (loop.run?.target ?? '').trim()
    const focus = topics
      ? `Tracked focus for this sweep (from this vault's loop config):\n${topics}\n\n`
      : `Focus on topics relevant to the operator — glance at the vault (a couple of ` +
        `list_dir / read_file) to infer the domains if you're unsure.\n\n`
    return {
      workspacePath: vault,
      model,
      allowedTools: ['web_search', 'read_file', 'list_dir', 'apply_patch'],
      label: 'daily-news-sweep',
      timeoutMs: 300_000,
      prompt:
        `You are DUIN's scheduled news sweep for ${date} (headless, no human). ` +
        `Use web_search for a FEW focused queries (at most ~6).\n\n` +
        focus +
        `Then write a dated intel file with apply_patch to exactly:\n  ${rel}\n` +
        `Use an "*** Add File: ${rel}" directive (each "+" body line immediately followed by ` +
        `content, no extra space). Frontmatter: title, date: ${date}, source: news-sweep. Body: ` +
        `only genuinely NEW items, one line each with a "→ why it matters" note and the source URL. ` +
        `If web_search is unavailable or nothing is material, write a file whose body is exactly ` +
        `"今日无重要行业动态" and stop. Do not pad. Call apply_patch once, then stop.`
    }
  }

  // Generic brain loop: run its own target prompt headlessly with a write convention.
  const target = (loop.run?.target ?? '').trim() || `Run the "${loop.name}" routine.`
  return {
    workspacePath: vault,
    model,
    allowedTools,
    label: loop.name,
    timeoutMs: 300_000,
    system:
      `You are DUIN running the scheduled "${loop.name}" routine headlessly — no human is ` +
      `present to answer prompts. Today is ${todayIso()}. To write or update any file, use the ` +
      `apply_patch tool with paths relative to the workspace root (no leading space after each ` +
      `"+" body line). Available tools: ${allowedTools.join(', ')}. Do the task, then stop.`,
    prompt: target
  }
}

export async function runLoopAgentic(loopName: string): Promise<LoopAgenticOutcome> {
  if (readSettings().backgroundAutonomy !== true) {
    return { ran: false, loop: loopName, reason: 'backgroundAutonomy is off' }
  }
  // Same reasoning as the scheduler that calls this: a vault-writing loop must be governed
  // by the toggle that claims to govern loops, not only by the master autonomy switch.
  if (!readLoopConfig().enabled) {
    return { ran: false, loop: loopName, reason: 'loops are disabled in settings' }
  }
  const vault = (readSettings().localBrainNotesDir as string) || ''
  if (!vault) return { ran: false, loop: loopName, reason: 'no vault (localBrainNotesDir unset)' }

  const loop = loadLoopDef(vault, loopName)
  if (!loop) return { ran: false, loop: loopName, reason: `loop '${loopName}' not in loops.yaml` }
  if (loop.enabled === false) return { ran: false, loop: loopName, reason: 'loop disabled' }
  const executor = loop.run?.executor ?? 'signal'
  if (!AGENTIC_EXECUTORS.has(executor)) {
    return { ran: false, loop: loopName, reason: `executor '${executor}' is not agentic (skipped)` }
  }

  const model = (readSettings().defaultModel as string) || 'deepseek-v4-flash'
  const spec = buildSpec(loop, vault, model)
  const result = await runHeadlessAgent(spec)

  try {
    const stateDir = join(vault, '.duin', '_state')
    mkdirSync(stateDir, { recursive: true })
    appendFileSync(
      join(stateDir, 'autonomous-log.jsonl'),
      JSON.stringify({
        ts: new Date().toISOString(),
        routine: 'loop-agent',
        loop: loopName,
        executor: 'headless-agent',
        level: result.status === 'ok' ? 'info' : 'warn',
        message:
          `${result.status}: turns=${result.turns} tools=` +
          (result.toolUses.map((t) => `${t.name}:${t.status}`).join(',') || 'none') +
          (result.error ? ` err=${result.error}` : '')
      }) + '\n',
      'utf-8'
    )
  } catch (e) { console.debug('[loop-agent] best-effort logging:', messageOf(e)) }

  // Surface the real outcome on the Activity timeline (tools used + artifacts),
  // not just "fired" — so the Automations hub shows truth.
  try {
    recordEvent({
      type: result.status === 'ok' ? 'loop.agentic.completed' : 'loop.agentic.failed',
      actorKind: 'system',
      severity: result.status === 'ok' ? 'info' : 'error',
      entityKind: 'loop',
      entityId: loopName,
      payload: {
        loop: loopName,
        status: result.status,
        turns: result.turns,
        toolUses: result.toolUses.map((t) => `${t.name}:${t.status}`),
        outputPreview: boundedJsonPreview(result.output),
        error: result.error
      }
    })
  } catch (e) { console.debug('[loop-agent] best-effort:', messageOf(e)) }

  return { ran: true, loop: loopName, result }
}
