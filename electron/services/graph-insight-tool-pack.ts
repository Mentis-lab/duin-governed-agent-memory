// graph-insight-tool-pack.ts — registers the read-only `graph_report` native
// tool. Side-effect registration, loaded by tool-packs.ts (same pattern as
// vault-read-tool-pack.ts / skill-open-tool-pack.ts).
//
// `graph_report` analyses the LIVE structural brain-graph (community detection +
// hubs + cross-cluster bridges + suggested questions) and returns a markdown
// GRAPH_REPORT. It is READ-ONLY (risks:['read'], requiresApproval:false): it
// reads the indexed-notes graph and mutates nothing, so a headless loop can call
// it unattended with no approval. To PERSIST the report a loop pairs it with
// apply_patch (the `graph-insight` loop does exactly this).

import { toolRegistry } from './tool-registry'
import { buildGraphReport } from './brain/graph-insight'

toolRegistry.registerNative(
  {
    id: 'graph_report',
    name: 'graph_report',
    title: 'Brain graph report',
    description:
      'Analyse the brain knowledge-graph and return a markdown report: latent ' +
      'clusters (community detection), hub notes, surprising cross-cluster ' +
      'connections, and suggested questions. Takes no arguments. Read-only — to ' +
      'save the report, write the returned markdown with apply_patch.',
    providerKind: 'native',
    providerId: 'internal',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    },
    risks: ['read'],
    requiresApproval: false,
    enabled: true
  },
  async () => {
    try {
      const { insight, markdown } = buildGraphReport()
      if (insight.stats.nodes === 0) {
        return 'The brain graph is empty (no notes indexed yet) — nothing to report.'
      }
      return markdown
    } catch (e) {
      return { result: `Error: ${(e as Error)?.message ?? String(e)}`, status: 'error' }
    }
  }
)
