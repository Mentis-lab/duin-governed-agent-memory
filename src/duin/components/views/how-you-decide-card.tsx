"use client";

// "How you decide" — the pull-first mirror card (P5). A gentle, read-only reflection of the
// operator's decision idioms + the prescribed-vs-actual divergences, fed by /state/style-fingerprint.
// Silence below the sample floor is first-class. All copy + gating lives in ../../lib/how-you-decide
// (pure + tone-linted); this component is a thin JSX shell. NOT mounted into brain-shell.tsx (the
// concurrent hotspot) — the operator drops <HowYouDecideCard /> into the view of their choice.

import { useEffect, useState } from "react";
import { Fingerprint } from "lucide-react";
import { fetchStyleFingerprint, type StyleFingerprint } from "../../lib/state";
import {
  COPY,
  subtitle,
  silenceLine,
  leanPhrase,
  axisLine,
  barFraction,
  divergenceLine,
  visibleAxes,
  firingDivergences,
  isSilent,
} from "../../lib/how-you-decide";

export function HowYouDecideCard() {
  const [fp, setFp] = useState<StyleFingerprint | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const ac = new AbortController();
    fetchStyleFingerprint(ac.signal)
      .then((d) => {
        setFp(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
    return () => ac.abort();
  }, []);

  if (loading || !fp) return null;

  const total = fp.fingerprint.totalDecisions;
  const silent = isSilent(fp);
  const axes = visibleAxes(fp);
  const divergences = firingDivergences(fp);

  return (
    <section className="rounded-lg border border-border/60 bg-card/40 p-4">
      <header className="mb-3 flex items-center gap-2">
        <Fingerprint className="size-4 shrink-0 text-brand/80" />
        <h2 className="text-[14px] font-medium text-[var(--text-primary)]">{COPY.title}</h2>
      </header>

      {silent ? (
        <p className="text-[12px] leading-relaxed text-[var(--text-muted)]">{silenceLine(total, fp.fingerprint.minN)}</p>
      ) : (
        <>
          <p className="mb-3 text-[12px] leading-relaxed text-[var(--text-secondary)]">{subtitle(total)}</p>

          <ul className="flex flex-col gap-3">
            {axes.map((a) => (
              <li key={a.id} className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[12px] text-[var(--text-primary)]">{a.label}</span>
                  <span className="text-[12px] text-[var(--text-secondary)]">{leanPhrase(a)}</span>
                </div>
                <div className="h-2 rounded-full bg-border/40">
                  <div
                    className="h-2 rounded-full bg-brand/70 transition-[width]"
                    style={{ width: `${Math.round(barFraction(a) * 100)}%` }}
                  />
                </div>
                <span className="text-[12px] tabular-nums text-[var(--text-muted)]">{axisLine(a)}</span>
              </li>
            ))}
          </ul>

          {divergences.length > 0 && (
            <div className="mt-4 border-t border-border/60 pt-3">
              <h3 className="mb-2 text-[12px] font-medium text-[var(--text-secondary)]">{COPY.divergenceHeader}</h3>
              <ul className="flex flex-col gap-2">
                {divergences.map((d) => (
                  <li key={`${d.factId}:${d.axis}`} className="text-[12px] leading-relaxed text-[var(--text-muted)]">
                    {divergenceLine(d)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}
