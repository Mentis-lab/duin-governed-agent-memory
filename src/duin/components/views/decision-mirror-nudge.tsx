"use client";

import { t } from '@/lib/i18n'
// Surface B inline mirror (P7) — the rare at-decision nudge. A MUTED inline card (never a modal)
// that shows a decision-style pattern back to the operator. GATED OFF by default server-side
// (divergence-nudge.ts / DUIN_DIVERGENCE_NUDGE) — the fire decision + copy are computed there; this
// component only renders a decision and owns the UI-only suppression store. Props-driven so it is
// not wired into any write path until the operator opts in.

import { useState } from "react";
import { Fingerprint } from "lucide-react";

const STORE_KEY = "duin:mirror-dismissed";

/** UI-only suppression store — which mirror patterns the operator has permanently dismissed. */
export function readDismissedPatterns(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}
export function dismissPattern(key: string): void {
  if (typeof window === "undefined") return;
  const s = readDismissedPatterns();
  s.add(key);
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify([...s]));
  } catch {
    /* ignore */
  }
}

export function DecisionMirrorNudge({
  copy,
  patternKey,
  onClose,
}: {
  copy: string;
  patternKey: string;
  onClose?: () => void;
}) {
  const [gone, setGone] = useState(false);
  if (gone) return null;
  const close = () => {
    setGone(true);
    onClose?.();
  };
  return (
    <aside className="rounded-md border border-border/60 border-l-2 border-l-brand/70 bg-card/60 px-3 py-2">
      <div className="mb-2 flex items-start gap-2">
        <Fingerprint className="mt-0.5 size-3.5 shrink-0 text-brand/80" />
        <p className="text-[12px] leading-relaxed text-[var(--text-secondary)]">{copy}</p>
      </div>
      <div className="flex items-center justify-end gap-2">
        <button
          className="rounded px-2 py-1 text-[12px] text-[var(--text-muted)] transition hover:text-[var(--text-primary)]"
          onClick={close}
        >
          {t('Got it')}
        </button>
        <button
          className="rounded px-2 py-1 text-[12px] text-[var(--text-muted)] transition hover:text-[var(--text-primary)]"
          onClick={() => {
            dismissPattern(patternKey);
            close();
          }}
        >
          Don&apos;t mirror this pattern again
        </button>
      </div>
    </aside>
  );
}
