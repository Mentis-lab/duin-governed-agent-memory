import { t } from '@/lib/i18n'
import { lazy, Suspense } from 'react'
import { useUiStore, type ToolId } from '@/stores/ui-store'
import { IconButton } from '@/components/ui/IconButton'
import { SurfaceIcon } from '@/components/icons/SurfaceIcon'
import { RightPanelHeader } from '@/components/layout/RightPanelHeader'
const FilesPanel = lazy(() => import('./panels/FilesPanel').then((m) => ({ default: m.FilesPanel })));
const ReviewPanel = lazy(() => import('./panels/ReviewPanel').then((m) => ({ default: m.ReviewPanel })));
const TerminalPanel = lazy(() => import('./panels/TerminalPanel').then((m) => ({ default: m.TerminalPanel })));
const PlanToolPanel = lazy(() => import('./panels/PlanToolPanel').then((m) => ({ default: m.PlanToolPanel })));
const BackgroundTasksPanel = lazy(() => import('./panels/BackgroundTasksPanel').then((m) => ({ default: m.BackgroundTasksPanel })));
const AfterActionPanel = lazy(() => import('./panels/AfterActionPanel').then((m) => ({ default: m.AfterActionPanel })));
const AutomationsHubPanel = lazy(() => import('./panels/AutomationsHubPanel').then((m) => ({ default: m.AutomationsHubPanel })));
const HomeStatusHubPanel = lazy(() => import('./panels/HomeStatusHubPanel').then((m) => ({ default: m.HomeStatusHubPanel })));
const BrainExplorerPanel = lazy(() => import('@/components/brain/BrainExplorerPanel').then((m) => ({ default: m.BrainExplorerPanel })));
const GraphReportPanel = lazy(() => import('./panels/GraphReportPanel').then((m) => ({ default: m.GraphReportPanel })));
const RelationsPanel = lazy(() => import('./panels/RelationsPanel').then((m) => ({ default: m.RelationsPanel })));
const DecisionsPanel = lazy(() => import('./panels/DecisionsPanel').then((m) => ({ default: m.DecisionsPanel })));
const LearningPanel = lazy(() => import('./panels/LearningPanel').then((m) => ({ default: m.LearningPanel })));
const SourcesPanel = lazy(() => import('@/components/workspace/SourcesPanel').then((m) => ({ default: m.SourcesPanel })));
const ArtifactsPanel = lazy(() => import('@/components/workspace/ArtifactsPanel').then((m) => ({ default: m.ArtifactsPanel })));
const LibraryView = lazy(() => import('@/components/library/LibraryView').then((m) => ({ default: m.LibraryView })));

export const TOOL_LABELS: Record<ToolId, string> = {
  files: 'Files',
  review: 'Review',
  terminal: 'Terminal',
  sources: 'Sources',
  artifacts: 'Artifacts',
  plan: 'Plan',
  background: 'Background tasks',
  afterAction: 'After action',
  brain: 'Explorer',
  graphReport: 'Graph Report',
  decisions: 'Decisions',
  learning: 'Learning',
  automations: 'Automations',
  library: 'Library',
  homeStatus: 'Status',
  relations: 'Relations'
}

function renderToolBody(tool: ToolId): React.ReactElement {
  switch (tool) {
    case 'files':
      return <FilesPanel />
    case 'review':
      return <ReviewPanel />
    case 'terminal':
      return <TerminalPanel />
    case 'sources':
      return <SourcesPanel />
    case 'artifacts':
      return <ArtifactsPanel />
    case 'plan':
      return <PlanToolPanel />
    case 'background':
      return <BackgroundTasksPanel />
    case 'afterAction':
      return <AfterActionPanel />
    case 'brain':
      return <BrainExplorerPanel />
    case 'graphReport':
      return <GraphReportPanel />
    case 'decisions':
      return <DecisionsPanel />
    case 'learning':
      return <LearningPanel />
    case 'automations':
      return <AutomationsHubPanel />
    case 'library':
      return <LibraryView />
    case 'homeStatus':
      return <HomeStatusHubPanel />
    case 'relations':
      return <RelationsPanel />
  }
}

export function ToolsPanel() {
  const activeTool = useUiStore((s) => s.activeTool)
  const closeActiveTool = useUiStore((s) => s.closeActiveTool)

  if (!activeTool) return null

  // The Explorer is the panel's permanent main surface — it is what the panel
  // opens on and what "back to Explorer" returns to — so it gets no per-surface
  // close glyph. Every other surface keeps one: closing them lands on All
  // Surfaces, which for the Explorer would just be the trip you already have a
  // labelled button for. Hiding the panel entirely is a different gesture and
  // still lives on the side-panel chevron in SecondaryToolbar.
  const closable = activeTool !== 'brain'

  return (
    <>
      <RightPanelHeader
        icon={<SurfaceIcon id={activeTool} className="h-5 w-5" />}
        label={TOOL_LABELS[activeTool]}
        actions={
          closable ? (
            <IconButton
              onClick={closeActiveTool}
              title={t('Close tool')}
              aria-label={t('Close tool')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </IconButton>
          ) : undefined
        }
      />
      {/* Each panel is code-split (React.lazy) and loads when first opened, so the
          ~30 panels + their heavy deps (pdfjs, CodeMirror) stay out of the eager
          first-paint bundle. */}
      <Suspense fallback={<div className="p-3 text-[12px] text-[var(--text-muted)]">Loading…</div>}>
        {renderToolBody(activeTool)}
      </Suspense>
    </>
  )
}
