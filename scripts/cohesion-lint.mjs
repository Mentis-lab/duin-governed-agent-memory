#!/usr/bin/env node
// cohesion-lint.mjs — System Cohesion lint (see the DUIN System Cohesion Benchmark).
//
// Enforces three cohesion axes as CI-checkable signatures, so a regression — an engine that
// silently reaches into the legacy harness, targets the retired :8765 brain, or loses its trigger and goes dark —
// fails the build instead of waiting to be discovered by hand.
//
//   Axis 1  Invocation  — every engine-entry file has a real caller OR an explicit
//                         `@cohesion-invocation:` intent annotation (on-demand / eval / parked).
//   Axis 2  Grounding   — no engine reads the legacy harness state (.claude/_state) or hardcodes a vault path.
//   Axis 3  Transport   — no live target on the retired :8765 python brain.
//
// Hard-fails (exit 1) on any finding. Run: node scripts/cohesion-lint.mjs
// (or `npm run lint:cohesion`). Zero deps, cross-platform. Wired into
// `verify:proof`, which is what CI's static gate runs.
//
// A fourth "Axis 4 Singularity" used to be listed and printed here. It checked
// NOTHING: two unconditional stdout writes echoing a PowerShell one-liner for a
// human to run, with no findings bucket and no contribution to the exit code.
// Dropped rather than left as a fake check — an advisory that always "passes"
// trains you to ignore the report. It was never automatable in this script
// anyway: it inspects the OPERATOR'S MACHINE (Windows scheduled tasks), not the
// repo, so it is unrunnable on the Linux CI runners this lint gates.
//
// The underlying question is still worth asking periodically, by hand, on the
// operator's Windows box — "does a scheduled legacy-* task shadow a wired native
// engine?":
//
//   Get-ScheduledTask | ? State -eq 'Ready' | ? TaskName -match 'legacy-'
//
// That is an operating procedure, not a build gate. Keep it out of the lint.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const SERVICES = join(ROOT, 'electron', 'services')
const ENGINE_DIRS = [join(SERVICES, 'brain'), join(SERVICES, 'proactive')]

function walk(dir) {
  const out = []
  let ents
  try { ents = readdirSync(dir) } catch { return out }
  for (const e of ents) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (e.endsWith('.ts') && !e.endsWith('.test.ts') && !e.endsWith('.d.ts')) out.push(p)
  }
  return out
}

const read = (files) => files.map((f) => ({ f, src: readFileSync(f, 'utf8') }))
const serviceFiles = read(walk(SERVICES))
const corpus = read(walk(join(ROOT, 'electron'))) // callers can live anywhere under electron/

const nonComment = (line) => {
  const t = line.trim()
  return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
}

const findings = { invocation: [], grounding: [], transport: [] }

// ── Axis 2: Grounding — an engine must never read the legacy harness or hardcode a vault path ──
// Signatures: the legacy harness's state dir, and any drive-letter path into a `Documents` folder
// (a vault path spelled out in an engine is the owner's, whoever the owner is).
const LEGACY_SIG = [/\.claude[\\/]_state/, /[A-Za-z]:[\\/][^"'`]*[\\/]Documents[\\/]/]
for (const { f, src } of serviceFiles) {
  src.split('\n').forEach((line, i) => {
    if (!nonComment(line)) return
    if (LEGACY_SIG.some((s) => s.test(line))) findings.grounding.push({ file: relative(ROOT, f), line: i + 1, text: line.trim() })
  })
}

// ── Axis 3: Transport — no live target on the retired :8765 brain ──
const DEAD_PORT = /(https?:\/\/[^"'`\s]*:8765|127\.0\.0\.1:8765|localhost:8765)/
for (const { f, src } of serviceFiles) {
  src.split('\n').forEach((line, i) => {
    if (!nonComment(line) || !DEAD_PORT.test(line)) return
    if (/8799|coerce|retired|legacy|\.replace\(/.test(line)) return // coercion / rewrite points are fine
    findings.transport.push({ file: relative(ROOT, f), line: i + 1, text: line.trim() })
  })
}

// ── Axis 1: Invocation — an engine-entry file must be reachable OR declare its intent ──
// A file is "an engine" if it exports an engine-entry (run*/start*/detect*/…Tick/…Pass/…Live). It
// passes if ANY of its exports is referenced elsewhere under electron/ (routes, ticks, hooks, or
// another engine re-using it) OR it declares an explicit @cohesion-invocation intent. `_eval/`
// scaffolding is excluded (benchmark/eval tools, not runtime engines).
const ENGINE_ENTRY = /export\s+(?:async\s+)?function\s+(?:run|start|detect|measure|evaluate|propose|nudge|watch|tick)[A-Za-z0-9]*\s*\(|export\s+(?:async\s+)?function\s+[A-Za-z0-9]+(?:Tick|Pass|Live)\s*\(/
const exportedNames = (src) => {
  const names = new Set()
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|class|let|var)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1])
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) m[1].split(',').forEach((s) => { const n = s.trim().split(/\s+as\s+/)[0].trim(); if (n) names.add(n) })
  return [...names]
}
for (const enginePath of ENGINE_DIRS.flatMap(walk)) {
  if (/[\\/]_eval[\\/]/.test(enginePath)) continue   // eval/benchmark scaffolding, not a runtime engine
  const src = readFileSync(enginePath, 'utf8')
  if (!ENGINE_ENTRY.test(src)) continue              // not an engine-entry file
  if (/@cohesion-invocation:/.test(src)) continue    // intent declared → intentional, pass
  const names = exportedNames(src)
  const wired = names.some((name) => {
    const re = new RegExp('\\b' + name.replace(/\$/g, '\\$') + '\\b')
    return corpus.some((c) => c.f !== enginePath && re.test(c.src))
  })
  if (!wired) findings.invocation.push({ file: relative(ROOT, enginePath), entries: names })
}

// ── report ──
const out = (s) => process.stdout.write(s + '\n')
const line = '  ' + '─'.repeat(52)
out('\n  DUIN System Cohesion Lint')
out(line)
const axis = (name, arr, fmt) => {
  if (arr.length === 0) return out(`  ✓ ${name}: clean`)
  out(`  ✗ ${name}: ${arr.length} finding(s)`)
  arr.forEach((x) => out('      ' + fmt(x)))
}
axis('Axis 1 Invocation', findings.invocation, (x) => `${x.file} — engine exports [${x.entries.join(', ')}] have no caller and no @cohesion-invocation intent`)
axis('Axis 2 Grounding ', findings.grounding, (x) => `${x.file}:${x.line} — reaches the legacy harness → ${x.text}`)
axis('Axis 3 Transport ', findings.transport, (x) => `${x.file}:${x.line} — live :8765 → ${x.text}`)
out(line)
const hard = findings.invocation.length + findings.grounding.length + findings.transport.length
out(hard === 0 ? '  RESULT: PASS — cohesive on all three axes.\n' : `  RESULT: FAIL — ${hard} cohesion violation(s).\n`)
process.exit(hard === 0 ? 0 : 1)
