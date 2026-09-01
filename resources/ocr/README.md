# OCR language data (Tier 1 — image files)

DUIN's image OCR (`electron/services/rag/loaders/ocr.ts`) uses
[tesseract.js](https://github.com/naptha/tesseract.js) (Apache-2.0, in-process
WASM — no sidecar) to turn screenshots / scans / photos of text into searchable
text at ingest time.

The feature is **flag-gated and default-OFF**. It only runs when the environment
variable `DUIN_OCR` is set to `1` / `true` / `on` / `yes`. When off, image files
are not ingestable and no OCR worker or language data is ever loaded.

## Why this directory exists

tesseract.js by default fetches its `.traineddata` language models from the
jsdelivr CDN at runtime. DUIN is **local-first / offline**, so `ocr.ts` overrides
tesseract.js's `langPath` to point at a **bundled local directory** instead:

```
tessdata/
  eng.traineddata
  chi_sim.traineddata
  jpn.traineddata
```

At runtime `resolveTessdataDir()` looks for that directory in this order:

1. `$DUIN_OCR_TESSDATA` — explicit override path (handy for dev / testing).
2. `process.resourcesPath/ocr/tessdata` — the packaged app location
   (`electron-builder.yml` copies `resources/ocr/tessdata` → `ocr/tessdata`).
3. `resources/ocr/tessdata` resolved relative to the source tree — dev runs.

If none exists (or a requested language's file is missing), OCR degrades to
**empty text** — best-effort, never an error.

## The model files are NOT committed to this repo

The `.traineddata` files are multi-MB binaries and are intentionally **not**
checked in. You must drop them into `resources/ocr/tessdata/` before a release
build (or point `$DUIN_OCR_TESSDATA` at a directory that contains them).

### Which files, and where to get them

Default language set: `eng+chi_sim+jpn` (screenshots for this ICP are often CJK).

Download the LSTM models from the official Tesseract data repos (Apache-2.0):

- **tessdata_fast** (recommended — smallest, LSTM-only, matches the `OEM.LSTM_ONLY`
  the loader requests): https://github.com/tesseract-ocr/tessdata_fast
- tessdata_best (larger, higher accuracy): https://github.com/tesseract-ocr/tessdata_best

Grab these three files and place them here:

| Language           | File                 |
| ------------------ | -------------------- |
| English            | `eng.traineddata`    |
| Simplified Chinese | `chi_sim.traineddata`|
| Japanese           | `jpn.traineddata`    |

Files must be named plain `<lang>.traineddata` (the loader sets `gzip: false`).
Gzipped content is still accepted — tesseract.js auto-detects the gzip magic
bytes and gunzips — but keep the `.traineddata` filename (no `.gz` suffix).

To add another language, drop its `<lang>.traineddata` here and pass the language
string via `ocrImage(input, { langs: 'eng+deu' })` (or extend `DEFAULT_LANGS`).

## Licensing

- tesseract.js — Apache-2.0.
- Tesseract `.traineddata` models (tessdata_fast / tessdata_best) — Apache-2.0.
