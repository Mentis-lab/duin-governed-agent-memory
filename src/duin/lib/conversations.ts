// Local conversation history for the Ask chat — so Recents is real (each entry restores its own
// thread + messages), not a list of links to one blank screen. Client-side (localStorage); the
// brain keeps the matching Claude session keyed by the same conversation id.

export type ConvMsg = { id: string; role: "user" | "assistant"; content: string };
export type ConvKind = "ask" | "decision" | "problem";
export type Conversation = { id: string; title: string; updated: number; messages: ConvMsg[]; kind: ConvKind; refId?: string };

const KEY = "agui:conversations";
const MAX = 40;

function read(): Conversation[] {
  if (typeof window === "undefined") return [];
  try { return JSON.parse(window.localStorage.getItem(KEY) || "[]") as Conversation[]; } catch { return []; }
}
function write(list: Conversation[]) {
  if (typeof window !== "undefined") window.localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
}

export function listConversations(): Conversation[] {
  return read().sort((a, b) => b.updated - a.updated);
}
export function getConversation(id: string): Conversation | undefined {
  return read().find((c) => c.id === id);
}
export function saveConversation(id: string, messages: ConvMsg[], meta?: { kind?: ConvKind; refId?: string; title?: string }) {
  if (!messages.length) return;
  const prior = read().find((c) => c.id === id);
  const list = read().filter((c) => c.id !== id);
  const title = meta?.title ?? prior?.title ?? (messages.find((m) => m.role === "user")?.content || "New chat").trim().slice(0, 64);
  list.push({ id, title, updated: Date.now(), messages, kind: meta?.kind ?? prior?.kind ?? "ask", refId: meta?.refId ?? prior?.refId });
  write(list.sort((a, b) => b.updated - a.updated));
}
export function deleteConversation(id: string) {
  write(read().filter((c) => c.id !== id));
}
export function newConversationId(): string {
  return "conv-" + Math.random().toString(36).slice(2, 10);
}
