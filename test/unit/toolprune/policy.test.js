import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createState, foldSession } from '../../../lib/toolprune/evidence.js'
import {
  givenBack,
  holdProposal,
  markApplied,
  markRefused,
  pendingItems,
  restoreProtectedTools,
  restoreTools,
  shouldApply,
} from '../../../lib/toolprune/policy.js'

/**
 * @param {string} tool
 * @param {number} [sessions]
 * @returns {ReturnType<typeof createState>}
 */
function proposingState(tool = 'Task', sessions = 2) {
  let state = createState()
  const catalog = { tools: [tool], descriptions: {}, source: 'test' }
  for (let i = 0; i < sessions; i += 1) {
    state = foldSession(state, { catalog, prompts: 5 }, { now: 1000 + i })
  }
  return state
}

test('apply mode holds the proposal with the given root and time', () => {
  const state = holdProposal(proposingState(), { mode: 'apply', now: 2000, root: '/repo' })
  assert.deepEqual(state.proposal, ['Task'])
  assert.deepEqual(state.auto_pending, { items: ['Task'], root: '/repo', since: 2000 })
  assert.deepEqual(state.applied, [], 'holding never applies')
})

test('holding preserves the original since across repeated folds', () => {
  let state = holdProposal(proposingState(), { mode: 'apply', now: 2000, root: '/repo' })
  state = holdProposal(state, { mode: 'apply', now: 5000, root: '/repo' })
  assert.equal(state.auto_pending?.since, 2000)
})

test('propose mode keeps a proposal visible and never holds or applies it', () => {
  const state = holdProposal(proposingState(), { mode: 'propose', now: 2000 })
  assert.deepEqual(state.proposal, ['Task'])
  assert.equal(state.auto_pending, null)
  assert.deepEqual(state.applied, [])
})

test('switching from apply back to propose drops a pending list (upstream :744)', () => {
  let state = holdProposal(proposingState(), { mode: 'apply', now: 2000 })
  assert.ok(state.auto_pending)
  state = holdProposal(state, { mode: 'propose', now: 3000 })
  assert.equal(state.auto_pending, null)
  assert.deepEqual(state.applied, [], 'propose never mutates the applied list')
})

test('an empty proposal clears a stale pending list', () => {
  let state = holdProposal(createState({ proposal: ['Task'] }), { mode: 'apply', now: 2000 })
  assert.ok(state.auto_pending)
  state = holdProposal(createState({ auto_pending: state.auto_pending }), { mode: 'apply', now: 3000 })
  assert.equal(state.auto_pending, null)
})

test('the quiet period waits while sessions are still active', () => {
  const state = holdProposal(proposingState(), { mode: 'apply', now: 1000, root: '/repo' })
  const decision = shouldApply(state, {
    now: 2000,
    lastActivity: 1900,
    quietMinutes: 60,
  })
  assert.equal(decision.apply, false)
  assert.equal(decision.reason, 'waiting')
  assert.equal(decision.waitSeconds, 3500, '60 min quiet - 100 s idle')
})

test('the quiet period applies once every session has been idle for q minutes', () => {
  const state = holdProposal(proposingState(), { mode: 'apply', now: 1000 })
  const decision = shouldApply(state, {
    now: 100_000,
    lastActivity: 100_000 - 3601,
    quietMinutes: 60,
  })
  assert.equal(decision.apply, true)
  assert.equal(decision.reason, 'idle')
  assert.deepEqual(decision.items, ['Task'])
})

test('quietMinutes=0 applies immediately', () => {
  const state = holdProposal(proposingState(), { mode: 'apply', now: 1000 })
  const decision = shouldApply(state, { now: 1000, lastActivity: 1000, quietMinutes: 0 })
  assert.equal(decision.apply, true)
  assert.equal(decision.reason, 'idle')
})

test('a pending list older than 24 h is applied even if sessions never pause', () => {
  const state = holdProposal(proposingState(), { mode: 'apply', now: 1000 })
  const decision = shouldApply(state, {
    now: 1000 + 86_400,
    lastActivity: 1000 + 86_400,
    quietMinutes: 60,
  })
  assert.equal(decision.apply, true)
  assert.equal(decision.reason, 'pending-max-age')
})

