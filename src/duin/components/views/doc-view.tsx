"use client";

import { t } from '@/lib/i18n'
// DocView — the original markdown behind any surface (decision, person, project). Renders cleanly
// (frontmatter as metadata chips, body as markdown), makes Obsidian [[wikilinks]] clickable (they
// resolve + navigate within the panel, with Back), and is editable (save writes back to the vault).

import { useCallback, useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { ArrowLeft, Check, FileText, Loader2, Pencil, X } from "lucide-react";
import { fetchDoc, resolveWiki, saveDoc } from "@/duin/lib/state";

function splitFrontmatter(md: string): { fm: [string, string][]; body: string } {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fm: [], body: md };
  const fm: [string, string][] = [];
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) {
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (k && !k.startsWith("-")) fm.push([k, v]);
    }
  }
  return { fm, body: m[2] };
}

// [[Target]] / [[Target|Alias]] / [[Target#heading]] → an https sentinel link the panel intercepts.
// Streamdown's sanitizer only keeps http/https/mailto/tel hrefs, so we ride https with a fake host.
const WIKI = "https://wikilink.local/";
function wikiToMd(body: string): string {
  return body.replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g,
    (_m, t: string, alias: string) => `[${(alias || t).trim()}](${WIKI}${encodeURIComponent(t.trim())})`);
}

export function DocView({ path, emptyLabel = "No source note for this item yet." }: { path: string; emptyLabel?: string }) {
  const [stack, setStack] = useState<string[]>([path]);
  const cur = stack[stack.length - 1];
  const [content, setContent] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => { setStack([path]); }, [path]); // host opened a different item

  useEffect(() => {
    setContent(null); setErr(null); setEditing(false);
    const c = new AbortController();
    fetchDoc(cur, c.signal).then(setContent).catch((e) => setErr(String(e?.message ?? e)));
    return () => c.abort();
  }, [cur]);

  const onClick = useCallback(async (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest(`a[href^="${WIKI}"]`) as HTMLAnchorElement | null;
    if (!a) return;
    e.preventDefault();
    const name = decodeURIComponent(a.getAttribute("href")!.slice(WIKI.length));
    const p = await resolveWiki(name);
    if (p) setStack((s) => [...s, p]);
    else setErr(`No note found for [[${name}]]`);
  }, []);

  async function save() {
    setSaving(true);
    try { await saveDoc(cur, draft); setContent(draft); setEditing(false); setErr(null); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  }

  const { fm, body } = content ? splitFrontmatter(content) : { fm: [], body: "" };

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        {stack.length > 1 && (
          <button onClick={() => setStack((s) => s.slice(0, -1))} className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[12px] text-[var(--text-secondary)] transition hover:text-[var(--text-primary)]">
            <ArrowLeft className="size-3.5" /> {t('Back')}
          </button>
        )}
        <span className="flex-1 truncate font-mono text-[11px] text-[var(--text-secondary)]">{cur.split("/").pop()}</span>
        {content !== null && !editing && (
          <button onClick={() => { setDraft(content); setEditing(true); }} className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[12px] text-[var(--text-secondary)] transition hover:text-[var(--text-primary)]">
            <Pencil className="size-3.5" /> {t('Edit')}
          </button>
        )}
        {editing && (
          <>
            <button onClick={() => { setEditing(false); setErr(null); }} className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[12px] text-[var(--text-secondary)] transition hover:text-[var(--text-primary)]"><X className="size-3.5" /> {t('Cancel')}</button>
            <button onClick={save} disabled={saving} className="inline-flex items-center gap-1 rounded-md bg-brand px-2.5 py-1 text-[12px] font-medium text-white transition hover:opacity-90 disabled:opacity-50">
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Save
            </button>
          </>
        )}
      </div>

      {err && content !== null && <p className="mb-2 text-[12px] text-destructive">⚠️ {err}</p>}

      {err && content === null ? (
        <p className="flex items-center gap-2 px-1 py-6 text-[14px] text-[var(--text-secondary)]"><FileText className="size-4" /> {emptyLabel}</p>
      ) : content === null ? (
        <p className="flex items-center gap-2 px-1 py-6 text-[14px] text-[var(--text-secondary)]"><Loader2 className="size-4 animate-spin" /> Opening the note…</p>
      ) : editing ? (
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false}
          className="h-[62vh] w-full resize-none rounded-lg border bg-background p-3 font-mono text-[12px] leading-6 outline-none focus:border-brand/40" />
      ) : (
        <div>
          {fm.length > 0 && (
            <div className="mb-4 flex flex-wrap gap-1.5 rounded-lg border border-border/60 bg-card/40 p-3">
              {fm.map(([k, v]) => (
                <span key={k} className="inline-flex items-center gap-1.5 rounded-md bg-muted/50 px-2 py-0.5 text-[11px]">
                  <span className="text-[var(--text-secondary)]">{k}</span>
                  {v && <span className="font-medium">{v.replace(/^["[]+|["\]]+$/g, "")}</span>}
                </span>
              ))}
            </div>
          )}
          <div ref={ref} onClick={onClick}
            className="text-[14px] leading-7 [&_a]:cursor-pointer [&_a]:text-brand [&_a]:underline-offset-2 hover:[&_a]:underline [&_h1]:mt-0 [&_h1]:mb-2 [&_h1]:text-[26px] [&_h1]:font-semibold [&_h2]:mt-5 [&_h2]:mb-1.5 [&_h2]:text-[20px] [&_h2]:font-semibold [&_table]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-brand/40 [&_blockquote]:pl-3 [&_blockquote]:text-[var(--text-secondary)] [&_ul]:my-1.5 [&_li]:my-0.5">
            <Streamdown>{wikiToMd(body)}</Streamdown>
          </div>
          <p className="mt-6 border-t border-border/60 pt-2 font-mono text-[11px] text-[var(--text-secondary)]">{cur}</p>
        </div>
      )}
    </div>
  );
}
