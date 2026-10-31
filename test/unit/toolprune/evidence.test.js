import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_THRESHOLDS,
  createState,
  enoughEvidence,
  foldSession,
  fromJSON,
  toJSON,
} from '../../../lib/toolprune/evidence.js'

/**
 * @param {string[]} tools
 * @param {string|null} [source]
 * @returns {{ tools: string[], descriptions: Record<string, string>, source: string|null }}
 */
function catalog(tools, source = 'test') {
  return { tools, descriptions: {}, source }
}

/**
 * @param {ReturnType<typeof createState>} state
 * @param {{ toolsUsed?: string[], catalog?: ReturnType<typeof catalog>|null, prompts?: number|null }} session
 * @param {Record<string, unknown>} [extra]
 * @returns {ReturnType<typeof foldSession>}
 */
function foldOk(state, session, extra = {}) {
  return foldSession(state, session, { now: 1000, ...extra })
}

test('the document round-trips through JSON with upstream field names', () => {
  const state = createState({
    used_tools: ['b', 'a', 'a'],
    streaks: { tool: 2, bad: 'x' },
    catalog_tools: ['tool'],
    sessions: 3,
    prompts: 7,
  })
  assert.deepEqual(state.used_tools, ['a', 'b'])
  assert.deepEqual(state.streaks, { tool: 2 })
  const json = JSON.parse(JSON.stringify(toJSON(state)))
  assert.deepEqual(fromJSON(json), state)
  for (const key of [
    'used_tools', 'streaks', 'prompt_streaks', 'catalog_tools', 'catalog_desc',
    'catalog_source', 'sessions', 'prompts', 'updated', 'proposal', 'new_in_proposal',
    'auto_pending', 'auto_applied', 'auto_apply_refused', 'applied', 'kept',
  ]) {
    assert.ok(key in state, `expected upstream schema field ${key}`)
  }
})

test('an empty document normalizes to the documented defaults', () => {
  const state = createState()
  assert.deepEqual(state.used_tools, [])
  assert.deepEqual(state.proposal, [])
  assert.equal(state.sessions, 0)
  assert.equal(state.prompts, 0)
  assert.equal(state.auto_pending, null)
  assert.equal(DEFAULT_THRESHOLDS.evidence, 10)
  assert.equal(DEFAULT_THRESHOLDS.minSessions, 2)
  assert.equal(DEFAULT_THRESHOLDS.sessions, 5)
})

test('a single session of ten unused prompts is not enough evidence (m=2)', () => {
  let state = createState()
  state = foldOk(state, { catalog: catalog(['Notebook']), prompts: 10 })
  assert.equal(state.sessions, 1)
  assert.deepEqual(state.proposal, [])
})

test('p=10 unused prompts over m=2 sessions are enough evidence', () => {
  let state = createState()
  state = foldOk(state, { catalog: catalog(['Notebook']), prompts: 5 })
  assert.deepEqual(state.proposal, [])
  state = foldOk(state, { catalog: catalog(['Notebook']), prompts: 5 })
  assert.deepEqual(state.proposal, ['Notebook'])
  assert.deepEqual(state.new_in_proposal, ['Notebook'])
  assert.equal(state.streaks.Notebook, 2)
  assert.equal(state.prompt_streaks.Notebook, 10)
  assert.equal(state.sessions, 2)
  assert.equal(state.prompts, 10)
})

test('nine unused prompts over two sessions stay below the threshold and the tenth tips it', () => {
  let state = createState()
  state = foldOk(state, { catalog: catalog(['Notebook']), prompts: 4 })
  state = foldOk(state, { catalog: catalog(['Notebook']), prompts: 5 })
  assert.deepEqual(state.proposal, [])
  state = foldOk(state, { catalog: catalog(['Notebook']), prompts: 1 })
  assert.deepEqual(state.proposal, ['Notebook'])
  assert.equal(state.prompt_streaks.Notebook, 10)
})

