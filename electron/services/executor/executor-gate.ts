// executor-gate — the ONE decision function for a delegated child's tool calls.
//
// The child harness asks DUIN before every tool call (duin-gate plugin → POST /exec/hook →
// executor-callbacks.ts → here). This module is PURE: it maps the child's tool vocabulary
// onto DUIN's own risk classes and answers allow / deny / ask. The impure half (operator
// hooks, the approval modal, the audit spine) lives in executor-callbacks.ts.
//
// The rules are the review posture's rules applied to a disposable worktree:
//   · reads and edits INSIDE the worktree are reversible → allow;
//   · a shell command is allowed unless action-class floors it (network send, destructive,
//     secret, sandbox bypass) → then the operator is asked;
//   · anything that reaches OUTSIDE the worktree, nests another agent, or talks to a foreign
//     MCP server is denied outright;
//   · an unknown tool is denied — fail closed, the model is told why.

import { isAbsolute, relative, resolve } from 'path'
import { capFloorForDescriptor } from '../governance/action-class'
import type { AllowedTools } from '../subagent-types'

export interface ChildToolCall {
  /** The child's tool name in its own vocabulary (`read`, `edit`, `bash`, `mcp__duin__brief`, …). */
  toolName: string
  /** The child's arguments, already parsed (dsh sends the JSON string; callbacks parse it). */
  toolInput: unknown
  /** The child's working directory as it reports it. */
  cwd: string
}

export interface ChildGateContext {
  /** The run's isolated worktree — the only place the child may read or write. */
  worktreePath: string
  /** The capability allow-list the parent turn granted, in DUIN tool ids. */
  allowedTools: AllowedTools
}

export type ChildToolVerdict =
  | { kind: 'allow'; classId: 'read' | 'edit' | 'shell' | 'callback' | 'plan' }
  | { kind: 'ask'; classId: string; title: string; risks: string[] }
  | { kind: 'deny'; classId: string; reason: string }

/**
 * dsh tool → the DUIN tool id whose capability it exercises. The parent's `allowedTools`
 * speaks DUIN ids, so a child asking for `bash` is checked as `run_command`.
 */
export const DSH_TOOL_CAPABILITY: Readonly<Record<string, string>> = {
  read: 'read_file',
  read_image: 'read_file',
  write: 'write_file',
  edit: 'edit_file',
  bash: 'run_command',
  pwsh: 'run_command',
  todo_write: 'update_plan'
}

const PATH_KEYS = ['path', 'file_path', 'filePath', 'file', 'filename'] as const
const COMMAND_KEYS = ['command', 'cmd', 'script'] as const

/**
 * Shell commands that destroy, rewrite history, leave the worktree's boundary, or raise
 * privilege — always `ask`. Explicit here rather than left to action-class alone: its
 * destructive pattern is `rm\s` with a trailing word boundary, which `rm -rf` (a dash follows
 * the space) never satisfies — masked for DUIN's own run_command because that tool is floored
 * by NAME, unmasked for a child judged by content. Reported, not fixed, in this lane.
 */
export const CHILD_SHELL_ASK: ReadonlyArray<{ re: RegExp; classId: string; title: string; risks: string[] }> = [
  { re: /(^|[\s;&|(])(rm|rmdir|del|erase|Remove-Item|ri|rd)\b/i, classId: 'child-destructive', title: 'Delete files', risks: ['destructive'] },
  { re: /\bgit\s+(clean\b|reset\s+--hard|checkout\s+--\s|restore\s+\.|branch\s+-D|push\s+.*--force|filter-branch|reflog\s+expire)/i, classId: 'child-history', title: 'Rewrite or discard git state', risks: ['destructive'] },
  { re: /\b(mkfs|diskpart|format\s+[a-z]:|dd\s+if=|shred|wipefs)\b/i, classId: 'child-destructive', title: 'Destroy a disk or volume', risks: ['destructive'] },
  { re: /\bgit\s+(push|remote\s+add|send-email)\b/i, classId: 'child-publish', title: 'Push to a remote', risks: ['network'] },
  { re: /\b(npm|pnpm|yarn)\s+publish\b/i, classId: 'child-publish', title: 'Publish a package', risks: ['network'] },
  { re: /\bgh\s+(pr|release|repo|issue|gist)\b/i, classId: 'child-publish', title: 'Act on GitHub', risks: ['network'] },
  { re: /\b(ssh|scp|rsync|sftp|telnet)\b/i, classId: 'child-remote', title: 'Reach a remote host', risks: ['network'] },
  { re: /\b(curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod|irm)\b/i, classId: 'child-network', title: 'Network request from the worktree', risks: ['network'] },
  { re: /\b(docker|kubectl|helm)\s+(push|apply|run|exec)\b/i, classId: 'child-deploy', title: 'Deploy or run a container', risks: ['network'] },
  { re: /\b(sudo|doas|runas)\b/i, classId: 'child-privilege', title: 'Raise privilege', risks: ['sandboxBypass'] }
]

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function firstString(rec: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = rec[k]
    if (typeof v === 'string' && v.trim()) return v
  }
  return null
}

