// gate-compose-wiring.test.ts — regression cover for the two governance WIRING defects found by
// the 2026-07-20 objective evaluation (PLANNING/DUIN_OBJECTIVE_EVAL_RESULTS_2026-07-20.md §3.1).
//
// Defect 1: the ANS composer at the /agui gate resolved capabilities with getCapability(toolName),
//           but the ledger only held ANS-native ids — so rung was ALWAYS null, composeTierRung was
//           a permanent no-op, and Govern.enforcement credited it +38 on an import-grep probe.
// Defect 2: the subagent's derived least-privilege toolset chose which schemas were OFFERED but
//           allowsTool was bound to the broad SUBAGENT_TOOLS set — so it was never ENFORCED.

import { describe, it, expect, beforeEach } from 'vitest'
import { composeTierRung } from './gate-compose'
import { registerCapability, getCapability, setRung, seedCapabilities, __resetCapabilityLedger } from './capability-ledger'
import { subagentToolAllowed } from '../local-brain/subagent-config'

describe('ANS composer wiring (defect 1)', () => {
  beforeEach(() => __resetCapabilityLedger())

  it('resolves an ACT effector by its TOOL NAME — the namespace the gate actually passes', () => {
    // The gate calls getCapability(tc.function.name). Before the fix nothing registered under a
    // tool name, so this lookup returned undefined for every gated tool in existence.
    registerCapability({ id: 'calendar_delete_event', title: 'Delete Google Calendar event', rung: 'reflexive', floorRung: 'stage' })
    expect(getCapability('calendar_delete_event')).toBeDefined()
  })

  it('is a NO-OP at the registered resting rung — the fix changes wiring, not permissions', () => {
    registerCapability({ id: 'drive_upload_file', title: 'Upload file to Google Drive', rung: 'reflexive', floorRung: 'stage' })
    const cap = getCapability('drive_upload_file')!
    const composed = composeTierRung('allow', cap.rung)
    expect(composed.kind).toBe('allow')
    expect(composed.tightenedByRung).toBe(false)
  })

  it('TIGHTENS once the governor demotes — the behaviour the composer existed for', () => {
    registerCapability({ id: 'feishu_create_doc', title: 'Create Feishu document', rung: 'reflexive', floorRung: 'stage' })
    setRung('feishu_create_doc', 'stage')
    const staged = composeTierRung('allow', getCapability('feishu_create_doc')!.rung)
    expect(staged.kind).toBe('prompt')
    expect(staged.tightenedByRung).toBe(true)

    setRung('feishu_create_doc', 'hold')
    const held = composeTierRung('allow', getCapability('feishu_create_doc')!.rung)
    expect(held.kind).toBe('deny')
    expect(held.tightenedByRung).toBe(true)
  })

  it('never loosens: an unregistered tool leaves the tier verdict untouched', () => {
    expect(getCapability('run_command')).toBeUndefined()
    const composed = composeTierRung('prompt', null)
    expect(composed.kind).toBe('prompt')
    expect(composed.tightenedByRung).toBe(false)
  })

  it('a rung can never loosen a deny', () => {
    expect(composeTierRung('deny', 'reflexive').kind).toBe('deny')
  })

  // The OTHER half of defect 1: the ACT tests above prove getCapability resolves an ACT
  // connector by tool name. But the gate's own most direct targets — /agui's SIX native
  // gated tools (run_command, start_command, delete_file, move_file, send_email,
  // spawn_agent; agui-guard.ts's AGUI_GATED_TOOLS) — were never registered by ANYONE:
  // seedCapabilities() only knew five abstract ANS-native ids (none a tool name), and
  // external-action.ts registers only ACT connector ids (a disjoint set). So
  // getCapability(tc.function.name) returned undefined for every native /agui call too,
  // regardless of the ACT-side fix above.
  it('seedCapabilities() registers the SIX native /agui gated tools by their tool name', () => {
    seedCapabilities()
    for (const id of ['run_command', 'start_command', 'delete_file', 'move_file', 'send_email', 'spawn_agent']) {
      const cap = getCapability(id)
      expect(cap, `expected seedCapabilities() to register '${id}'`).toBeDefined()
      // Seeded at 'reflexive' — a deliberate no-op, matching the ACT-side fix: this changes
      // wiring, not permissions. Every existing install behaves identically the moment this ships.
      expect(composeTierRung('allow', cap!.rung).tightenedByRung).toBe(false)
      // None of the six may ever earn full silent autonomy (also required by
      // self-improve-bench.ts's live 'cap-class-floored' safety gate for the send/delete-titled ones).
      expect(cap!.floorRung).toBe('stage')
    }
  })

  it('a governor demotion on a native /agui tool now actually tightens — previously impossible', () => {
    seedCapabilities()
    setRung('delete_file', 'hold')
    const composed = composeTierRung('allow', getCapability('delete_file')!.rung)
    expect(composed.kind).toBe('deny')
    expect(composed.tightenedByRung).toBe(true)
  })
})

describe('subagent least-privilege ENFORCEMENT (defect 2)', () => {
  it('enforces the derived allow-list at dispatch, not just at offer time', () => {
    const readOnly = ['read_file', 'list_dir', 'search_files']
    expect(subagentToolAllowed('read_file', readOnly)).toBe(true)
    // The regression: run_command is in SUBAGENT_TOOLS, so the old predicate allowed it
    // even when the derived toolset was read-only.
    expect(subagentToolAllowed('run_command', readOnly)).toBe(false)
    expect(subagentToolAllowed('delete_file', readOnly)).toBe(false)
  })

  it('an EMPTY allow-list means no per-run restriction — bare {task} spawns are unchanged', () => {
    expect(subagentToolAllowed('run_command', [])).toBe(true)
    expect(subagentToolAllowed('write_file', [])).toBe(true)
  })

  it('the subagent ceiling still binds even when the allow-list names something outside it', () => {
    expect(subagentToolAllowed('render_artifact', ['render_artifact'])).toBe(false)
    expect(subagentToolAllowed('spawn_agent', ['spawn_agent'])).toBe(false)
  })

  it('accepts a Set as well as an array (the policy threads a Set)', () => {
    expect(subagentToolAllowed('read_file', new Set(['read_file']))).toBe(true)
    expect(subagentToolAllowed('run_command', new Set(['read_file']))).toBe(false)
    expect(subagentToolAllowed('run_command', new Set<string>())).toBe(true)
  })
})
