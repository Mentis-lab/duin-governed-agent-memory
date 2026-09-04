import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'

// Source-lock test: the native DUIN surfaces must stay wired end-to-end — ToolId
// union + ToolsPanel import/render. This asserts ONLY that the ToolId + ToolsPanel
// case exist (routing), NOT that any UI actually opens the surface (reachability) —
// `scripts/reachability-lint.mjs` is what answers that question.
// Some surfaces are reached via a launcher pill, some are hub tabs, and some have
// been retired outright; each has its own block below. Reads source as text so it
// doesn't depend on the renderer building.

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

// Every native surface still has a ToolId + a ToolsPanel case.
const ALL_SURFACES = ['learning', 'relations'] as const
const PANELS = ['LearningPanel', 'RelationsPanel']
// Surfaces that own a launcher pill. Active Work + Learning are first-class pills
// again (Learning is now the auditable record of automatic learning, not a review
// queue); homeStatus is the remaining consolidation hub; graphReport and
// afterAction were re-homed as pills (they lost their launcher in the July
// rationalization) — the Explorer lens bar only filters node lists, not full panels.
// relations (2026-08-13) is the seam-edges ego-centric entity/belief surface — a
// Brain-room pill beside the Explorer.
// Decision Sim and Active Work were retired from the UI (see the removal assertion below).
// 2026-09-03: Status, Learning, Automations, Background tasks and After action FOLDED INTO
// HOME (see FOLDED_INTO_HOME below). Home leads the Brain room and is the default surface.
const PILL_SURFACES = ['home', 'graphReport', 'relations'] as const
// Folded into Home: still routed (ToolId + ToolsPanel case) and reached from Home's lines
// and its Details row, but with NO launcher pill. Routing without a pill is exactly the
// half-wired state the retired blocks below guard against, so Home itself is asserted to
// name each one.
const FOLDED_INTO_HOME = ['homeStatus', 'learning', 'automations', 'background', 'afterAction'] as const
// Folded into the homeStatus hub — still route (ToolId + ToolsPanel case) and are
// reached as hub tabs; they have no standalone launcher pill. (QuickOpen opens
// files only, so it does NOT reach these — routing here means wiring, not a UI path.)
const FOLDED_SURFACES = ['calibration', 'status'] as const
// RETIRED FROM THE EXPLORER 2026-08-04. These three were folded in as lenses, and the lenses are
// now gone too. They were populated by derive-knowledge.ts's isMeeting / isOutput / isMentalModel —
// four-way disjunctions over frontmatter type, a tag, a folder name, and an LLM classification —
// which on a vault not organised by those folder names collapses to "whatever the model guessed",
// with no precedence between the four predicates and no exclusion of person notes. The operator's
// categories are tags they author and pin instead.
//
// Asserted as REMOVED rather than simply dropped from the list, for the reason the Insight/Reveal
// block below already gives: a half-removed surface reads like a live one.
//
const RETIRED_LENSES = ['meetings', 'outputs', 'models'] as const
// …and the whole surface behind them: ToolId, ToolsPanel case, panel file, and brain IPC.
const RETIRED_SURFACES = ['mentalModels', 'meetings', 'outputs'] as const

