# OCR models (Tier 2 — PaddleOCR PP-OCRv5, local / in-process)

DUIN's Tier-2 OCR engine (`electron/services/rag/ocr/`) runs
[PaddleOCR **PP-OCRv5**](https://github.com/PaddlePaddle/PaddleOCR) **in-process**
on DUIN's existing `onnxruntime-node` (via the `@huggingface/transformers`
dependency closure) — no Python, no cloud, no sidecar. It is best-in-class for
CJK and drives the scanned-document path.

The feature is **flag-gated**. It only runs when **both**:

- `DUIN_OCR` = `1` / `true` / `on` / `yes` (the master OCR flag), and
- `DUIN_OCR_ENGINE` = `paddle` (the engine selector; default `tesseract`).

When the engine is `tesseract` (default) the Tier-1 behavior is byte-identical to
today and nothing in this directory is loaded.

## Why this directory exists

The PP-OCR ONNX models are read from a **bundled local directory** so recognition
is fully **offline** (no runtime download). At runtime `resolvePaddleModels()`
(`electron/services/rag/ocr/paddle-catalog.ts`) looks for it in this order:

1. `$DUIN_OCR_PADDLE_MODELS` — explicit override path (handy for dev / testing).
2. `process.resourcesPath/ocr/models` — the packaged app location
   (`electron-builder.yml` copies `resources/ocr/models` → `ocr/models`).
3. `resources/ocr/models` resolved relative to the source tree — dev runs.

A directory qualifies only if it holds **a det `.onnx`, a rec `.onnx`, and a dict
`.txt`**. If none is found (or the models are missing) the paddle engine falls
back to tesseract — best-effort, never an error.

## The model files are NOT committed to this repo

The `.onnx` files are multi-MB binaries and are intentionally **not** checked in
(and are git-ignored). Drop them here before a release build (or point
`$DUIN_OCR_PADDLE_MODELS` at a directory that contains them).

### Which files, and where to get them

Bundle ≈ **21 MB** total. The loader matches files case-insensitively by the
canonical name first, then by a role substring (`det` / `rec` / `cls`), so exact
naming is tolerant — but these canonical names are recommended:

| Role                         | File                        | Approx size |
| ---------------------------- | --------------------------- | ----------- |
| Text **detection** (DB)      | `PP-OCRv5_mobile_det.onnx`  | ~4.6 MB     |
| Text **recognition** (CTC)   | `PP-OCRv5_mobile_rec.onnx`  | ~15.8 MB    |
| Orientation classifier (opt) | `PP-OCRv5_mobile_cls.onnx`  | ~1 MB       |
| Character **dictionary**     | `ppocrv5_dict.txt`          | 18,383 lines|

The `cls` orientation classifier is **optional** — the det + rec pipeline runs
without it. The dictionary has 18,383 entries; the rec head's CTC output has
`dict.length + 1` classes (class 0 is the CTC blank, not in the file).

Sources (all **Apache-2.0**):

- ONNX models: <https://huggingface.co/monkt/paddleocr-onnx>
- ONNX models + dict (alternative mirror): [RapidAI/RapidOCR](https://github.com/RapidAI/RapidOCR)
- `ppocrv5_dict.txt`: the PaddleOCR repo (`ppocr/utils/dict/ppocrv5_dict.txt`)
  or the RapidOCR resources.

## Licensing

- PaddleOCR PP-OCRv5 models + dictionary — **Apache-2.0**.
- `onnxruntime-node` — MIT (shipped via `@huggingface/transformers`).
- DB post-process + CTC decode logic (`paddle-db.ts`) — adapted / vendored from
  [paddleocr.js](https://github.com/X3ZvaWQ/paddleocr.js) (**MIT**, © X3ZvaWQ);
  see the file header and the repo `NOTICE`.