test('s=5 sessions alone are enough however short (OR branch)', () => {
  let state = createState()
  for (let i = 0; i < 4; i += 1) {
    state = foldOk(state, { catalog: catalog(['Task']), prompts: 1 })
  }
  assert.deepEqual(state.proposal, [], 'four short sessions are below both thresholds')
  state = foldOk(state, { catalog: catalog(['Task']), prompts: 1 })
  assert.deepEqual(state.proposal, ['Task'], 'the fifth session reaches s=5')
  assert.equal(state.prompts, 5, 'the prompt branch (p=10) never fired')
})

test('a session with no prompt is no evidence at all', () => {
  let state = createState()
  state = foldOk(state, { toolsUsed: ['read'], catalog: catalog(['read', 'Task']), prompts: 0 })
  assert.equal(state.sessions, 0)
  assert.deepEqual(state.streaks, {})
  assert.deepEqual(state.used_tools, [])
  assert.deepEqual(state.proposal, [])
})

test('an unknown prompt count counts as one prompt', () => {
  let state = createState()
  for (let i = 0; i < 5; i += 1) {
    state = foldOk(state, { catalog: catalog(['Task']), prompts: null })
  }
  assert.equal(state.prompts, 5)
  assert.deepEqual(state.proposal, ['Task'])
})

test('a high-risk tool needs three times the prompts (factor 3)', () => {
  let state = createState()
  state = foldOk(state, { catalog: catalog(['NotebookEdit']), prompts: 10 })
  state = foldOk(state, { catalog: catalog(['NotebookEdit']), prompts: 10 })
  assert.deepEqual(state.proposal, [], '20 prompts over two sessions is below 30')
  state = foldOk(state, { catalog: catalog(['NotebookEdit']), prompts: 10 })
  assert.deepEqual(state.proposal, ['NotebookEdit'], '30 prompts reaches p*3')
})

test('the high-risk factor also multiplies the session threshold', () => {
  let state = createState()
  for (let i = 0; i < 14; i += 1) {
    state = foldOk(state, { catalog: catalog(['NotebookEdit']), prompts: 1 })
  }
  assert.deepEqual(state.proposal, [], 'fourteen sessions are below s*3')
  state = foldOk(state, { catalog: catalog(['NotebookEdit']), prompts: 1 })
  assert.deepEqual(state.proposal, ['NotebookEdit'], 'the fifteenth session reaches s*3')
})

test('configured extra high-risk tools use the same factor', () => {
  let state = createState()
  const options = { now: 1000, highRiskTools: ['dangerous_mcp'] }
  for (let i = 0; i < 2; i += 1) {
    state = foldSession(state, { catalog: catalog(['dangerous_mcp']), prompts: 10 }, options)
  }
  assert.deepEqual(state.proposal, [])
  state = foldSession(state, { catalog: catalog(['dangerous_mcp']), prompts: 10 }, options)
  assert.deepEqual(state.proposal, ['dangerous_mcp'])
})

test('a protected tool is never proposed, however long it goes unused', () => {
  let state = createState()
  for (let i = 0; i < 10; i += 1) {
    state = foldOk(state, { catalog: catalog(['read', 'Task']), prompts: 5 })
  }
  assert.deepEqual(state.proposal, ['Task'])
})

test('a tool ever used is never proposed', () => {
  let state = createState()
  state = foldOk(state, { toolsUsed: ['Extra'], catalog: catalog(['Extra']), prompts: 3 })
  for (let i = 0; i < 5; i += 1) {
    state = foldOk(state, { catalog: catalog(['Extra']), prompts: 5 })
  }
  assert.equal(state.streaks.Extra, 5)
  assert.deepEqual(state.proposal, [], 'ever used => never proposed')
  assert.deepEqual(state.used_tools, ['Extra'])
})

test('already-applied and given-back tools are excluded from the proposal', () => {
  let state = createState({ applied: ['Old'], kept: ['Gone'] })
  for (let i = 0; i < 5; i += 1) {
    state = foldOk(state, { catalog: catalog(['Old', 'Gone', 'Fresh']), prompts: 5 })
  }
  assert.deepEqual(state.proposal, ['Fresh'])
})

