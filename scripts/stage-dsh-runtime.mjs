#!/usr/bin/env node
// stage-dsh-runtime — install the pinned dsh executor runtime into resources/executors/dsh.
//
// The runtime's node_modules (≈63 MB, 176 packages, two prebuilt natives) is never committed;
// this stages it from the lockfile so dev, CI and electron-builder all ship the same bytes.
// Mirrors scripts/stage-models-for-release.mjs in role. Exit codes: 0 staged/verified,
// 1 something the executor needs is missing (named), 2 npm itself failed.
//
//   node scripts/stage-dsh-runtime.mjs            # npm ci (skips when already verified)
//   node scripts/stage-dsh-runtime.mjs --check    # verify only, never installs
//   node scripts/stage-dsh-runtime.mjs --force    # reinstall even if verified

import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = join(REPO, 'resources', 'executors', 'dsh')
const args = new Set(process.argv.slice(2))

/** What executor-runtime.ts probes at run time. Keep the two lists identical. */
export function requiredArtifacts(dir, platform = process.platform, arch = process.arch) {
  const nm = join(dir, 'node_modules')
  const list = [
    join(nm, '@deepseek-ai', 'dsh-sdk-jsonrpc-demo', 'lib', 'bin.js'),
    join(nm, '@deepseek-ai', 'dsh-sdk-jsonrpc-server', 'package.json'),
    join(nm, '@deepseek-ai', 'dsh-sandbox-local', 'package.json'),
    join(nm, 'duin-gate', 'index.mjs')
  ]
  if (platform === 'win32') {
    list.push(join(nm, '@koromix', `koffi-win32-${arch}`, `win32_${arch}`, 'koffi.node'))
    list.push(join(nm, 'node-pty', 'prebuilds', `win32-${arch}`, 'conpty.node'))
  } else {
    list.push(join(nm, 'node-pty', 'prebuilds', `${platform}-${arch}`, 'pty.node'))
  }
  return list
}

function missing(dir) {
  return requiredArtifacts(dir).filter((p) => !existsSync(p))
}

function report(dir) {
  const miss = missing(dir)
  if (miss.length === 0) {
    console.log(`[stage-dsh-runtime] verified: ${dir}`)
    return 0
  }
  console.error(`[stage-dsh-runtime] ${miss.length} artifact(s) missing under ${dir}:`)
  for (const m of miss) console.error(`  - ${m}`)
  return 1
}

function install(dir) {
  if (!existsSync(join(dir, 'package-lock.json'))) {
    console.error('[stage-dsh-runtime] package-lock.json is missing — the runtime set must be pinned by a lockfile')
    return 2
  }
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  console.log(`[stage-dsh-runtime] npm ci in ${dir}`)
  const r = spawnSync(npm, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: dir,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
  if (r.status !== 0) {
    console.error(`[stage-dsh-runtime] npm ci failed (exit ${r.status})`)
    return 2
  }
  return 0
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  if (args.has('--check')) process.exit(report(DIR))
  if (!args.has('--force') && missing(DIR).length === 0) {
    console.log(`[stage-dsh-runtime] already staged: ${DIR}`)
    process.exit(0)
  }
  const code = install(DIR)
  process.exit(code !== 0 ? code : report(DIR))
}