/** Is `candidate` (relative to `cwd` when not absolute) inside `root`? Case-insensitive on win32. */
export function pathInsideWorktree(candidate: string, cwd: string, root: string): boolean {
  const abs = isAbsolute(candidate) ? resolve(candidate) : resolve(cwd, candidate)
  const norm = (p: string): string => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p))
  const rel = relative(norm(root), norm(abs))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function capabilityAllowed(allowed: AllowedTools, duinToolId: string): boolean {
  if (allowed === '*') return true
  return allowed.includes(duinToolId)
}

function risksForClass(classId: string): string[] {
  if (classId.startsWith('risk:')) return [classId.slice('risk:'.length)]
  if (/network|send|upload|push|curl|fetch/i.test(classId)) return ['network']
  if (/secret|credential|token|key/i.test(classId)) return ['secret']
  if (/sandbox/i.test(classId)) return ['sandboxBypass']
  return ['destructive']
}

export function decideChildToolCall(call: ChildToolCall, ctx: ChildGateContext): ChildToolVerdict {
  const name = typeof call.toolName === 'string' ? call.toolName.trim() : ''
  if (!name) return { kind: 'deny', classId: 'unknown-tool', reason: 'the tool has no name' }

  // DUIN's own callback tools (context/brief/etc.) — the principal's planes bound them.
  if (name.startsWith('mcp__duin__')) return { kind: 'allow', classId: 'callback' }
  if (name.startsWith('mcp__')) {
    return { kind: 'deny', classId: 'foreign-mcp', reason: `'${name}' reaches an MCP server outside DUIN; only DUIN's own tools are mounted for a delegated run` }
  }
  if (name === 'subagent' || name.startsWith('subagent_')) {
    return { kind: 'deny', classId: 'nested-subagent', reason: 'a delegated run may not spawn its own subagents; DUIN cannot govern a grandchild' }
  }

  const duinToolId = DSH_TOOL_CAPABILITY[name]
  if (!duinToolId) {
    return { kind: 'deny', classId: 'unknown-tool', reason: `'${name}' is not a tool DUIN knows how to govern in a delegated run` }
  }
  if (!capabilityAllowed(ctx.allowedTools, duinToolId)) {
    return { kind: 'deny', classId: 'capability-miss', reason: `'${name}' (${duinToolId}) is outside this run's allowed tools` }
  }

  const input = asRecord(call.toolInput)

  if (name === 'read' || name === 'read_image') {
    const p = firstString(input, PATH_KEYS)
    if (p && !pathInsideWorktree(p, call.cwd, ctx.worktreePath)) {
      return { kind: 'deny', classId: 'path-escape', reason: `'${p}' is outside the run's worktree; a delegated run reads only its own workspace` }
    }
    return { kind: 'allow', classId: 'read' }
  }

  if (name === 'write' || name === 'edit') {
    const p = firstString(input, PATH_KEYS)
    if (!p) return { kind: 'deny', classId: 'path-unverifiable', reason: `'${name}' named no path DUIN could check` }
    if (!pathInsideWorktree(p, call.cwd, ctx.worktreePath)) {
      return { kind: 'deny', classId: 'path-escape', reason: `'${p}' is outside the run's worktree; a delegated run writes only its own workspace` }
    }
    return { kind: 'allow', classId: 'edit' }
  }

  if (name === 'bash' || name === 'pwsh') {
    const command = firstString(input, COMMAND_KEYS)
    if (!command) return { kind: 'deny', classId: 'command-unverifiable', reason: `'${name}' carried no command DUIN could classify` }
    // Commands that carry the worktree's contents OUT (publish, push, upload, remote shells) or
    // escalate privilege. Neither sandbox restricts the network, so these ask the operator.
    const outward = CHILD_SHELL_ASK.find((r) => r.re.test(command))
    if (outward) return { kind: 'ask', classId: outward.classId, title: outward.title, risks: outward.risks }
    // Then the same content floor DUIN applies to its own tools in an unattended run, under a
    // NEUTRAL descriptor name: `run_command` would classify as exec-shell by name alone and
    // floor every command, while inside a disposable, write-restricted worktree a plain
    // `npm test` is reversible. `write`-only risks mean exactly that; the classifier upgrades
    // by content (rm, overwrite, credentials, outward sends).
    const floored = capFloorForDescriptor({ name: 'delegated', risks: ['write'], mutates: true }, { command })
    if (floored) return { kind: 'ask', classId: floored.classId, title: floored.title, risks: risksForClass(floored.classId) }
    return { kind: 'allow', classId: 'shell' }
  }

  if (name === 'todo_write') return { kind: 'allow', classId: 'plan' }

  return { kind: 'deny', classId: 'unknown-tool', reason: `'${name}' has no gate rule` }
}
