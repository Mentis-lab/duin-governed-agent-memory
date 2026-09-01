# DUIN Brain — MCP Server (Evidence Threshold · C2)

Exposes the local DUIN brain (read + a few safe writes) to any MCP client, so you get DUIN's
decisions / forecasts / calibration / world-state — and can capture + resolve — from Claude
Desktop, Cursor, etc., **without opening the DUIN app**. DUIN's decision-instrument layer, where
you already work.

## Run
DUIN must be running (the brain listens on `127.0.0.1:8799`).
```
npx tsx electron/services/mcp-brain/brain-mcp-server.ts
```

## Client config (Claude Desktop → `mcpServers`)
```json
{
  "mcpServers": {
    "duin-brain": {
      "command": "npx",
      "args": ["tsx", "<repo>/electron/services/mcp-brain/brain-mcp-server.ts"],
      "env": { "DUIN_BRAIN_URL": "http://127.0.0.1:8799" }
    }
  }
}
```

## Tools
- **Reads:** `duin_decisions` · `duin_projects` · `duin_tasks` · `duin_forecasts` · `duin_calibration` · `duin_world_state` · `duin_insights`
- **Writes (loopback-only):** `duin_capture_work` · `duin_resolve_decision` · `duin_set_decision_meta`

## Safety
- Only the allow-listed routes above are reachable — no arbitrary passthrough.
- Writes **refuse a non-loopback `DUIN_BRAIN_URL`** — a mis-set base can't silently ship your writes to a remote id-space.
- The brain enforces the **B1 loopback control-plane guard** on the write routes.

## Maintenance
The tool `route`s track the brain's `/state/*` surface. `brain-mcp-tools.ts` is the single source
of truth — if the brain-unification flip renames a `/state/*` route, update the catalog there.
