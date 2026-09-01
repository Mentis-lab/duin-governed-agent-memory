"use client";

import { t } from '@/lib/i18n'
// Pipeline board, scoped to a project. A project's deals/tracks move across stages (dnd-kit).
// Board state persists per-project in localStorage. Pipelines are no longer a free-floating tab —
// every pipeline belongs to a specific project (the restructure: pipelines run a project's specifics).

import { useEffect, useState } from "react";
import {
  DndContext, DragOverlay, PointerSensor, closestCorners, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragOverEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Plus } from "lucide-react";

type Deal = { id: string; name: string };
type Board = Record<string, Deal[]>;

const COLS = ["Backlog", "Contacted", "In diligence", "Closed"] as const;
const emptyBoard = (): Board => ({ Backlog: [], Contacted: [], "In diligence": [], Closed: [] });

function load(projectId: string): Board {
  if (typeof window === "undefined") return emptyBoard();
  try {
    const raw = window.localStorage.getItem(`pipeline:${projectId}`);
    if (raw) return { ...emptyBoard(), ...(JSON.parse(raw) as Board) };
  } catch { /* ignore */ }
  return emptyBoard();
}

function colOf(board: Board, id: string): string | undefined {
  if (id in board) return id;
  return COLS.find((c) => board[c].some((d) => d.id === id));
}

function DealCard({ deal, overlay }: { deal: Deal; overlay?: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: deal.id });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} {...attributes} {...listeners}
      className={"flex items-center gap-2 rounded-md border border-border/60 border-l-2 border-l-brand/70 bg-card px-3 py-2 text-[16px] cursor-grab shadow-sm transition active:cursor-grabbing "
        + (isDragging ? "opacity-40 " : "") + (overlay ? "shadow-lg ring-1 ring-brand/40" : "")}>
      <GripVertical className="size-3.5 shrink-0 text-[var(--text-muted)]" />
      <span className="truncate">{deal.name}</span>
    </div>
  );
}

function Column({ id, deals }: { id: string; deals: Deal[] }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div className="flex flex-col rounded-lg border border-border/60 bg-card/40">
      <div className="flex items-center justify-between border-b border-border/60 px-3 py-2 text-[12px] font-medium text-[var(--text-secondary)]">
        <span>{id}</span>
        <span className="tabular-nums">{deals.length}</span>
      </div>
      <SortableContext items={deals.map((d) => d.id)} strategy={verticalListSortingStrategy}>
        <div ref={setNodeRef} className={"flex min-h-28 flex-1 flex-col gap-2 p-2 transition " + (isOver ? "bg-brand/5" : "")}>
          {deals.length === 0 && <p className="px-1 py-4 text-center text-[12px] text-[var(--text-muted)]">drop here</p>}
          {deals.map((d) => <DealCard key={d.id} deal={d} />)}
        </div>
      </SortableContext>
    </div>
  );
}

export function PipelineBoard({ projectId }: { projectId: string }) {
  const [board, setBoard] = useState<Board>(emptyBoard);
  const [active, setActive] = useState<Deal | null>(null);
  const [draft, setDraft] = useState("");
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  useEffect(() => { setBoard(load(projectId)); }, [projectId]);
  useEffect(() => {
    if (typeof window !== "undefined") window.localStorage.setItem(`pipeline:${projectId}`, JSON.stringify(board));
  }, [board, projectId]);

  function addDeal() {
    const name = draft.trim();
    if (!name) return;
    setBoard((b) => ({ ...b, Backlog: [{ id: crypto.randomUUID(), name }, ...b.Backlog] }));
    setDraft("");
  }

  function onDragStart(e: DragStartEvent) {
    const c = colOf(board, String(e.active.id));
    setActive(c ? board[c].find((d) => d.id === e.active.id) ?? null : null);
  }
  function onDragOver(e: DragOverEvent) {
    const { active, over } = e;
    if (!over) return;
    const from = colOf(board, String(active.id));
    const to = colOf(board, String(over.id));
    if (!from || !to || from === to) return;
    setBoard((prev) => {
      const fromItems = [...prev[from]]; const toItems = [...prev[to]];
      const idx = fromItems.findIndex((d) => d.id === active.id);
      if (idx < 0) return prev;
      const [moved] = fromItems.splice(idx, 1);
      const overIdx = toItems.findIndex((d) => d.id === over.id);
      toItems.splice(overIdx < 0 ? toItems.length : overIdx, 0, moved);
      return { ...prev, [from]: fromItems, [to]: toItems };
    });
  }
  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    setActive(null);
    if (!over) return;
    const from = colOf(board, String(active.id));
    const to = colOf(board, String(over.id));
    if (from && to && from === to) {
      const items = board[from];
      const oldI = items.findIndex((d) => d.id === active.id);
      const newI = items.findIndex((d) => d.id === over.id);
      if (oldI !== newI && newI >= 0) setBoard((prev) => ({ ...prev, [from]: arrayMove(prev[from], oldI, newI) }));
    }
  }

  return (
    <div>
      <form onSubmit={(e) => { e.preventDefault(); addDeal(); }} className="mb-3 flex items-center gap-2">
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t('Add a deal / track to this project…')}
          className="w-72 rounded-md border bg-background px-2.5 py-1.5 text-[16px] outline-none focus:border-brand/40" />
        <button type="submit" disabled={!draft.trim()} className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-[16px] text-[var(--text-secondary)] transition hover:text-[var(--text-primary)] disabled:opacity-50">
          <Plus className="size-3.5" /> {t('Add')}
        </button>
      </form>
      <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd}>
        <div className="grid grid-cols-2 items-start gap-3 lg:grid-cols-4">
          {COLS.map((c) => <Column key={c} id={c} deals={board[c]} />)}
        </div>
        <DragOverlay>{active ? <DealCard deal={active} overlay /> : null}</DragOverlay>
      </DndContext>
    </div>
  );
}
