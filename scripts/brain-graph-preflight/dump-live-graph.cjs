/* global window, document */
// Dump the LIVE brain map (nodes with kind/layer/label/degree/position/stamped color, links with
// endpoints/type/stamped color) from the running DUIN over CDP :9333. Read-only: it walks the React
// fiber above the cosmos canvas to reach the CosmosBrainCanvas props and serialises them.
//
//   node scripts/brain-graph-preflight/dump-live-graph.cjs <out.json>
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright-core')

const out = process.argv[2]
if (!out) { console.error('usage: dump-live-graph.cjs <out.json>'); process.exit(2) }

;(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333')
  const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('renderer/index.html'))
  if (!page) throw new Error('DUIN renderer page not found on :9333')
  const json = await page.evaluate(() => {
    const canvas = document.querySelector('canvas')
    let el = canvas, fiber = null
    for (let k = 0; k < 4 && el && !fiber; k++) {
      const key = Object.keys(el).find((x) => x.startsWith('__reactFiber$'))
      if (key) fiber = el[key]; else el = el.parentElement
    }
    let f = fiber, props = null, d = 0
    while (f && !props && d < 40) {
      const p = f.memoizedProps
      if (p && Array.isArray(p.nodes) && Array.isArray(p.links) && 'coreMarkUrl' in p) props = p
      f = f.return; d++
    }
    if (!props) throw new Error('CosmosBrainCanvas props not found: is the brain map open?')
    const nodes = props.nodes.map((n) => ({ id: n.id, kind: n.kind, layer: n.layer, label: n.label, deg: n.deg,
      x: typeof n.x === 'number' ? n.x : (n.fx ?? 0), y: typeof n.y === 'number' ? n.y : (n.fy ?? 0), c: n.__color }))
    const links = props.links.map((l) => ({ s: l.source && typeof l.source === 'object' ? l.source.id : l.source,
      t: l.target && typeof l.target === 'object' ? l.target.id : l.target, type: l.type, c: l.__color }))
    return JSON.stringify({ nodes, links, lockId: props.lockId, isLight: props.isLight })
  })
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
  fs.writeFileSync(out, json)
  console.log(`wrote ${out} (${json.length} bytes)`)
  await browser.close()
})().catch((e) => { console.error(e.message); process.exit(1) })
