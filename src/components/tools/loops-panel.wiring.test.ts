import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// LP-9 — source-lock the loops observation UI wiring (WC-8 / era-chrome
// pattern): these read the source text so the pill + panel + ToolId stay wired.

const root = join(__dirname, '..', '..', '..')
const read = (p: string): string => readFileSync(join(root, p), 'utf-8')

describe('LP-9 loops UI wiring', () => {
  it("ui-store no longer carries a 'loop' ToolId — Loops are a hub tab", () => {
    // The ToolId + ToolsPanel case outlived the move into the Automations hub, leaving a
    // route nothing could reach: no pill (asserted below), no launcher entry, no caller.
    expect(read('src/stores/ui-store.ts')).not.toMatch(/\|\s*'loop'/)
    const tools = read('src/components/tools/ToolsPanel.tsx')
    expect(tools).not.toMatch(/case 'loop':/)
    expect(tools).not.toMatch(/loop: 'Loops'/)
  })

  it('AutomationsHubPanel is what mounts LoopsPanel now', () => {
    const hub = read('src/components/tools/panels/AutomationsHubPanel.tsx')
    expect(hub).toMatch(/import \{ LoopsPanel \}|default: m\.LoopsPanel\b/)
    expect(hub).toMatch(/<LoopsPanel \/>/)
  })

  it('RightPanelHome does NOT register a Loops pill (folded into Automations)', () => {
    const src = read('src/components/artifacts/RightPanelHome.tsx')
    // Loops are intentionally not a launcher pill — they live inside Automations.
    expect(src).not.toMatch(/id: 'loop'/)
    // 2026-09-03: the Automations hub itself folded into Home. It keeps its ToolId and panel
    // and opens from Home's Loops line and Details row, so reachability is asserted THERE, not
    // as a launcher pill.
    expect(src).not.toMatch(/id: 'automations'/)
    expect(read('src/components/tools/panels/HomePanel.tsx')).toMatch(/'automations'/)
    expect(read('src/components/tools/ToolsPanel.tsx')).toMatch(/case 'automations':/)
  })

  it('LoopsPanel consumes the loops store + live loop events', () => {
    const src = read('src/components/tools/panels/LoopsPanel.tsx')
    expect(src).toMatch(/useLoopsStore/)
    expect(src).toMatch(/onLoopEvent/)
    expect(src).toMatch(/listBacklog/)
  })

  it('SettingsDialog registers the Automations tab (id workflows); WorkflowsSettings hosts Loops (gap-1)', () => {
    const dialog = read('src/components/settings/SettingsDialog.tsx')
    // static import OR lazy(() => import('./WorkflowsSettings'))
    expect(dialog).toMatch(/import \{ WorkflowsSettings \}|default: m\.WorkflowsSettings\b/)
    // The tab was relabelled Automations on 2026-09-03 (settings evaluation A6); the id stays.
    expect(dialog).toMatch(/id: 'workflows', label: 'Automations'/)
    expect(dialog).toMatch(/activeTab === 'workflows'[\s\S]*?<WorkflowsSettings \/>/)
    // Loops (+ Automations) now live INSIDE the merged Workflows panel.
    const wf = read('src/components/settings/WorkflowsSettings.tsx')
    expect(wf).toMatch(/import \{ LoopSettings \}/)
    expect(wf).toMatch(/import \{ AutomationsSettings \}/)
  })

  it('LoopSettings binds the loop settings keys (gap-1)', () => {
    const src = read('src/components/settings/LoopSettings.tsx')
    expect(src).toMatch(/loopsEnabled/)
    expect(src).toMatch(/loopMaxIterations/)
    expect(src).toMatch(/loopMaxWallclockMs/)
    expect(src).toMatch(/loopMinIntervalSeconds/)
  })
})
