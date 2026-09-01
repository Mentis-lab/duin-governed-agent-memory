// action-class — the irreversibility taxonomy as a machine policy engine (legacy harness
// behavior-classes.json + harness_common.py). This is the governance KEYSTONE: it lets
// DUIN gate by an action's CLASS-RISK (is this kind of act irreversible / outward /
// foundational?) instead of only by permission subject. Every downstream gate — the
// tool-exec guard, the ANS governor's floor — should consult it.
//
// The load-bearing property is the FAIL-SAFE: anything unclassifiable resolves to the
// MOST cautious verdict — CAP (needs human), irreversible, foundational. "Unknown →
// gated" is what makes the whole gate safe: a novel action can never slip through as
// auto-allowed just because no rule named it.
//
//   Tier A  read / query / analyze            → grad (may act autonomously)
//   Tier B  reversible writes (notes, edits)  → grad (may act, staged/reviewable)
//   Tier C  irreversible / outward / founda-  → cap  (always human)
//           tional / done-claims / financial
//
// Pure + unit-tested. Ordered specific→general; first match wins, so a dangerous verb
// is caught before a benign one (e.g. "delete a note" is destructive, not a note-write).

export type Tier = 'A' | 'B' | 'C'
/** grad = may act autonomously; cap = requires human approval. */
export type Disposition = 'grad' | 'cap'

export interface ActionClass {
  id: string
  title: string
  tier: Tier
  disposition: Disposition
  irreversible: boolean
  foundational: boolean
  patterns: RegExp[]
}

