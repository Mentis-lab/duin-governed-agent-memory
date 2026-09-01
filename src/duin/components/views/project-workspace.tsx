"use client";

import { t } from '@/lib/i18n'
// Project workspace — a project's real shape: its tracks (the notes/workstreams in its folder),
// everything those connect to (people · decisions · other projects), and its pipeline (deals/items
// moving across stages — pipelines belong to a project, not a free-floating tab). Click to open.

import { useEffect, useState } from "react";
import { Building2, FileText, FolderKanban, GitBranch, Loader2, Scale, User } from "lucide-react";
import { Sheet, SheetContent } from "@/duin/components/ui/sheet";
import { Badge } from "@/duin/components/ui/badge";
import { DocView } from "@/duin/components/views/doc-view";
import { PipelineBoard } from "@/duin/components/views/pipelines-board";
import { fetchProject, type ConnItem, type Project, type ProjectDetail } from "@/duin/lib/state";
import { cn } from "@/duin/lib/utils";

const CONN_GROUPS: { key: string; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: "people", label: "People", icon: User },
  { key: "decisions", label: "Decisions", icon: Scale },
  { key: "organizations", label: "Organizations", icon: Building2 },
  { key: "projects", label: "Linked projects", icon: FolderKanban },
  { key: "references", label: "References", icon: FileText },
];

export function ProjectDetailInner({ project }: { project: Project }) {
  const [tab, setTab] = useState<"tracks" | "overview" | "connections" | "pipeline">("tracks");
  const [data, setData] = useState<ProjectDetail | null>(null);
  const [doc, setDoc] = useState<string | null>(null);

  useEffect(() => {
    setTab("tracks"); setData(null);
    const c = new AbortController();
    fetchProject(project.name, c.signal).then(setData).catch(() => {});
    return () => c.abort();
  }, [project.name]); // key on the stable name, not the object ref (a live-refresh new ref must not re-fetch/flash "Opening…")

  const connTotal = data ? CONN_GROUPS.reduce((n, g) => n + (data.connections[g.key]?.length ?? 0), 0) : 0;

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b bg-gradient-to-br from-brand/[0.08] to-transparent px-5 py-4 pr-10">
        <div className="flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-brand/15 text-brand"><FolderKanban className="size-4" /></span>
          <h2 className="text-[16px] font-semibold tracking-tight">{project.name}</h2>
        </div>
        {project.desc && <p className="mt-1.5 text-[12px] text-[var(--text-secondary)]">{project.desc}</p>}
        <div className="mt-3 flex gap-1">
          {(["tracks", "overview", "connections", "pipeline"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={cn("rounded-md px-2.5 py-1 text-[12px] font-medium capitalize transition", tab === t ? "bg-brand/15 text-brand" : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]")}>
              {t === "tracks" ? "Notes" : t}{t === "tracks" && data ? ` ${data.tracks.length}` : ""}{t === "connections" && data ? ` ${connTotal}` : ""}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {!data ? (
          <p className="flex items-center gap-2 text-[12px] text-[var(--text-secondary)]"><Loader2 className="size-4 animate-spin" /> Opening the project…</p>
        ) : tab === "overview" ? (
          <DocView path={data.overview || `03 Projects/${project.name}/CLAUDE.md`} emptyLabel="This project has no overview note yet." />
        ) : tab === "connections" ? (
          connTotal === 0 ? <p className="text-[12px] text-[var(--text-secondary)]">No linked notes yet. Wikilinks in this project&apos;s notes will surface here.</p> : (
            <div className="space-y-5">
              {CONN_GROUPS.map((g) => {
                const items = data.connections[g.key] ?? [];
                if (!items.length) return null;
                return (
                  <div key={g.key}>
                    <div className="mb-1.5 flex items-center gap-2 text-[14px] font-semibold"><g.icon className="size-4 text-brand" /> {g.label} <span className="text-[12px] font-normal tabular-nums text-[var(--text-secondary)]">{items.length}</span></div>
                    <div className="divide-y divide-border/60 overflow-hidden rounded-lg border">
                      {items.map((it: ConnItem) => <Row key={it.path} name={it.name} onClick={() => setDoc(it.path)} />)}
                    </div>
                  </div>
                );
              })}
            </div>
          )
        ) : tab === "pipeline" ? (
          <PipelineBoard projectId={project.name} />
        ) : (
          data.tracks.length === 0 ? <p className="text-[12px] text-[var(--text-secondary)]">{t('No tracks (notes) in this project yet.')}</p> : (
            <div className="divide-y divide-border/60 overflow-hidden rounded-lg border">
              {data.tracks.map((t) => <Row key={t.path} name={t.name} icon={<GitBranch className="size-4 shrink-0 text-[var(--text-secondary)]" />} onClick={() => setDoc(t.path)} />)}
            </div>
          )
        )}
      </div>

      <Sheet open={!!doc} onOpenChange={(o) => !o && setDoc(null)}>
        <SheetContent side="right" className="flex w-[92vw] flex-col gap-0 p-0 data-[side=right]:sm:max-w-2xl">
          {doc && <div className="flex h-full flex-col"><div className="flex-1 overflow-y-auto px-5 py-4"><DocView path={doc} /></div></div>}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function Row({ name, onClick, icon }: { name: string; onClick: () => void; icon?: React.ReactNode }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[12px] transition hover:bg-muted/40">
      {icon}
      <span className="flex-1 truncate">{name}</span>
      <Badge variant="secondary" className="shrink-0 text-[11px]">open</Badge>
    </button>
  );
}
