// how-you-decide — PURE copy + formatting for the "How you decide" mirror card (P5). Kept out of
// the .tsx so the tone contract is unit-testable in the node env (no jsdom). Every string here is
// DESCRIPTIVE and imperative-free — a mirror, never advice. The copy-lint test rejects any
// should/must/try/consider/reconsider/"maybe you"/"have you thought" from all output. The card is a
// thin JSX shell over these functions. Privacy: rates/counts + the operator's OWN stated preference,
// never a decision title.
import type { FingerprintAxis, Divergence, StyleFingerprint } from "./state";

export const COPY = {
  title: "How you decide",
  subtitlePrefix: "A mirror, not advice — patterns from your ",
  subtitleSuffix: " logged decisions. DUIN doesn't grade these.",
  divergenceHeader: "Where your words and your record differ",
  callIsYours: "Just showing you back to you — the call is yours.",
  silencePrefix: "Nothing to mirror yet — you've logged ",
  observeNote: "not enough recorded yet to call a pattern",
  balancedNote: "you land fairly evenly between the two",
} as const;

const pct = (x: number): number => Math.round(x * 100);

export function subtitle(totalDecisions: number): string {
  return `${COPY.subtitlePrefix}${totalDecisions}${COPY.subtitleSuffix}`;
}

export function silenceLine(totalDecisions: number, minN: number): string {
  return `${COPY.silencePrefix}${totalDecisions} decisions; clear patterns need about ${minN}. No guesses until then.`;
}

/** The lean phrase for an axis — descriptive, imperative-free. */
export function leanPhrase(axis: FingerprintAxis): string {
  if (axis.lean === "A") return `you tend toward ${axis.poles[0]}`;
  if (axis.lean === "B") return `you tend toward ${axis.poles[1]}`;
  if (axis.lean === "balanced") return COPY.balancedNote;
  return COPY.observeNote; // observe tier: shown, but no direction claimed
}

/** The evidence line: raw counts + Wilson band. Never a decision title (privacy). */
export function axisLine(axis: FingerprintAxis): string {
  const ciTxt =
    axis.ci[0] != null && axis.ci[1] != null ? ` · 95% CI ${pct(axis.ci[0])}–${pct(axis.ci[1])}%` : "";
  return `${axis.countA} of ${axis.n} ${axis.poles[0]}${ciTxt}`;
}

/** Bar fill fraction (0..1) — the smoothed ratio, or 0 when silent. */
export function barFraction(axis: FingerprintAxis): number {
  return axis.ratio ?? 0;
}

export function divergenceLine(d: Divergence): string {
  const share = d.againstShare != null ? ` (${pct(d.againstShare)}% of recorded)` : "";
  return `You've said you lean ${d.claimedPole}; your record leans ${d.contradictingPole}${share}. ${COPY.callIsYours}`;
}

/** Axes worth showing: derivable now AND past the silence floor. */
export function visibleAxes(fp: StyleFingerprint): FingerprintAxis[] {
  return fp.fingerprint.axes.filter((a) => a.derivable === "now" && a.gate !== "silent");
}
/** Only fired divergences are surfaced ('aligned'/'cannot-prove' stay silent — no nagging). */
export function firingDivergences(fp: StyleFingerprint): Divergence[] {
  return fp.divergences.filter((d) => d.status === "diverges");
}
/** Whole-card silence when nothing has cleared the floor yet. */
export function isSilent(fp: StyleFingerprint): boolean {
  return visibleAxes(fp).length === 0;
}