// Order matters — most dangerous / most specific first.
export const ACTION_CLASSES: ActionClass[] = [
  // ── Tier C — irreversible / outward / foundational → CAP ──
  {
    id: 'outward-send',
    title: 'Send outward (email / message / post / publish)',
    tier: 'C',
    disposition: 'cap',
    irreversible: true,
    foundational: false,
    patterns: [/\b(send|email|e-mail|post|publish|tweet|dm|broadcast|notify|reply to)\b/i, /发送|发布|回复|群发|发消息|投稿/]
  },
  {
    id: 'financial',
    title: 'Financial / payment / contract',
    tier: 'C',
    disposition: 'cap',
    irreversible: true,
    foundational: false,
    patterns: [/\b(pay|payment|purchase|buy|transfer funds|wire|invoice|refund|contract|sign(ed)?)\b/i, /支付|付款|转账|合同|签约|报价/]
  },
  {
    id: 'credential-secret',
    title: 'Handle credentials / secrets',
    tier: 'C',
    disposition: 'cap',
    irreversible: true,
    foundational: true,
    patterns: [/\b(password|secret|api[_\s-]?key|access[_\s-]?token|private key|credential)\b/i, /密码|密钥|凭证/]
  },
  {
    id: 'destructive-data',
    title: 'Delete / overwrite files or data',
    tier: 'C',
    disposition: 'cap',
    irreversible: true,
    foundational: false,
    patterns: [/\b(delete|rm\s|remove|drop\s+table|truncate|overwrite|wipe|purge|format\s+(disk|drive))\b/i, /删除|清空|覆盖|抹除/]
  },
  {
    id: 'exec-shell',
    title: 'Execute a shell command / spawn a process',
    tier: 'C',
    disposition: 'cap',
    irreversible: true,
    foundational: false,
    patterns: [/\b(exec|execute|spawn|shell|bash|powershell|cmd\.exe|run\s+command|subprocess)\b/i]
  },
  {
    id: 'foundational-edit',
    title: 'Edit a foundational / config / policy file',
    tier: 'C',
    disposition: 'cap',
    irreversible: false,
    foundational: true,
    patterns: [/\b(settings|config|\.env\b|permissions?|governance|policy|capabilit(y|ies))\b/i, /配置|权限|设置文件/]
  },
  {
    id: 'done-claim',
    title: 'Claim completion without executed proof',
    tier: 'C',
    disposition: 'cap',
    irreversible: false,
    foundational: false,
    patterns: [/\b(mark\s+(it\s+)?done|claim\s+(it\s+)?(done|complete)|it'?s\s+(done|finished|shipped|resolved))\b/i]
  },
  // ── Tier B — reversible writes → grad (may act, staged/reviewable) ──
  {
    id: 'durable-write',
    title: 'Write durable knowledge (note / rule / fact / card)',
    tier: 'B',
    disposition: 'grad',
    irreversible: false,
    foundational: false,
    patterns: [/\b(write|create|save|add|promote|append)\b.*\b(note|rule|fact|card|doc|memo|entry)\b/i, /新建|保存|写入|新增/]
  },
  {
    id: 'file-edit',
    title: 'Edit a non-foundational file',
    tier: 'B',
    disposition: 'grad',
    irreversible: false,
    foundational: false,
    patterns: [/\b(edit|modify|update|patch|change|rename|refactor)\b/i, /修改|编辑|更新|重命名/]
  },
  // ── Tier A — read / query / analyze → grad (fully autonomous) ──
  {
    id: 'read-analyze',
    title: 'Read / query / analyze',
    tier: 'A',
    disposition: 'grad',
    irreversible: false,
    foundational: false,
    patterns: [/\b(read|list|search|query|find|analyze|summari[sz]e|explain|show|view|get|fetch|inspect|describe)\b/i, /查看|读取|搜索|分析|总结|查询/]
  }
]

/** The fail-safe: anything unclassifiable is treated as the MOST cautious verdict. */
export const UNKNOWN_CLASS: ActionClass = {
  id: 'unknown',
  title: 'Unclassified action',
  tier: 'C',
  disposition: 'cap',
  irreversible: true,
  foundational: true,
  patterns: []
}

export interface Classification {
  classId: string
  title: string
  tier: Tier
  disposition: Disposition
  irreversible: boolean
  foundational: boolean
  /** false ⇒ nothing matched, fell through to the CAP fail-safe. */
  matched: boolean
}

function toClassification(c: ActionClass, matched: boolean): Classification {
  return {
    classId: c.id,
    title: c.title,
    tier: c.tier,
    disposition: c.disposition,
    irreversible: c.irreversible,
    foundational: c.foundational,
    matched
  }
}

/** Classify an action from its description. Unknown / empty → the CAP fail-safe. PURE. */
export function classifyAction(text: string): Classification {
  const t = (text ?? '').trim()
  if (!t) return toClassification(UNKNOWN_CLASS, false)
  for (const c of ACTION_CLASSES) {
    if (c.patterns.some((p) => p.test(t))) return toClassification(c, true)
  }
  return toClassification(UNKNOWN_CLASS, false) // unknown → CAP / irreversible / foundational
}

export type Gate = 'allow' | 'require-approval'

/** The enforcement verdict for an action: CAP-class → require-approval, else allow. PURE. */
export function gateForAction(text: string): { gate: Gate; classification: Classification } {
  const c = classifyAction(text)
  return { gate: c.disposition === 'cap' ? 'require-approval' : 'allow', classification: c }
}

/** Convenience predicates (mirror harness_common is_cap / is_irreversible / is_foundational). */
export const isCap = (text: string): boolean => classifyAction(text).disposition === 'cap'
export const isIrreversible = (text: string): boolean => classifyAction(text).irreversible
export const isFoundational = (text: string): boolean => classifyAction(text).foundational

// ── Unattended CAP FLOOR (structured, not free text) ────────────────────────
//
// The loop / headless dispatch has no human to approve a CAP-class act. The
// floor below decides refuse-vs-allow from the descriptor's STRUCTURED signals
// (mutates / requiresApproval / risks) rather than fuzzy-matching the tool name
// as free text. The old free-text `\b`-anchored classify missed snake_case
// names (`shell_command` ≠ `\bshell\b`) so CAP tools slipped through, and it ran
// on reads so a danger word in a `read_file` arg over-blocked. This keys off the
// class instead: reads are NEVER floored; a mutating tool is CAP outright when
// it carries a high-danger risk; otherwise its NORMALIZED name + args are
// classified; and an UNCLASSIFIABLE mutating tool fails safe to CAP.

/** A minimal structural view of a tool descriptor the floor reads. Kept local
 *  so this governance module has no dependency on the tool-registry types;
 *  `LampreyToolDescriptor` is structurally assignable. */
export interface FloorDescriptor {
  name: string
  risks?: readonly string[]
  requiresApproval?: boolean
  mutates?: boolean
}

/** Risks that mark a descriptor as side-effecting / mutating. `read` alone is
 *  never mutating, so a pure read/search tool is never floored. */
const MUTATING_RISKS = new Set<string>(['write', 'network', 'destructive', 'secret', 'sandboxBypass'])

/** Risks dangerous enough that, on a mutating descriptor, they force CAP
 *  directly regardless of the tool's (possibly benign-looking) name: outward
 *  network send, destructive wipe, secret handling, sandbox bypass. `write`
 *  alone is a REVERSIBLE edit (grad) and is deliberately not here. */
const CAP_RISKS = new Set<string>(['network', 'destructive', 'secret', 'sandboxBypass'])

/** Mutating risks that are REVERSIBLE — a local durable write that can be undone /
 *  re-edited (e.g. `memory_add`, note writes). An unmatched mutating tool whose
 *  risks are ALL reversible is allowed to run unattended; only a mutating tool with
 *  NO reversible signal (ambiguous / unknown) hits the CAP fail-safe below. */
const REVERSIBLE_RISKS = new Set<string>(['write'])

/**
 * CONDITIONALLY destructive tool: one whose descriptor must declare the risk of
 * the WORST branch it can take, even though most calls don't take it. Returns
 * true only when THIS call's args PROVE the reversible branch was taken.
 *
 * `apply_patch` is the only such tool in the registry. One envelope can Add,
 * Update or Delete, so apply-patch-tool-pack.ts has to declare `destructive` +
 * `requiresApproval: true` statically — which is correct for the attended gate
 * (chat.ts routes every call through the modal, and a "deny destructive"
 * policy must still catch it) but made the floor refuse it TWICE over (step 2
 * on the risk, step 3 on the flag) for every unattended call, including an
 * `*** Add File:` that cannot destroy anything: the applier refuses an Add
 * whose target already exists. That is why every brain loop was silently
 * read-only — loop-agent.ts offers apply_patch as the loop's ONLY write tool,
 * so the artifact was never written while the run still reported 'ok'.
 *
 * The drift was invisible because the floor's own tests hand-wrote apply_patch
 * as `risks: ['write'], requiresApproval: false` — the descriptor it SHOULD
 * have had for a pure editor — so the suite proved the allow that production
 * never took.
 *
 * This does NOT allow the call: it only drops the STATIC over-claim so steps 4
 * and 5 classify the ACTUAL envelope. An Update to a settings/config path is
 * still floored (foundational-edit), and anything mentioning a delete/overwrite
 * is still floored (destructive-data). Fail-safe in every other direction: a
 * missing / non-string / empty patch, a Delete directive, or any other tool
 * returns false and the floor is exactly as before. PURE.
 */
function callProvesReversibleBranch(
  descriptor: FloorDescriptor,
  args: Record<string, unknown>
): boolean {
  if (normalizeToolName(descriptor.name) !== 'apply patch') return false
  const patch = (args ?? {}).patch
  if (typeof patch !== 'string' || patch.trim() === '') return false
  // Deliberately a SUPERSET of the applier's own directive test
  // (apply-patch-tool.ts `parsePatch` matches `line.startsWith('*** Delete File: ')`):
  // leading whitespace and a missing trailing space also count, so a grammar
  // change can only ever make this over-refuse, never under-refuse.
  return !/^[ \t]*\*\*\* Delete File:/m.test(patch)
}

function capRiskTitle(risk: string): string {
  switch (risk) {
    case 'network':
      return 'Outward / network side-effect'
    case 'destructive':
      return 'Destructive data operation'
    case 'secret':
      return 'Handles credentials / secrets'
    case 'sandboxBypass':
      return 'Runs outside the sandbox'
    default:
      return 'High-risk mutation'
  }
}

/** Split snake_case / kebab-case / camelCase names into space-separated words so
 *  the `\b`-anchored patterns can match them (`shell_command` → "shell command",
 *  `applyPatch` → "apply patch"). PURE. */
export function normalizeToolName(name: string): string {
  return (name ?? '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** Concatenate the string-valued args (paths, commands, targets) as extra text the
 *  classifier reads.
 *
 *  The 300-char cap this used to apply ran BEFORE the unattended CAP-floor classifier
 *  ever saw the text, so anything dangerous past that offset was invisible to it.
 *  `apply_patch` is a brain loop's only write tool and its envelopes are routinely
 *  thousands of characters — a patch whose foundational-file write sat in the middle
 *  classified off its first 300 characters alone.
 *
 *  The cap is now large enough to cover a real payload rather than the first line of
 *  one. It is not removed entirely: classifyAction runs a set of regexes per call on
 *  this string, and an unbounded arg (a base64 blob, a whole file) would turn a gate
 *  check into a scan of it. 200k characters is far past any realistic patch while still
 *  bounding the work. PURE. */
const ARG_SUMMARY_CAP = 200_000

function summarizeArgs(args: Record<string, unknown>): string {
  const parts: string[] = []
  for (const v of Object.values(args ?? {})) if (typeof v === 'string') parts.push(v)
  return parts.join(' ').slice(0, ARG_SUMMARY_CAP)
}

/** True when invoking this tool may mutate the workspace / external systems /
 *  persistent state — derived from STRUCTURED signals only, never free text. A
 *  pure read/search descriptor returns false. PURE. */
export function isMutatingDescriptorForFloor(d: FloorDescriptor): boolean {
  if (d.mutates === true) return true
  if (d.requiresApproval === true) return true
  for (const r of d.risks ?? []) if (MUTATING_RISKS.has(r)) return true
  return false
}

/**
 * The UNATTENDED (loop / headless) CAP floor. Returns a `{ classId, title }` to
 * REFUSE the call, or `null` to allow it. Shared by `chat.ts` (loop path) and
 * `tool-exec.ts` (fork / headless path) so both enforce one policy. PURE.
 *
 *  1. Non-mutating (read / search) descriptor → never floored (fixes the read
 *     over-block: a danger word in a `read_file` arg no longer refuses).
 *  1b. CONDITIONALLY destructive descriptor whose args prove the reversible
 *     branch (`apply_patch` with no Delete directive) → its static `destructive`
 *     risk and `requiresApproval` are set aside for THIS call only; 4/5 still
 *     classify the actual envelope. See `callProvesReversibleBranch`.
 *  2. Mutating descriptor with a high-danger risk (network / destructive /
 *     secret / sandboxBypass) → CAP outright (catches `shell_command`, whose
 *     snake_case name the free-text classifier missed).
 *  3. Mutating descriptor with `requiresApproval: true` → CAP. A tool that
 *     DECLARES it needs a human approver must not auto-run when there is no human
 *     — even if its only risk is a reversible `write` or its name classifies as a
 *     grad edit. Placed BEFORE the grad-allow (4) and the reversible-write allow
 *     (5) so neither can undercut it.
 *  4. Otherwise classify the NORMALIZED name + args: a matched CAP class floors;
 *     a matched grad class (reversible write, e.g. `apply_patch` → file-edit) is
 *     allowed so the loop can still do work.
 *  5. FAIL-SAFE: an UNCLASSIFIABLE mutating descriptor → CAP (refuse). An
 *     unrecognised mutating tool must never auto-run unattended.
 */
export function capFloorForDescriptor(
  descriptor: FloorDescriptor,
  args: Record<string, unknown>
): { classId: string; title: string } | null {
  // 1) Reads are never floored.
  if (!isMutatingDescriptorForFloor(descriptor)) return null

  const risks = descriptor.risks ?? []
  const c = classifyAction(`${normalizeToolName(descriptor.name)} ${summarizeArgs(args)}`.trim())

  // 1b) A conditionally-destructive tool whose args prove it took the reversible
  //     branch (apply_patch with no Delete directive). Drops ONLY the static
  //     `destructive` claim and the blanket `requiresApproval` below — never
  //     network / secret / sandboxBypass — and still falls through to the
  //     classification in 4/5, which judges the actual call.
  const reversibleBranch = callProvesReversibleBranch(descriptor, args)

  // 2) A high-danger structured risk forces CAP even if the name looks benign.
  const capRisk = risks.find((r) => CAP_RISKS.has(r) && !(reversibleBranch && r === 'destructive'))
  if (capRisk) {
    return c.matched && c.disposition === 'cap'
      ? { classId: c.classId, title: c.title }
      : { classId: `risk:${capRisk}`, title: capRiskTitle(capRisk) }
  }

  // 3) A descriptor that DECLARES it needs a human (`requiresApproval: true`) must
  //    not auto-run unattended. Placed BEFORE the grad-allow (4) and the reversible-
  //    write allow (5) so a benign name or a `write`-only risk can't undercut it: a
  //    tool that asks for an approver is CAP when there is no approver. If the name
  //    already classifies as CAP, keep that more specific reason. Exempt only a
  //    conditionally-destructive tool that PROVED the reversible branch (1b): its
  //    flag declares the branch this call did not take.
  if (descriptor.requiresApproval === true && !reversibleBranch) {
    return c.matched && c.disposition === 'cap'
      ? { classId: c.classId, title: c.title }
      : { classId: 'requires-approval', title: 'Tool requires human approval' }
  }

  // 4) Matched: CAP floors; a matched grad class (reversible write, e.g. `apply_patch`
  //    → file-edit) is allowed so the loop can still do work.
  if (c.matched) return c.disposition === 'cap' ? { classId: c.classId, title: c.title } : null

  // 5) Unmatched mutating tool: a REVERSIBLE-only-risk tool (e.g. `write` — `memory_add`,
  //    note writes) is a routine local edit → ALLOW. A tool with NO reversible signal
  //    (empty / ambiguous risks, `mutates`/`requiresApproval` only) → FAIL-SAFE CAP: an
  //    unrecognised mutating tool must not auto-run unattended.
  if (risks.length > 0 && risks.every((r) => REVERSIBLE_RISKS.has(r))) return null
  return { classId: 'unknown', title: 'Unclassified mutating action' }
}
