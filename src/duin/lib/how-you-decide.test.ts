import { describe, it, expect } from "vitest";
import {
  COPY,
  subtitle,
  silenceLine,
  leanPhrase,
  axisLine,
  divergenceLine,
  barFraction,
  visibleAxes,
  firingDivergences,
  isSilent,
} from "./how-you-decide";
import type { FingerprintAxis, Divergence, StyleFingerprint } from "./state";

const axis = (over: Partial<FingerprintAxis>): FingerprintAxis => ({
  id: "reversibility-lean",
  label: "Reversible vs one-way doors",
  poles: ["one-way", "reversible"],
  countA: 5,
  countB: 16,
  n: 21,
  total: 21,
  explicitN: 21,
  ratio: 0.261,
  ci: [0.106, 0.451],
  lean: "B",
  gate: "norm",
  source: "decision-notes",
  derivable: "now",
  ...over,
});
const diverg = (over: Partial<Divergence>): Divergence => ({
  factId: "f1",
  factText: "keep options open",
  axis: "reversibility-lean",
  claimedPole: "reversible",
  contradictingPole: "one-way",
  againstShare: 0.72,
  ci: [0.59, 0.83],
  n: 20,
  status: "diverges",
  ...over,
});
const fp = (over: Partial<StyleFingerprint["fingerprint"]>, divergences: Divergence[] = []): StyleFingerprint => ({
  fingerprint: { generatedAt: 0, totalDecisions: 21, minN: 12, axes: [axis({})], ...over },
  divergences,
  scopedIdioms: [],
  drift: null,
  promotedFactCount: 0,
});

// The tone contract (plan §6): every surfaced string is imperative-free.
const IMPERATIVE = /\b(should|must|try|consider|reconsider)\b|maybe you|have you thought/i;

describe("how-you-decide — tone contract (imperative-free)", () => {
  const strings: string[] = [
    ...Object.values(COPY),
    subtitle(21),
    silenceLine(3, 12),
    axisLine(axis({})),
    divergenceLine(diverg({})),
    leanPhrase(axis({ lean: "A" })),
    leanPhrase(axis({ lean: "B" })),
    leanPhrase(axis({ lean: "balanced" })),
    leanPhrase(axis({ lean: null, gate: "observe" })),
  ];
  for (const s of strings) {
    it(`clean: "${s.slice(0, 48)}…"`, () => expect(IMPERATIVE.test(s)).toBe(false));
  }
});

describe("how-you-decide — formatting", () => {
  it("axisLine shows raw counts + CI, never a title", () => {
    expect(axisLine(axis({}))).toBe("5 of 21 one-way · 95% CI 11–45%");
  });
  it("axisLine omits CI when unavailable (observe tier band still present, but null-safe)", () => {
    expect(axisLine(axis({ ci: [null, null] }))).toBe("5 of 21 one-way");
  });
  it("leanPhrase reflects the axis lean", () => {
    expect(leanPhrase(axis({ lean: "A" }))).toContain("one-way");
    expect(leanPhrase(axis({ lean: "B" }))).toContain("reversible");
    expect(leanPhrase(axis({ lean: null, gate: "observe" }))).toBe(COPY.observeNote);
  });
  it("divergenceLine names both poles + the share + the call-is-yours close", () => {
    const line = divergenceLine(diverg({}));
    expect(line).toContain("reversible");
    expect(line).toContain("one-way");
    expect(line).toContain("72%");
    expect(line.endsWith(COPY.callIsYours)).toBe(true);
  });
  it("barFraction is the smoothed ratio (0 when silent)", () => {
    expect(barFraction(axis({ ratio: 0.261 }))).toBe(0.261);
    expect(barFraction(axis({ ratio: null }))).toBe(0);
  });
});

describe("how-you-decide — visibility + silence gating", () => {
  it("visibleAxes drops silent + needs-capture axes", () => {
    const state = fp({
      axes: [
        axis({ id: "reversibility-lean", gate: "norm", derivable: "now" }),
        axis({ id: "forecast-optimism", gate: "silent", derivable: "now" }),
        axis({ id: "conviction-reversal", gate: "silent", derivable: "needs-capture" }),
      ],
    });
    expect(visibleAxes(state).map((a) => a.id)).toEqual(["reversibility-lean"]);
  });
  it("isSilent true when every axis is below the floor", () => {
    expect(isSilent(fp({ axes: [axis({ gate: "silent" })] }))).toBe(true);
    expect(isSilent(fp({ axes: [axis({ gate: "norm" })] }))).toBe(false);
  });
  it("firingDivergences surfaces only 'diverges' (not aligned/cannot-prove)", () => {
    const state = fp({}, [diverg({ status: "diverges" }), diverg({ status: "aligned" }), diverg({ status: "cannot-prove" })]);
    expect(firingDivergences(state)).toHaveLength(1);
    expect(firingDivergences(state)[0].status).toBe("diverges");
  });
});
