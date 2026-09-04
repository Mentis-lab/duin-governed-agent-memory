// score.mjs — the deterministic vault-eval scorer, ported from bench/vault-eval/vault_eval.py
// (check / score_one / aggregate) and the evaluation's tools/l1_score.py (citation existence).
// Substring match over the answer, case-insensitive; no judge model. It under-measures prose and
// over-measures presence on purpose: presence is what regresses silently.

import { readdirSync, statSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'

/** A criterion passes when ANY of its `any_of` appears, or NONE of its `none_of` appears. */
export function check(answer, crit) {
  const a = String(answer ?? '').toLowerCase()
  if (crit && Array.isArray(crit.any_of)) return crit.any_of.some((s) => a.includes(String(s).toLowerCase()))
  if (crit && Array.isArray(crit.none_of)) return !crit.none_of.some((s) => a.includes(String(s).toLowerCase()))
  return true
}

export function scoreOne(item, answer) {
  const crits = [...(item.criteria ?? []), ...(item.must_not ?? [])]
  const results = crits.map((c) => ({ label: c.label ?? '?', source: c.source ?? '?', pass: check(answer, c) }))
  const passed = results.filter((r) => r.pass).length
  // An empty answer is a failure regardless of criteria — a none_of list cannot pass on nothing.
  const empty = !String(answer ?? '').trim()
  return {
    id: item.id,
    q: item.q,
    dimensions: item.dimensions ?? [],
    criteria: results,
    passed: empty ? 0 : passed,
    total: crits.length,
    rate: empty || crits.length === 0 ? 0 : Math.round((passed / crits.length) * 1000) / 1000,
    empty
  }
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

export function aggregate(scored) {
  const byDim = new Map()
  for (const s of scored) for (const d of s.dimensions) byDim.set(d, [...(byDim.get(d) ?? []), s.rate])
  const critTotal = scored.reduce((n, s) => n + s.total, 0)
  const critPass = scored.reduce((n, s) => n + s.passed, 0)
  // `inferred` criteria are not operator-ratified; report the trustworthy subset separately.
  const ratified = scored.flatMap((s) => s.criteria.filter((r) => r.source === 'operator' || r.source === 'vault'))
  const byDimension = {}
  for (const d of [...byDim.keys()].sort()) byDimension[d] = Math.round(mean(byDim.get(d)) * 1000) / 1000
  return {
    questions: scored.length,
    criteria_passed: critPass,
    criteria_total: critTotal,
    overall: critTotal ? Math.round((critPass / critTotal) * 1000) / 1000 : 0,
    ratified_only: ratified.length ? Math.round((ratified.filter((r) => r.pass).length / ratified.length) * 1000) / 1000 : null,
    ratified_n: ratified.length,
    by_dimension: byDimension
  }
}

// ---- citation existence (l1_score.py) ----
const SKIP_DIRS = new Set(['node_modules', '.git', '.trash', '.obsidian', '.duin', '.brain'])

/** basename (no .md) → [relative paths] for every note in the vault. */
export function buildVaultIndex(vaultDir) {
  const index = new Map()
  const walk = (dir, rel) => {
    let names
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (SKIP_DIRS.has(name)) continue
      const full = join(dir, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      const r = rel ? `${rel}/${name}` : name
      if (st.isDirectory()) walk(full, r)
      else if (name.toLowerCase().endsWith('.md')) {
        const key = name.slice(0, -3)
        index.set(key, [...(index.get(key) ?? []), r])
      }
    }
  }
  walk(vaultDir, '')
  return index
}

const CITE_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g
const BACKTICK_RE = /`([^`\n]+?\.md)`/g
const PATH_RE = /(?<![\w/])((?:[\w\-\u4e00-\u9fff\u00b7\uff08\uff09()[\] ]+\/)+[^/`\n"']+?\.md)(?=[\s)\]`"'\uff0c\u3002\u3001\uff1a:\uff1b;,]|$)/g

/** [{kind:'wikilink'|'path', ref}] found in an answer, de-duplicated in order. */
export function citedPaths(answer) {
  const text = String(answer ?? '')
  const out = []
  for (const m of text.matchAll(CITE_RE)) out.push({ kind: 'wikilink', ref: m[1].trim() })
  for (const m of text.matchAll(BACKTICK_RE)) out.push({ kind: 'path', ref: m[1].trim() })
  for (const m of text.matchAll(PATH_RE)) out.push({ kind: 'path', ref: m[1].trim() })
  const seen = new Set()
  return out.filter((c) => {
    const k = `${c.kind}:${c.ref}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/** 'exists' | 'basename-only' | 'missing' for one citation against the vault. */
export function resolveCitation(cite, { vaultDir, index }) {
  const p = cite.ref.trim().replace(/^["']|["']$/g, '')
  if (cite.kind === 'wikilink') {
    let base = p.split('/').pop()
    if (base.toLowerCase().endsWith('.md')) base = base.slice(0, -3)
    return index.has(base) ? 'exists' : 'missing'
  }
  const rel = p.replace(/\\/g, '/').replace(/^\/+/, '')
  if (vaultDir && existsSync(join(vaultDir, rel))) return 'exists'
  let base = basename(rel)
  if (base.toLowerCase().endsWith('.md')) base = base.slice(0, -3)
  return index.has(base) ? 'basename-only' : 'missing'
}
