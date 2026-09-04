/* global window, document */
// Bundle main.js against the repo's node_modules, wrap it with the dumped graph, render each
// scenario in headless Chrome (SwiftShader WebGL) and screenshot it next to the dump.
//
//   node scripts/brain-graph-preflight/run.cjs <live-graph.json> <scenario> [<scenario> ...]
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright-core')
const esbuild = require('esbuild') // a vite dependency, already in node_modules

const [dump, ...scenarios] = process.argv.slice(2)
if (!dump || scenarios.length === 0) { console.error('usage: run.cjs <live-graph.json> <scenario>...'); process.exit(2) }

const here = __dirname
const repo = path.resolve(here, '..', '..')
const outDir = path.dirname(path.resolve(dump))
const CHROME = process.env.PREFLIGHT_CHROME
  || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : 'google-chrome')

;(async () => {
  const bundle = path.join(outDir, 'preflight-bundle.js')
  esbuild.buildSync({ entryPoints: [path.join(here, 'main.js')], bundle: true, format: 'esm', platform: 'browser', outfile: bundle, logLevel: 'warning', absWorkingDir: repo })
  const graph = fs.readFileSync(dump, 'utf8')
  const html = `<!doctype html><html><head><meta charset=utf-8><style>html,body{margin:0;background:#07070d}#host{position:absolute;inset:0;width:1600px;height:1000px}</style></head><body><div id=host></div><script>window.__GRAPH=${graph}</script><script type=module src="preflight-bundle.js"></script></body></html>`
  const page_ = path.join(outDir, 'preflight.html')
  fs.writeFileSync(page_, html)

  // PREFLIGHT_GPU=1 runs new-headless Chrome on the real GPU (ANGLE/D3D11): the only way to judge
  // cosmos's own simulation at speed. Default is SwiftShader, which is enough for static looks.
  const gpu = process.env.PREFLIGHT_GPU === '1'
  const browser = await chromium.launch({ executablePath: CHROME, headless: !gpu,
    args: gpu
      ? ['--headless=new', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-webgl', '--allow-file-access-from-files', '--window-size=1600,1000']
      : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--allow-file-access-from-files', '--ignore-gpu-blocklist', '--enable-webgl'] })
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message))
  const url = 'file:///' + page_.replace(/\\/g, '/')
  await page.goto(url)
  console.log('webgl:', await page.evaluate(() => { const c = document.createElement('canvas'); const x = c.getContext('webgl2'); if (!x) return 'none'; const d = x.getExtension('WEBGL_debug_renderer_info'); return d ? x.getParameter(d.UNMASKED_RENDERER_WEBGL) : x.getParameter(x.RENDERER) }))
  for (const sc of scenarios) {
    await page.goto(url)
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 90000 })
    if (process.env.PREFLIGHT_DECAY) await page.evaluate((d) => { window.__decay = d }, process.env.PREFLIGHT_DECAY)
    const r = await page.evaluate((name) => window.__scenario(name), sc)
    await page.waitForTimeout(600)
    const shot = path.join(outDir, `h-${sc}.png`)
    await page.screenshot({ path: shot })
    console.log(sc, JSON.stringify(r), '->', shot)
  }
  await browser.close()
})().catch((e) => { console.error(e.message); process.exit(1) })
