---
name: Ingest
description: Add outside content into DUIN's brain — files, PDFs, notes, web pages, or a connected source (Slack, Gmail, Calendar, Notion, RSS, Feishu) — so it becomes searchable and part of the knowledge graph. Use when the user wants to "add", "import", "ingest", "pull in", or "connect" something.
---
DUIN answers from what's in your brain. Ingesting is how new material gets in. Pick the path that matches what the user has:

## 1. Files already on disk (PDF, Markdown, text, docx)
- Drop them into the vault folder (the Markdown folder DUIN owns) — DUIN indexes them on the next scan.
- Or use the **Library** drop-zone in the app to import copies; PDFs are parsed to text automatically.
- Large PDFs ingest in the background; progress shows on the Library card.

## 2. A web page or article
- Paste the URL into the Library / capture surface. DUIN fetches, extracts the readable text, and files it as a note.
- Prefer this over pasting raw HTML — the extractor strips nav/ads so retrieval stays clean.

## 3. A running source (Slack, Gmail, Calendar, Notion, RSS, Feishu)
- Open **Settings → Connections**, connect the source inline (paste a token / sign in / add feeds), then enable it.
- Each enabled source pulls on a schedule; run a manual pull to backfill immediately.
- Connections add *new* items over time — they don't re-import history unless you trigger a pull.

## 4. A quick note or paste
- Just write it into a note. Anything in the vault is ingested — no special step.

## After ingesting
- Ingested text is chunked and embedded, so **semantic + keyword search** find it right away.
- The **knowledge graph** (people, projects, decisions and how they connect) is built by an AI model. If no model is connected, content is still searchable but the graph won't extend — connect a model to grow it.
- If something you just added isn't showing up, trigger a **reindex** and confirm the file is inside the vault folder DUIN owns.

Keep everything local: ingested content stays as plain files on the machine. Never paste secrets or credentials into a note expecting them to be private from the graph — treat the brain as readable content.
