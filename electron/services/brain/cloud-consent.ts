// cloud-consent — may DUIN send vault content to a cloud model WITHOUT the operator asking?
//
// Release M11 (A4 F7, R1 C4). Two automatic passes send the operator's notes to whatever
// provider `routeModel('extraction')` resolves — the boot-time extraction→construction tail
// (1 + ⌈N/40⌉ calls per launch, server.ts) and the edit-driven rebuilds behind the notes
// watcher — and the transfer-A/B litmus spends 72 calls per daily pass on top. On a public
// build none of that may run on a stranger's key just because the key exists. Two things
// authorize it, either one is enough:
//
//   • `backgroundAutonomy` — the master switch for unattended, billable work (Settings → Loops).
//   • `cloudExtractionConsent` — recorded the moment the operator saves a provider key AFTER
//     the disclosure line ("DUIN sends that provider your current question plus relevant
//     excerpts and personalization context, and — to build your knowledge graph — your notes,
//     in batches") shown in the key modal, Settings → API keys, and onboarding. Saving a key is
//     the operator-initiated act the disclosure attaches to; ipc/settings.ts records it.
//
// A LOCAL model needs neither: an Ollama route egresses nothing off-box, so the free path an
// onboarding user is promised ("DUIN found a free local model — it'll use it automatically")
// stays automatic. No model at all → nothing to spend → not this gate's concern (the passes
// no-op key-gated, exactly as before).
//
// Explicit operator intent (the Rebuild button, onboarding adoption, a manual reindex, the
// post-key build) is not "automatic" and does not consult this gate — same rule as
// background-work-gate.ts. Fail-closed: an unreadable settings file reads as no consent.

import { readSettings } from '../settings-helper'
import { routeModel, isLocalModel } from '../providers/registry'

export interface CloudWorkVerdict {
  ok: boolean
  /** Machine reason when declined, for one honest log line. */
  reason?: 'no-cloud-consent'
  detail?: string
}

/** PURE rule: given the persisted settings and whether the routed extraction model runs
 *  on-device, may an automatic cloud pass run? */
export function cloudWorkAllowedFor(
  settings: Record<string, unknown>,
  extractionModel: string | null,
  isLocal: (modelId: string) => boolean = isLocalModel
): CloudWorkVerdict {
  if (!extractionModel) return { ok: true } // nothing routable → nothing to spend
  if (isLocal(extractionModel)) return { ok: true } // on-device: egresses nothing
  if (settings.backgroundAutonomy === true) return { ok: true }
  if (settings.cloudExtractionConsent === true) return { ok: true }
  return {
    ok: false,
    reason: 'no-cloud-consent',
    detail:
      'unattended cloud extraction needs the operator to save a provider key after the disclosure ' +
      '(Settings → API keys) or to turn on background autonomy'
  }
}

export interface CloudConsentDeps {
  settings: () => Record<string, unknown>
  extractionModel: () => string | null
  isLocal: (modelId: string) => boolean
}

const defaultDeps: CloudConsentDeps = {
  settings: () => readSettings(),
  extractionModel: () => routeModel('extraction'),
  isLocal: isLocalModel
}

/** The live gate. Resolved FRESH on every call so saving a key or flipping autonomy takes
 *  effect on the next pass, not the next launch. Never throws: any failure reads as no consent. */
export function automaticCloudWorkAllowed(deps: CloudConsentDeps = defaultDeps): CloudWorkVerdict {
  let settings: Record<string, unknown>
  try {
    settings = deps.settings()
  } catch {
    return { ok: false, reason: 'no-cloud-consent', detail: 'settings unreadable — treated as no consent' }
  }
  let model: string | null
  try {
    model = deps.extractionModel()
  } catch {
    model = null
  }
  return cloudWorkAllowedFor(settings, model, deps.isLocal)
}
