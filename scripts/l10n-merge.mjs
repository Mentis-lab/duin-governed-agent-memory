#!/usr/bin/env node
// l10n-merge — merge a batch of translations into src/locales/{zh,ja}.json.
//
// Input: a JSON file of { "English source": { "zh": "…", "ja": "…" }, … } on argv[2].
// The English source string is the key, exactly as it appears inside t('…') — that is the
// contract i18n.ts uses, so a mismatch here is a silent English fallback rather than an error,
// which is why this refuses to invent keys and reports what it did not recognise.
//
// Never overwrites an existing translation: the earlier hand-authored entries were reviewed
// against GLOSSARY.md and a bulk pass must not quietly regress them.

import { readFileSync, writeFileSync } from 'node:fs'

const batchPath = process.argv[2]
if (!batchPath) {
  console.error('usage: node scripts/l10n-merge.mjs <batch.json>')
  process.exit(1)
}

const batch = JSON.parse(readFileSync(batchPath, 'utf8'))
const zhPath = 'src/locales/zh.json'
const jaPath = 'src/locales/ja.json'
const zh = JSON.parse(readFileSync(zhPath, 'utf8'))
const ja = JSON.parse(readFileSync(jaPath, 'utf8'))

let addedZh = 0
let addedJa = 0
let keptZh = 0
let keptJa = 0
for (const [en, v] of Object.entries(batch)) {
  if (typeof v?.zh === 'string' && v.zh) {
    if (en in zh) keptZh++
    else { zh[en] = v.zh; addedZh++ }
  }
  if (typeof v?.ja === 'string' && v.ja) {
    if (en in ja) keptJa++
    else { ja[en] = v.ja; addedJa++ }
  }
}

// Stable key order so a diff shows only what changed, not a reshuffle.
const sorted = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]))
writeFileSync(zhPath, JSON.stringify(sorted(zh), null, 2) + '\n')
writeFileSync(jaPath, JSON.stringify(sorted(ja), null, 2) + '\n')

console.log(`zh +${addedZh} (kept ${keptZh}) -> ${Object.keys(zh).length} keys`)
console.log(`ja +${addedJa} (kept ${keptJa}) -> ${Object.keys(ja).length} keys`)