describe('DUIN native surfaces are wired', () => {
  const uiStore = read('../../../stores/ui-store.ts')
  const toolsPanel = read('../ToolsPanel.tsx')
  const rightHome = read('../../artifacts/RightPanelHome.tsx')
  const explorer = read('../../brain/BrainExplorerPanel.tsx')

  it('declares every surface in the ToolId union', () => {
    for (const id of ALL_SURFACES) expect(uiStore).toContain(`| '${id}'`)
  })

  it('imports and renders every panel in ToolsPanel', () => {
    for (const p of PANELS) {
      // panels may be statically imported OR code-split via lazy(() => import(...))
      expect(toolsPanel).toMatch(new RegExp(`import \\{ ${p} \\}|default: m\\.${p}\\b`))
      expect(toolsPanel).toContain(`<${p} />`)
    }
    for (const id of ALL_SURFACES) expect(toolsPanel).toContain(`case '${id}':`)
  })

  it('exposes a launcher pill for the pilled surfaces', () => {
    for (const id of PILL_SURFACES) {
      expect(rightHome).toContain(`id: '${id}'`)
      expect(toolsPanel).toContain(`case '${id}':`)
    }
  })

  it('folds the monitoring surfaces into Home: routed, reachable from Home, no pill, Home is the default', () => {
    const home = read('./HomePanel.tsx')
    for (const id of FOLDED_INTO_HOME) {
      expect(uiStore).toContain(`| '${id}'`)
      expect(toolsPanel).toContain(`case '${id}':`)
      expect(rightHome).not.toContain(`id: '${id}'`)
      expect(home).toContain(`'${id}'`)
    }
    expect(uiStore).toContain(`| 'home'`)
    expect(uiStore).toContain(`activeTool: 'home',`)
    expect(toolsPanel).toContain(`case 'home':`)
    expect(rightHome).toContain(`id: 'home'`)
  })

  it('reaches status/calibration ONLY as homeStatus hub tabs — the ToolIds are gone', () => {
    const homeHub = read('./HomeStatusHubPanel.tsx')
    // These kept a ToolId + ToolsPanel case after they became hub tabs, so the routing
    // survived with nothing able to reach it: no pill, no launcher, no caller. A surface
    // that renders but cannot be opened is the same half-removed state the retired block
    // below exists to prevent, so the routing is asserted GONE, not merely unpilled.
    for (const id of FOLDED_SURFACES) {
      expect(uiStore).not.toContain(`| '${id}'`)
      expect(toolsPanel).not.toContain(`case '${id}':`)
      expect(rightHome).not.toContain(`id: '${id}'`)
    }
    // The panels themselves stay — the hub is what mounts them now.
    expect(homeHub).toContain('BrainStatusPanel')
    expect(homeHub).toContain('CalibrationPanel')
    expect(homeHub).not.toContain('ActiveWorkPanel')
  })

  it('has fully removed the Insight, Reveal, Decision Sim, and Active Work surfaces', () => {
    // Retired surfaces: no ToolId, no ToolsPanel case, no pill.
    //
    // activeWork joined this list 2026-07-27. It was a queue the operator had to open and
    // resolve by hand; its only real output — closing an owed decision — now runs unattended
    // in brain/decision-loop.ts on the calibration tick. Asserting REMOVAL (not just an
    // absent pill) is the point: this surface has a habit of coming back, and a half-removed
    // one that still routes reads like a live feature.
    for (const id of ['insight', 'reveal', 'reviewQueue', 'decisionSim', 'activeWork'] as const) {
      expect(uiStore).not.toContain(`| '${id}'`)
      expect(toolsPanel).not.toContain(`case '${id}':`)
      expect(rightHome).not.toContain(`id: '${id}'`)
    }
  })

  it('no longer offers the retired derived lenses in the Explorer', () => {
    for (const lens of RETIRED_LENSES) expect(explorer).not.toContain(`id: '${lens}'`)
  })

  it('has fully removed Meetings / Outputs / Mental Models, not merely unlinked them', () => {
    // The same doctrine as the Insight/Reveal block: a half-removed surface that still routes
    // reads like a live feature to the next person, and to the next audit.
    for (const id of RETIRED_SURFACES) {
      expect(uiStore).not.toContain(`| '${id}'`)
      expect(toolsPanel).not.toContain(`case '${id}':`)
      expect(rightHome).not.toContain(`id: '${id}'`)
    }
    for (const p of ['MentalModelsPanel', 'MeetingsPanel', 'OutputsPanel']) {
      expect(toolsPanel).not.toContain(p)
    }
    // …and the brain IPC that fed them.
    const preload = read('../../../../electron/preload.ts')
    for (const ch of ['brain:meetings', 'brain:outputs', 'brain:mentalModels']) {
      expect(preload).not.toContain(`invoke('${ch}')`)
    }
  })

  it('partitions the Explorer on layer, so no node can appear in two tiers', () => {
    // The tiers used to be kind SETS that overlapped on person/org/decision, so a vault person
    // note rendered under both Memory and Concepts. `layer` is a real partition; this pins that
    // the tier map is built from it and that every live layer value has a home.
    expect(explorer).toContain('TIER_LAYERS')
    for (const layer of ['vault', 'construction', 'product', 'folder', 'core']) {
      expect(explorer).toContain(`'${layer}'`)
    }
  })

  it('People & Orgs is retired as a right-panel surface', () => {
    // 'orgs' was kept routable for backward compatibility after the merge and nothing ever
    // set it; 'people' was the surviving pill. Both are gone (2026-08-08) along with the
    // panel only they could open — people and orgs remain in the graph and are reached
    // through the Explorer, which is where the operator actually browses them.
    for (const id of ['people', 'orgs']) {
      expect(uiStore).not.toContain(`| '${id}'`)
      expect(toolsPanel).not.toContain(`case '${id}':`)
      expect(rightHome).not.toContain(`id: '${id}'`)
    }
    expect(existsSync(new URL('./PeopleOrgsPanel.tsx', import.meta.url))).toBe(false)
  })

  // P3a — the document Library, a first-class surface (drop docs → searchable
  // brain nodes).
  it('wires the Library surface end-to-end', () => {
    expect(uiStore).toContain(`| 'library'`)
    expect(toolsPanel).toMatch(/import \{ LibraryView \}|default: m\.LibraryView\b/)
    expect(toolsPanel).toContain(`<LibraryView />`)
    expect(toolsPanel).toContain(`case 'library':`)
    expect(rightHome).toContain(`id: 'library'`)
  })
})
