// Per-folder colors for the knowledge graph, editable in Settings (persisted in localStorage).
// Defaults come from a curated palette (hex, so they work in <input type=color> and on canvas).

const KEY = "duin:graphColors";
const PALETTE = [
  "#8b7cf6", "#60a5fa", "#34d399", "#fbbf24", "#f87171", "#f472b6", "#22d3ee", "#a78bfa",
  "#4ade80", "#fb923c", "#e879f9", "#2dd4bf", "#facc15", "#38bdf8", "#c084fc", "#fca5a5",
];

export function defaultColor(folder: string, palette: string[] = PALETTE): string {
  const pal = palette && palette.length ? palette : PALETTE;
  let h = 0;
  for (let i = 0; i < folder.length; i++) h = (h * 31 + folder.charCodeAt(i)) >>> 0;
  return pal[h % pal.length];
}

export function getGraphColors(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try { return JSON.parse(window.localStorage.getItem(KEY) || "{}") as Record<string, string>; } catch { return {}; }
}

export function setGraphColor(folder: string, color: string) {
  const c = getGraphColors();
  if (color) c[folder] = color; else delete c[folder];
  if (typeof window !== "undefined") window.localStorage.setItem(KEY, JSON.stringify(c));
}

export function resolveColor(
  folder: string,
  overrides: Record<string, string>,
  palette?: string[]
): string {
  return overrides[folder] || defaultColor(folder, palette);
}
