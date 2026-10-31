import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createState, foldSession } from '../../../lib/toolprune/evidence.js'
import {
  appliedFor,
  computeDenyList,
  isDenied,
  keptFor,
  mergeProtectedTools,
} from '../../../lib/toolprune/denylist.js'
import { holdProposal, markApplied } from '../../../lib/toolprune/policy.js'

/**
 * @returns {ReturnType<typeof createState>}
 */
function appliedState() {
  const catalog = { tools: ['Task', 'Notebook'], descriptions: {}, source: 'test' }
  let state = createState()
  for (let i = 0; i < 5; i += 1) {
    state = foldSession(state, { catalog, prompts: 2 }, { now: 1000 + i })
  }
  state = holdProposal(state, { mode: 'apply', now: 2000 })
  return markApplied(state, { items: state.auto_pending?.items ?? [], now: 3000 })
}

test('the deny list is derived from the plugin-applied set, sorted', () => {
  const deny = computeDenyList(appliedState())
  assert.deepEqual(deny.deny, ['Notebook', 'Task'])
  assert.deepEqual(deny.kept, [])
  assert.deepEqual(deny.skippedProtected, [])
})

test('protected tools are force-kept: they never appear in the deny list', () => {
  const state = createState({ applied: ['Task', 'read', 'bash'] })
  const deny = computeDenyList(state)
  assert.deepEqual(deny.deny, ['Task'])
  assert.deepEqual(deny.skippedProtected, ['bash', 'read'])
})

test('a configured protected list also keeps tools out of the deny list', () => {
  const state = createState({ applied: ['my_mcp_tool', 'Task'] })
  const deny = computeDenyList(state, { protectedTools: ['my_mcp_tool'] })
  assert.deepEqual(deny.deny, ['Task'])
  assert.deepEqual(deny.skippedProtected, ['my_mcp_tool'])
})

test('applied_for / kept_for preserve the upstream semantics', () => {
  // The persisted document normalizes arrays to sorted order, so the accessors
  // report the same set a host writer would derive from its own rules.
  const state = createState({ applied: ['b', 'a'], kept: ['z'] })
  assert.deepEqual(appliedFor(state), ['a', 'b'])
  assert.deepEqual(keptFor(state), ['z'])
})

test('isDenied honours protection and only returns the plugin’s own entries', () => {
  const state = createState({ applied: ['Task', 'read'] })
  assert.equal(isDenied('Task', state), true)
  assert.equal(isDenied('read', state), false, 'protected')
  assert.equal(isDenied('Other', state), false)
  assert.equal(isDenied('', state), false)
  assert.equal(isDenied('Task', state, { protectedTools: ['Task'] }), false)
})

test('mergeProtectedTools is the sorted union of defaults and configuration', () => {
  const merged = mergeProtectedTools(['zzz', 'read'])
  assert.deepEqual(merged, [...new Set(merged)].sort())
  assert.ok(merged.includes('bash'))
  assert.ok(merged.includes('zzz'))
  assert.equal(merged.filter((name) => name === 'read').length, 1)
})
