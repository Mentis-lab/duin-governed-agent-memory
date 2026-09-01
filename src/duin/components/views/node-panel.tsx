"use client";
import { t } from '@/lib/i18n'
/* eslint-disable @typescript-eslint/no-explicit-any */

// NodePanel — what opens in the Brain's right rail when you click a node. A vault note renders its
// full doc; every product node (goal · track · move · strategy · project · risk · insight · person …)
// shows an inspector: what it is, what it connects to (walk the graph by clicking a neighbor), and two
// actions — "Talk about this" (launch a grounded chat) and "Open in <lens>" (jump to the full view).

import { ArrowUpRight, MessageSquarePlus, X } from "lucide-react";
import type { BrainGraph, BrainNode } from "@/duin/lib/state";
import type { View } from "@/duin/components/app-sidebar";
import { DocView } from "@/duin/components/views/doc-view";

export const KIND_META: Record<string, { color: string; label: string }> = {
  core: { color: "#e2e8f0", label: "Core" },
  goal: { color: "#fbbf24", label: "Goal" },
  event: { color: "#fbbf24", label: "Event" },
  milestone: { color: "#fbbf24", label: "Milestone" },
  release: { color: "#fbbf24", label: "Release" },
  project: { color: "#38bdf8", label: "Project" },
  track: { color: "#2dd4bf", label: "Track" },
  strategy: { color: "#a78bfa", label: "Strategy" },
  move: { color: "#34d399", label: "Move" },
  risk: { color: "#fb7185", label: "Risk" },
  issue: { color: "#f59e0b", label: "Issue" },
  owed: { color: "#60a5fa", label: "Decision owed" },
  insight: { color: "#22d3ee", label: "Insight" },
  person: { color: "#94a3b8", label: "Person" },
  org: { color: "#818cf8", label: "Org" },
  task: { color: "#fb923c", label: "Task" },
  decision: { color: "#c084fc", label: "Decision" },
  prediction: { color: "#f472b6", label: "Prediction" },
  note: { color: "#64748b", label: "Note" },
  folder: { color: "#64748b", label: "Folder" },
  // Built, viewable HTML documents (decks/tutorials/explainers) — a first-class surface.
  page: { color: "#4ade80", label: "Page" },
};
const km = (k: string) => KIND_META[k] || { color: "#94a3b8", label: k };

// product kind → the full view it belongs to (the "Open in …" deep link)
const KIND_VIEW: Record<string, { view: View; label: string }> = {
  project: { view: "projects", label: "Projects" }, track: { view: "projects", label: "Projects" }, goal: { view: "projects", label: "Projects" },
  person: { view: "people", label: "People" }, org: { view: "people", label: "People" },
  strategy: { view: "strategy", label: "Strategy" },
  task: { view: "tasks", label: "Actions" }, move: { view: "tasks", label: "Actions" },
  insight: { view: "decisions", label: "Insight" }, risk: { view: "decisions", label: "Insight" },
  issue: { view: "decisions", label: "Insight" }, owed: { view: "decisions", label: "Insight" }, decision: { view: "decisions", label: "Insight" },
};

export function NodePanel({
  node, graph, onSelectNode, onChat, onOpenView, onClose,
}: {
  node: BrainNode;
  graph: BrainGraph | null;
  onSelectNode: (n: BrainNode) => void;
  onChat: (prompt: string) => void;
  onOpenView: (v: View) => void;
  onClose: () => void;
}) {
  const meta = km(node.kind);
  const isNote = node.layer === "vault";
  const byId = new Map((graph?.nodes ?? []).map((n) => [n.id, n]));
  const neighbors = (graph?.links ?? [])
    .filter((l) => l.source === node.id || l.target === node.id)
    .map((l) => {
      const otherId = l.source === node.id ? l.target : l.source;
      const out = l.source === node.id;
      return { other: byId.get(otherId), type: l.type, out };
    })
    .filter((n) => n.other && n.other.kind !== "core")
    .slice(0, 40);
  const dest = KIND_VIEW[node.kind];

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start gap-2 border-b border-border/60 px-4 py-3">
        <span className="mt-1 size-2.5 shrink-0 rounded-full" style={{ background: meta.color }} />
        <div className="min-w-0 flex-1">
          <div className="text-[16px] font-semibold leading-snug">{node.label}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
            <span className="rounded-full bg-muted px-1.5 py-0.5">{meta.label}</span>
            {node.layer === "product" && <span>{node.declared === 0 ? "inferred" : "declared"}</span>}
            {node.group && isNote && <span className="truncate">· {node.group}</span>}
          </div>
        </div>
        <button onClick={onClose} title={t('Close')} className="rounded p-1 text-[var(--text-secondary)] transition hover:text-[var(--text-primary)]"><X className="size-4" /></button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isNote ? (
          <div className="px-4 py-3"><DocView path={node.id} /></div>
        ) : (
          <div className="space-y-4 px-4 py-3">
            <div className="flex flex-wrap gap-2">
              <button onClick={() => onChat(`About the ${meta.label.toLowerCase()} "${node.label}" — help me think this through. What's the situation, and what should I do about it?`)}
                className="inline-flex items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 text-[16px] font-medium text-white transition hover:opacity-90">
                <MessageSquarePlus className="size-4" /> {t('Talk about this')}
              </button>
              {dest && (
                <button onClick={() => onOpenView(dest.view)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-3 py-1.5 text-[16px] text-[var(--text-secondary)] transition hover:border-brand/40 hover:text-[var(--text-primary)]">
                  Open in {dest.label} <ArrowUpRight className="size-3.5" />
                </button>
              )}
            </div>

            <div>
              <h3 className="mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Connections {neighbors.length > 0 && <span className="text-[var(--text-muted)]">({neighbors.length})</span>}</h3>
              {neighbors.length === 0 ? (
                <p className="text-[12px] text-[var(--text-secondary)]">{t('No connections in the graph yet.')}</p>
              ) : (
                <div className="space-y-1">
                  {neighbors.map((nb, i) => {
                    const m = km(nb.other!.kind);
                    return (
                      <button key={i} onClick={() => onSelectNode(nb.other!)}
                        className="flex w-full items-center gap-2 rounded-md border border-border/50 bg-card/40 px-2.5 py-1.5 text-left text-[12px] transition hover:border-brand/40 hover:bg-card">
                        <span className="shrink-0 text-[11px] text-[var(--text-secondary)]">{nb.out ? `${nb.type} →` : `← ${nb.type}`}</span>
                        <span className="size-2 shrink-0 rounded-full" style={{ background: m.color }} />
                        <span className="min-w-0 flex-1 truncate">{nb.other!.label}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
