import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isDeniedModule, normalizeModuleId, assertAllowedModule } from './sandbox-guard.mjs'

test('blocks host-access built-ins (the documented bypass)', () => {
  for (const id of ['child_process', 'fs', 'fs/promises', 'net', 'http', 'https', 'dns']) {
    assert.equal(isDeniedModule(id), true, `${id} should be denied`)
  }
})

test('blocks VM-escape vectors', () => {
  for (const id of ['vm', 'module', 'worker_threads', 'process', 'inspector', 'cluster']) {
    assert.equal(isDeniedModule(id), true, `${id} should be denied`)
  }
})

test('node: scheme is normalized and still denied', () => {
  assert.equal(normalizeModuleId('node:child_process'), 'child_process')
  assert.equal(isDeniedModule('node:fs'), true)
  assert.equal(isDeniedModule('node:child_process'), true)
})

test('allows pure compute / safe built-ins and user packages', () => {
  for (const id of ['path', 'crypto', 'util', 'url', 'string_decoder', 'assert', 'lodash', './local-helper']) {
    assert.equal(isDeniedModule(id), false, `${id} should be allowed`)
  }
})

test('assertAllowedModule throws ERR_SANDBOX_DENIED for denied, returns id for allowed', () => {
  assert.throws(() => assertAllowedModule('child_process'), (e) => e.code === 'ERR_SANDBOX_DENIED')
  assert.equal(assertAllowedModule('path'), 'path')
})

test('non-string / empty ids do not crash and are not denied', () => {
  assert.equal(isDeniedModule(undefined), false)
  assert.equal(isDeniedModule(null), false)
  assert.equal(isDeniedModule(''), false)
})