test('a pending list is dropped when the mode is no longer apply', () => {
  const state = holdProposal(proposingState(), { mode: 'apply', now: 1000 })
  const decision = shouldApply(state, { now: 100_000, lastActivity: 0, mode: 'propose' })
  assert.equal(decision.apply, false)
  assert.equal(decision.reason, 'mode')
})

test('shouldApply tolerates missing pending state and empty items', () => {
  assert.equal(shouldApply(createState(), { now: 1 }).reason, 'no-pending')
  const state = createState({ auto_pending: { items: ['X'], root: null, since: 0 }, applied: ['X'] })
  assert.equal(shouldApply(state, { now: 100_000, lastActivity: 0 }).reason, 'nothing-pending')
})

test('markApplied records the write, clears the pending list and keeps kept tools out', () => {
  let state = holdProposal(proposingState(), { mode: 'apply', now: 1000 })
  state = createState({ ...state, auto_apply_refused: 'old failure' })
  state = markApplied(state, { items: ['Task'], now: 2000 })
  assert.deepEqual(state.applied, ['Task'])
  assert.deepEqual(state.proposal, [])
  assert.deepEqual(state.auto_applied, ['Task'])
  assert.equal(state.auto_pending, null)
  assert.equal(state.auto_apply_refused, null)
})

test('markRefused records the reason, clears the pending list and keeps the proposal', () => {
  const state = holdProposal(proposingState(), { mode: 'apply', now: 1000 })
  const refused = markRefused(state, { error: 'settings file is committed' })
  assert.equal(refused.auto_apply_refused, 'settings file is committed')
  assert.equal(refused.auto_pending, null)
  assert.deepEqual(refused.proposal, ['Task'], 'a refused list is retried by a later fold')
})

test('restoreTools removes applied entries and marks the tools as given back', () => {
  let state = markApplied(holdProposal(proposingState(), { mode: 'apply', now: 1000 }), {
    items: ['Task'],
    now: 2000,
  })
  state = restoreTools(state, ['Task'])
  assert.deepEqual(state.applied, [])
  assert.deepEqual(state.kept, ['Task'])
  assert.deepEqual(givenBack(state), ['Task'])
  assert.deepEqual(pendingItems(state), [])
})

test('a given-back tool is never proposed again even with overwhelming evidence', () => {
  let state = markApplied(holdProposal(proposingState(), { mode: 'apply', now: 1000 }), {
    items: ['Task'],
    now: 2000,
  })
  state = restoreTools(state, ['Task'])
  const catalog = { tools: ['Task'], descriptions: {}, source: 'test' }
  for (let i = 0; i < 10; i += 1) {
    state = foldSession(state, { catalog, prompts: 20 }, { now: 10_000 + i })
  }
  assert.deepEqual(state.proposal, [])
  assert.deepEqual(state.kept, ['Task'])
})

test('tools that have become protected are given back and reported', () => {
  let state = markApplied(holdProposal(proposingState('read'), { mode: 'apply', now: 1000 }), {
    items: ['read'],
    now: 2000,
  })
  state = restoreProtectedTools(state)
  assert.deepEqual(state.applied, [])
  assert.deepEqual(state.restored_protected, ['read'])
  assert.deepEqual(state.kept, [], 'protected is not the same as a person giving a tool back')
})

test('restoring a pending list removes protected tools from the wait set', () => {
  const base = createState({
    applied: ['read'],
    proposal: ['read', 'Task'],
    auto_pending: { items: ['read', 'Task'], root: null, since: 1000 },
  })
  const state = restoreProtectedTools(base)
  assert.deepEqual(state.applied, [])
  assert.deepEqual(state.auto_pending?.items, ['Task'])
})

test('pendingItems excludes applied and given-back tools', () => {
  const state = createState({
    applied: ['A'],
    kept: ['B'],
    auto_pending: { items: ['A', 'B', 'C'], root: null, since: 1000 },
  })
  assert.deepEqual(pendingItems(state), ['C'])
})