test('new_in_proposal reports only the delta', () => {
  let state = createState()
  state = foldOk(state, { catalog: catalog(['A']), prompts: 5 })
  state = foldOk(state, { catalog: catalog(['A']), prompts: 5 })
  assert.deepEqual(state.new_in_proposal, ['A'])
  state = foldOk(state, { catalog: catalog(['A']), prompts: 5 })
  assert.deepEqual(state.new_in_proposal, [])
  state = foldOk(state, { catalog: catalog(['A', 'B']), prompts: 5 })
  assert.deepEqual(state.new_in_proposal, [], 'B has only one unused session so far')
  state = foldOk(state, { catalog: catalog(['A', 'B']), prompts: 5 })
  assert.deepEqual(state.proposal, ['A', 'B'])
  assert.deepEqual(state.new_in_proposal, ['B'])
})

test('the catalog accumulates, descriptions merge, and the last source is recorded', () => {
  let state = createState()
  state = foldSession(state, { catalog: { tools: ['A'], descriptions: { A: 'first' }, source: 'src1' }, prompts: 1 }, { now: 1000 })
  state = foldSession(state, {
    catalog: { tools: ['B'], descriptions: { B: 'second' }, source: 'src2' },
    prompts: 1,
  }, { now: 2000 })
  assert.deepEqual(state.catalog_tools, ['A', 'B'])
  assert.deepEqual(state.catalog_desc, { A: 'first', B: 'second' })
  assert.equal(state.catalog_source, 'src2')
  assert.equal(state.updated, 2000)
  assert.equal(state.streaks.A, 2)
  assert.equal(state.streaks.B, 1)
})

test('using a tool resets both its streak and its prompt streak', () => {
  let state = createState()
  state = foldOk(state, { catalog: catalog(['A']), prompts: 5 })
  state = foldOk(state, { catalog: catalog(['A']), prompts: 5 })
  assert.equal(state.streaks.A, 2)
  assert.equal(state.prompt_streaks.A, 10)
  state = foldOk(state, { toolsUsed: ['A'], catalog: catalog(['A']), prompts: 7 })
  assert.equal(state.streaks.A, 0)
  assert.equal(state.prompt_streaks.A, 0)
  assert.deepEqual(state.proposal, [])
})

test('an unknown catalog is not "no tools loaded": the prior catalog is kept', () => {
  let state = createState()
  state = foldOk(state, { catalog: catalog(['A']), prompts: 1 })
  state = foldOk(state, { catalog: null, prompts: 1 })
  assert.deepEqual(state.catalog_tools, ['A'])
  assert.equal(state.catalog_source, 'test')
  assert.equal(state.sessions, 2)
})

test('folding is pure: the input document is not mutated', () => {
  const before = createState({ used_tools: ['x'], catalog_tools: ['x', 'y'], streaks: { y: 1 } })
  const snapshot = JSON.stringify(before)
  foldOk(before, { catalog: catalog(['x', 'y', 'z']), prompts: 4 })
  assert.equal(JSON.stringify(before), snapshot)
})

test('threshold overrides change the decision without touching the defaults', () => {
  let state = createState()
  const options = { now: 1000, thresholds: { evidence: 3 } }
  state = foldSession(state, { catalog: catalog(['A']), prompts: 2 }, options)
  state = foldSession(state, { catalog: catalog(['A']), prompts: 2 }, options)
  assert.deepEqual(state.proposal, ['A'], '4 prompts reaches the overridden p=3')
  assert.equal(DEFAULT_THRESHOLDS.evidence, 10)
})

test('the bare enoughEvidence rule matches the upstream formula', () => {
  assert.equal(enoughEvidence(2, 10), true)
  assert.equal(enoughEvidence(2, 9), false)
  assert.equal(enoughEvidence(1, 100), false, 'one session never decides alone')
  assert.equal(enoughEvidence(5, 0), true, 's branch')
  assert.equal(enoughEvidence(4, 9), false)
  assert.equal(enoughEvidence(2, 30, DEFAULT_THRESHOLDS, true), true, 'high risk p*3')
  assert.equal(enoughEvidence(2, 29, DEFAULT_THRESHOLDS, true), false)
  assert.equal(enoughEvidence(15, 0, DEFAULT_THRESHOLDS, true), true, 'high risk s*3')
  assert.equal(enoughEvidence(14, 0, DEFAULT_THRESHOLDS, true), false)
})
