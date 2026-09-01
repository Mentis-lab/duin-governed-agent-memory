import './polyfills/uint8array-encoding' // MUST be first: Uint8Array hex/base64 for Chromium <140 (pdfjs)
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { CanvasWindow } from '@/components/artifacts/CanvasWindow'
import { NodeWindow } from '@/components/brain/NodeWindow'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { installGlobalErrorHandlers, formatGlobalError } from '@/lib/global-errors'
import { installLongTaskMonitor } from '@/lib/longtask-monitor'
import { toast } from '@/stores/toast-store'
import { applyPlatformAttribute } from '@/lib/platform'
import './styles/index.css'

// Stamp the platform BEFORE React renders, like apply-theme does for the theme, so
// chrome that must clear the macOS traffic lights is inset on its first paint rather
// than jumping once a component reads the platform.
applyPlatformAttribute()

// A DETACHED SURFACE loads the SAME renderer bundle with `?view=<kind>&key=<key>`
// (see services/canvas/canvas-window.ts). Routing here rather than inside App
// keeps a detached window from mounting the whole application shell — sidebar,
// chat, brain graph — none of which belong in a single-surface window.
//
// `?canvas=<rel>` is the original canvas form, kept so an already-open window or
// a saved link does not break.
const params = new URLSearchParams(window.location.search)
const legacyCanvas = params.get('canvas')
const view = params.get('view')
const key = params.get('key') ?? ''

const detached =
  legacyCanvas || (view === 'canvas' && key) ? (
    <CanvasWindow rel={legacyCanvas || key} />
  ) : view === 'node' && key ? (
    <NodeWindow nodeId={key} />
  ) : null

// U4. Nothing in the renderer listened for an unhandled rejection — the only such
// listener in the repo is inside artifact-sandbox.ts, which is a DIFFERENT
// WebContentsView. Every swallowed promise in the app was therefore console-only,
// on a frameless window with no application menu.
installGlobalErrorHandlers(window, (r) => {
  console.error('[global]', r.source, r.cause)
  toast.error(r.message, 8000)
})

// Renderer-thread freeze instrument — pairs with main's /debug/stalls. Installed
// in every window kind (attached and detached) since both can stall on mount.
installLongTaskMonitor()

ReactDOM.createRoot(document.getElementById('root')!, {
  // React 19 surfaces these; createRoot was being called with NO options, so an
  // uncaught render error went to console.error and nowhere the operator could see.
  onUncaughtError: (error) => {
    console.error('[react:uncaught]', error)
    toast.error(formatGlobalError(error, 'render'), 8000)
  },
  onCaughtError: (error) => {
    // Already handled by an ErrorBoundary — log it, but do not double-toast on top
    // of the boundary's own visible fallback.
    console.error('[react:caught]', error)
  }
}).render(
  <React.StrictMode>
    {/* The shell of last resort. Per-panel boundaries live in App.tsx so one
        panel's throw cannot take the sidebar, chat and titlebar with it. */}
    <ErrorBoundary label="the application shell">{detached ?? <App />}</ErrorBoundary>
  </React.StrictMode>
)
