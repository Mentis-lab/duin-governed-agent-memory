// injection-guard.ts — prompt-injection signature detection (standalone, PURE, no deps).
//
// Memory-write injection isolation (SIA activation, SSGM/DRIFT): content that is actually a prompt-
// injection payload must never steer the brain. operator-model.ts already gates the GOVERNED operator-
// fact store with looksInjected; this standalone module is the same guard, reusable on OTHER write
// paths — specifically the live-node-reveal graph path (entity labels / triples extracted from a dropped
// doc), which has no injection gate today.
//
// Specific injection signatures only (instruction-override / role-impersonation / system-tags), NOT
// generic imperatives, so a legit preference like "always lead with the outcome" is unaffected.
//
// NOTE: operator-model.ts still carries its own copy of these signatures; it can later import from here
// so there is a single source of truth. Kept standalone for now to avoid importing the heavy
// operator-fact store into the lightweight extraction path.

const INJECTION_SIGNATURES: RegExp[] = [
  /\bignore\s+(?:all\s+)?(?:previous|prior|above|the\s+above|earlier)\b[^.]*\b(?:instruction|prompt|rule|direction|context)/i,
  /\bdisregard\s+(?:all\s+)?(?:previous|prior|above|earlier)\b/i,
  /\byou\s+are\s+now\b/i,
  /\bnew\s+instructions?\s*:/i,
  /\bforget\s+(?:everything|all\s+(?:previous|prior))/i,
  /(?:^|\n)\s*(?:system|assistant)\s*:/i,
  /<\/?(?:system|assistant|im_start|im_end)>/i,
  /\boverride\s+(?:your|the)\s+(?:instruction|system|prompt|guardrail)/i
]

/** True when text carries prompt-injection signatures. */
export function looksInjected(text: string): boolean {
  const t = String(text || '')
  return INJECTION_SIGNATURES.some((re) => re.test(t))
}
