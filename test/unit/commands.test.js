import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseSetting, runCommand } from '../../lib/commands.js'
import { DEFAULTS } from '../../lib/config.js'

/**
 * Minimal fake runtime: only the fields the exercised commands touch.
 * @param {{overrides?: Record<string, unknown>} } [options]
 */
function fakeRuntime(options = {}) {
  return {
    overrides: () => options.overrides ?? {},
    readLedger: () => [],
    recordProject: () => ({ label: 'test-project' }),
  }
}

/**
 * @param {Partial<Record<string, Function>>} overrides
 */
function fakeHooks(overrides = {}) {
  return {
    effectiveConfig: () => ({ ...DEFAULTS }),
    setOverride: () => true,
    unsetOverride: () => true,
    applyToolprune: async () => ({ applied: [] }),
    restoreToolprune: async () => ({ restored: [] }),
    refreshCatalog: async () => ({ tools: 0 }),
    resetProject: async () => true,
    forgetFact: () => false,
    ...overrides,
  }
}

test('microskills forget dispatches to the hook and reports the result', async () => {
  /** @type {string[]} */
  const forgotten = []
  const ok = await runCommand({
    runtime: /** @type {any} */ (fakeRuntime()),
    config: { ...DEFAULTS },
    dataDir: '/tmp/state',
    argv: ['microskills', 'forget', 'env:run_tests:python -m pytest'],
    hooks: fakeHooks({ forgetFact: (/** @type {string} */ id) => { forgotten.push(id); return true } }),
  })
  assert.equal(ok.kind, 'success')
  assert.match(ok.text, /forgot fact/)
  assert.deepEqual(forgotten, ['env:run_tests:python -m pytest'])
})

test('microskills forget rejects a missing id and reports unknown facts', async () => {
  const missing = await runCommand({
    runtime: /** @type {any} */ (fakeRuntime()),
    config: { ...DEFAULTS },
    dataDir: '/tmp/state',
    argv: ['microskills', 'forget'],
    hooks: fakeHooks(),
  })
  assert.equal(missing.kind, 'error')
  assert.match(missing.text, /needs a fact id/)

  const unknown = await runCommand({
    runtime: /** @type {any} */ (fakeRuntime()),
    config: { ...DEFAULTS },
    dataDir: '/tmp/state',
    argv: ['microskills', 'forget', 'nope'],
    hooks: fakeHooks(),
  })
  assert.equal(unknown.kind, 'error')
  assert.match(unknown.text, /no fact with id/)
})

test('reset requires explicit confirmation', async () => {
  const refused = await runCommand({
    runtime: /** @type {any} */ (fakeRuntime()),
    config: { ...DEFAULTS },
    dataDir: '/tmp/state',
    argv: ['reset'],
    hooks: fakeHooks(),
  })
  assert.equal(refused.kind, 'error')
  assert.match(refused.text, /--yes/)

  let called = false
  const done = await runCommand({
    runtime: /** @type {any} */ (fakeRuntime()),
    config: { ...DEFAULTS },
    dataDir: '/tmp/state',
    argv: ['reset', '--yes'],
    hooks: fakeHooks({ resetProject: async () => { called = true; return true } }),
  })
  assert.equal(called, true)
  assert.equal(done.kind, 'success')
})

test('config set validates mechanism modes and project-scoped values', () => {
  assert.deepEqual(parseSetting('toolprune', 'apply'), { value: 'apply' })
  assert.equal(parseSetting('toolprune', 'sudo'), undefined)
  assert.deepEqual(parseSetting('loopguard', 'off'), { value: 'off' })
  assert.deepEqual(parseSetting('microskills', 'on'), { value: 'on' })
  assert.deepEqual(parseSetting('microskillsMaxFacts', '6'), { value: 6 })
  assert.equal(parseSetting('microskillsMaxFacts', 'many'), undefined)
  assert.deepEqual(parseSetting('protectedTools', 'a, b'), { value: ['a', 'b'] })
  assert.equal(parseSetting('notASetting', '1'), undefined)
})

test('toolprune restore reports the restored tools', async () => {
  const result = await runCommand({
    runtime: /** @type {any} */ (fakeRuntime()),
    config: { ...DEFAULTS },
    dataDir: '/tmp/state',
    argv: ['toolprune', 'restore', 'fixture_drop'],
    hooks: fakeHooks({ restoreToolprune: async (/** @type {string[]} */ tools) => ({ restored: tools }) }),
  })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /restored fixture_drop/)
})
