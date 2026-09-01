// Side-effect bootstrap for the bundled native tool packs.
//
// Each `./xxx-tool-pack` import has no exports — it runs `toolRegistry.registerNative(...)`
// as a top-level side effect to publish its descriptor + handler. Those
// registrations have to happen after `tool-registry.ts` has finished
// evaluating (specifically: after `export const toolRegistry = new ToolRegistry()`
// has assigned the binding).
//
// Keeping the imports in a separate module — rather than at the bottom of
// `tool-registry.ts` — guarantees the bundler cannot hoist them above the
// registry construction. With them inside `tool-registry.ts`, an
// ES-module bundler can emit the side-effect imports before the
// `new ToolRegistry()` line and crash on startup with
// "ReferenceError: Cannot access 'toolRegistry' before initialization".
//
// Imported by `electron/ipc/index.ts` so the packs are loaded once before
// chat dispatch can expose tools. Keep this module limited to descriptor
// registration; startup work that touches app-ready Electron APIs or starts
// child processes belongs in explicit app-ready calls from main.ts.

import './apply-patch-tool-pack'
import './proposed-edit-tool-pack'
import './vault-read-tool-pack'
import './native-dev-tool-pack'
import './workspace-context-tool-pack'
import './verify-workspace-tool-pack'
import './browser-tool-pack'
import './browser-cdp-input-pack'
import './frontend-qa-tool-pack'
import './web-tool-pack'
import './current-info-tool-pack'
import './image-generation-tool-pack'
import './multi-agent-run-tool-pack'
import './spawn-task-tool-pack'
import './executor/executor-tool-pack'
import './loop-tool-pack'
import './notifications-tool-pack'
import './comms-tool-pack'
import './output/output-tool-pack'
import './act/act-tool-pack'
import './tool-result-spill-tool-pack'
import './skill-open-tool-pack'
import './graph-insight-tool-pack'
import './retrieval-tool-pack'
import './task-control-tool-pack'
import './mcp-resource-tool-pack'

import { toolRegistry } from './tool-registry'
import { trace } from './debug-trace'
import { messageOf } from './guarded'

// Startup self-check. An empty native catalog is the single most damaging
// silent failure in the harness: the chat hands the model ZERO tools, so it
// "can't write files / search / run the terminal" and dead-ends on any agentic
// task — regardless of how capable the model is. Record the count via trace()
// (lands in lamprey-debug.log) so a regression (a pack throwing at import, a
// schema that fails normalization) is visible instead of masquerading as a
// weak model.
try {
  const n = toolRegistry.getDescriptors().length
  if (n === 0) {
    console.error('[tool-packs] CRITICAL: 0 native tools registered — chat will have NO tools.')
  } else {
    console.log(`[tool-packs] native tool catalog ready: ${n} tools`)
  }
  try {
    trace('tool-packs.catalog-ready', { nativeToolCount: n, critical: n === 0 })
  } catch (e) { console.debug('[tool-packs] trace needs app-ready userData path; ignore if too early:', messageOf(e)) }
} catch (err) {
  console.error('[tool-packs] CRITICAL: failed to read the native tool catalog at startup:', err)
  try {
    trace('tool-packs.catalog-read-failed', { error: String(err).slice(0, 200) })
  } catch (e) { console.debug('[tool-packs] ignore:', messageOf(e)) }
}
