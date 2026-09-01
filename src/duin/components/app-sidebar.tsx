"use client";

import {
  Brain, CalendarClock, Database, FolderKanban, Inbox, Lightbulb, ListTodo, MessageSquare, Plus, Scale,
  Settings2, ShieldAlert, Target, Users, Workflow, X,
} from "lucide-react";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent,
  SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem,
  SidebarRail,
} from "@/duin/components/ui/sidebar";
import { cn } from "@/duin/lib/utils";
import type { Conversation } from "@/duin/lib/conversations";
import { t, type Lang } from "@/duin/lib/i18n";

export type View =
  | "ask" | "decisions" | "strategy" | "tasks" | "meetings" | "projects" | "people" | "workflows" | "outputs" | "analytics" | "knowledge" | "settings";

// The brain workspace is home; Insight/Strategy/Actions/People/Projects are real surfaces you can
// reach from the sidebar (the graph lenses are a way to FOCUS the brain, not the only way in).
const NAV: { id: View; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "knowledge", label: "Brain", icon: Brain },
  { id: "decisions", label: "Insight", icon: Lightbulb },
  { id: "strategy", label: "Mental Models", icon: Target },
  { id: "tasks", label: "Active Work", icon: ListTodo },
  { id: "meetings", label: "Meetings", icon: CalendarClock },
  { id: "workflows", label: "Workflows", icon: Workflow },
  { id: "outputs", label: "Outputs", icon: Inbox },
  { id: "people", label: "People", icon: Users },
  { id: "projects", label: "Projects", icon: FolderKanban },
];
// Utilities — quiet, secondary.
const TOOLS: { id: View; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "analytics", label: "Data", icon: Database },
];

export function AppSidebar({
  view, chatOpen, unread, onSelect, onHome, conversations, activeConvId, onPickConversation, onNewChat, onDeleteConversation, lang,
}: {
  view: View;
  chatOpen?: boolean;
  unread?: Set<string>;
  onSelect: (v: View) => void;
  onHome: () => void;
  conversations: Conversation[];
  activeConvId: string;
  onPickConversation: (id: string) => void;
  onNewChat: () => void;
  onDeleteConversation: (id: string) => void;
  lang: Lang;
}) {
  return (
    <Sidebar>
      <SidebarHeader>
        <button onClick={onHome} title={t('Your second brain', lang)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition hover:bg-muted/50">
          <svg viewBox="20 10 72 80" className="size-7 shrink-0" role="img" aria-label="logo" fill="none">
            <defs>
              <clipPath id="duinHdrTop"><rect width="100" height="46" /></clipPath>
              <clipPath id="duinHdrBot"><rect y="46" width="100" height="54" /></clipPath>
            </defs>
            <path className="text-[var(--text-primary)]" fill="currentColor" fillRule="evenodd" clipPath="url(#duinHdrTop)" d="M28 16 H52 C72 16 84 28 84 50 C84 72 72 84 52 84 H28 Z M44 30 H51 C61 30 68 39 68 50 C68 61 61 70 51 70 H44 Z" />
            <path className="text-brand" fill="currentColor" fillRule="evenodd" clipPath="url(#duinHdrBot)" d="M28 16 H52 C72 16 84 28 84 50 C84 72 72 84 52 84 H28 Z M44 30 H51 C61 30 68 39 68 50 C68 61 61 70 51 70 H44 Z" />
          </svg>
          <div className="leading-tight">
            <div className="text-[16px] font-semibold tracking-tight">DUIN</div>
            <div className="text-[11px] text-[var(--text-secondary)]">your second brain</div>
          </div>
        </button>
      </SidebarHeader>

      <SidebarContent>
        {/* Conversing is primary — New chat + Recents lead. */}
        <SidebarGroup>
          <SidebarGroupContent>
            <button onClick={onNewChat}
              className="flex w-full items-center gap-2 rounded-md border border-border/60 bg-card px-2.5 py-2 text-[16px] font-medium transition hover:border-brand/40 hover:bg-muted/50">
              <Plus className="size-4" /> {t("New chat", lang)}
            </button>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* The surfaces. */}
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV.map((n) => (
                <SidebarMenuItem key={n.id}>
                  <SidebarMenuButton isActive={view === n.id} onClick={() => (n.id === "knowledge" ? onHome() : onSelect(n.id))} tooltip={n.label}>
                    <n.icon className="size-4" />
                    <span>{t(n.label, lang)}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>{t("Recent", lang)}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {conversations.length === 0 ? (
                <p className="px-2 py-1 text-[11px] text-[var(--text-secondary)]">{t('No conversations yet', lang)}</p>
              ) : (
                conversations.slice(0, 12).map((c) => (
                  <SidebarMenuItem key={c.id} className="group/conv relative">
                    <SidebarMenuButton
                      isActive={view === "knowledge" && chatOpen && activeConvId === c.id}
                      onClick={() => onPickConversation(c.id)}
                      className={cn("pr-7", view === "knowledge" && chatOpen && activeConvId === c.id ? "" : "text-[var(--text-secondary)]")}
                    >
                      {c.kind === "decision" ? <Scale className="size-4 text-brand" /> : c.kind === "problem" ? <ShieldAlert className="size-4 text-rose-400" /> : <MessageSquare className="size-4" />}
                      <span className="flex-1 truncate">{c.title}</span>
                      {unread?.has(c.id) && <span className="size-1.5 shrink-0 rounded-full bg-brand" title={t('New reply', lang)} aria-label={t('New reply', lang)} />}
                    </SidebarMenuButton>
                    <button onClick={(e) => { e.stopPropagation(); onDeleteConversation(c.id); }} title={t('Delete chat', lang)}
                      className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-[var(--text-secondary)] opacity-0 transition hover:text-destructive group-hover/conv:opacity-100">
                      <X className="size-3.5" />
                    </button>
                  </SidebarMenuItem>
                ))
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarGroupLabel className="px-2">{t("Tools", lang)}</SidebarGroupLabel>
        <SidebarMenu>
          {TOOLS.map((it) => (
            <SidebarMenuItem key={it.id}>
              <SidebarMenuButton size="sm" isActive={view === it.id} onClick={() => onSelect(it.id)} tooltip={it.label} className="text-[var(--text-secondary)]">
                <it.icon className="size-4" />
                <span>{t(it.label, lang)}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
          <SidebarMenuItem>
            <SidebarMenuButton size="sm" isActive={view === "settings"} onClick={() => onSelect("settings")} tooltip={t("Settings", lang)} className="text-[var(--text-secondary)]">
              <Settings2 className="size-4" />
              <span>{t("Settings", lang)}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
