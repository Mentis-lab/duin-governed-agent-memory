# Brain-graph pre-flight harness

Renders the operator's LIVE brain map through `@cosmos.gl/graph` with the same configuration
`src/duin/components/cosmos-brain-canvas.tsx` uses, in a headless Chrome, so a renderer change can
be SEEN before it ships and without touching the running app.

Why it exists (2026-09-02): pushing `setPointShapes`/`setLinkStyles` into the deployed renderer
over CDP to preview a change left `Page.captureScreenshot` hung for the rest of that app's life
(frames kept rendering at 16.7 ms; only the capture path died). Previewing on the operator's
window is not a safe verification path. This is.

## Run

```bash
# 1. dump the live map (read-only; walks the React fiber of the mounted canvas, needs the app on CDP :9333)
node scripts/brain-graph-preflight/dump-live-graph.cjs D:/somewhere/live-graph.json

# 2. bundle the harness page against the repo's node_modules and render scenarios
node scripts/brain-graph-preflight/run.cjs D:/somewhere/live-graph.json idle-plain zoom-focus-gradient overview-focus-gradient
# screenshots land next to the dump as h-<scenario>.png
```

Scenarios live in `main.js` (`window.__scenario`); add one per question you want a picture of.
The ones that show what ships (2026-09-03): `idle-plain` (the dump as drawn), `zoom-focus-gradient` /
`overview-focus-gradient` (a lit neighbourhood: solid gradient links), `idle-weighted` / `zoom-weighted`
(the dump re-stamped with the adaptive link ink and the extracted-layer weighting). Labels and
framing are DOM and camera behaviour the harness does not render; check those on the app.
The dump contains the operator's node labels: keep it out of the repo.
