/**
 * Stage orchestration: plain-JSON state, fold/render across a session stream.
 *
 * Ported from `tokeneconomizer/microskills/stage.py` (`PrefixStage`) with the
 * DSH plugin contract from research/UPSTREAM.md §3.5: state in, block out, no
 * filesystem or model calls.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  PROVENANCE_NOTE,
  PROFILE_ENVFACTS,
  PROFILE_OFF,
  STATE_SCHEMA_VERSION,
  createState,
  foldSession,
  listFacts,
  removeFact,
  renderInjection,
  renderProvenance,
  resetProjectState,
  stateFromJSON,
} from '../../../lib/microskills/stage.js'
import { EnvFact } from '../../../lib/microskills/envfacts.js'
import { GENERIC, PYTHON_GIT } from '../../../lib/microskills/observe.js'
import { PROJ, brokenEnv, cleanRunner, cmd, edit, observe } from './helpers.js'

/**
 * @param {import('../../../lib/microskills/stage.js').MicroskillsState} state
 * @param {import('../../../lib/microskills/observe.js').NormalizedCall[]} calls
 * @param {object} [options]
 * @returns {import('../../../lib/microskills/stage.js').MicroskillsState}
 */
function fold(state, calls, options = {}) {
  return foldSession(state, observe(calls), { profile: PROFILE_ENVFACTS, ...options })
}

/**
 * @param {import('../../../lib/microskills/stage.js').MicroskillsState} state
 * @param {number} [count]
 * @returns {import('../../../lib/microskills/stage.js').MicroskillsState}
 */
function foldBrokenSessions(state, count = 4) {
  for (let index = 0; index < count; index += 1) fold(state, brokenEnv(index))
  return state
}

test('createState: a fresh state document with the documented default shape', () => {
  const state = createState()
  assert.equal(state.schemaVersion, STATE_SCHEMA_VERSION)
  assert.equal(state.profile, PROFILE_OFF)
  assert.equal(state.vocab, 'generic')
  assert.equal(state.repo, '')
  assert.equal(state.now, 0)
  assert.equal(state.sessions, 0)
  assert.equal(state.optTokens, 0)
  assert.deepEqual(state.facts, {})
  assert.deepEqual(state.injectedIds, [])
  assert.equal(state.rendered, '')
  assert.deepEqual(state.renderedIds, [])
  assert.equal(state.updated, null)
  assert.equal(state.lastDigest, null)
  assert.deepEqual(Object.keys(state).sort(), [
    'facts', 'injectedIds', 'lastDigest', 'now', 'optTokens', 'profile', 'rendered',
    'renderedIds', 'repo', 'schemaVersion', 'sessions', 'updated', 'vocab',
  ])
  const labelled = createState({ profile: PROFILE_ENVFACTS, repo: 'owner/repo', vocab: 'python-git' })
  assert.equal(labelled.profile, PROFILE_ENVFACTS)
  assert.equal(labelled.repo, 'owner/repo')
  assert.equal(labelled.vocab, 'python-git')
})

test('foldSession: profile off is a no-op (upstream learns nothing when disabled)', () => {
  const state = createState()
  foldSession(state, observe(brokenEnv(0)))
  assert.equal(state.sessions, 0)
  assert.equal(state.now, 0)
  assert.deepEqual(state.facts, {})
  // The same state learns once the profile enables it.
  fold(state, brokenEnv(0))
  assert.equal(state.sessions, 1)
  assert.equal(Object.keys(state.facts).length, 1)
})

test('foldSession/renderInjection: promotion, firing gate and the rendered block', () => {
  const state = createState({ profile: PROFILE_ENVFACTS, repo: 'acme/widget' })
  foldBrokenSessions(state, 3)
  assert.equal(state.sessions, 3)
  const promoted = listFacts(state)
  assert.equal(promoted.length, 1)
  assert.equal(promoted[0].state, 'ACTIVE')
  assert.equal(promoted[0].injectable, false) // FIRE_MIN_N=4 not reached
  assert.deepEqual(renderInjection(state).text, '')

  fold(state, brokenEnv(3))
  assert.equal(state.sessions, 4)
  const rendered = renderInjection(state)
  assert.ok(rendered.text.startsWith('# environment facts learned from earlier sessions in this repository'))
  assert.deepEqual(rendered.ids, ['form_repair:run_tests:python -m pytest'])
  assert.equal(rendered.factsView.length, 1)
  assert.equal(rendered.factsView[0].injectable, true)
  assert.equal(state.rendered, rendered.text)
  assert.deepEqual(state.renderedIds, rendered.ids)
  assert.deepEqual(state.injectedIds, rendered.ids)
  assert.equal(state.optTokens, 0)
})

test('foldSession: the pending render seed carries prevented-waste firing (two-process path)', () => {
  const state = createState({ profile: PROFILE_ENVFACTS, repo: 'acme/widget' })
  foldBrokenSessions(state, 4)
  renderInjection(state) // session start: this block is what the next session gets
  fold(state, [edit('pkg/z.py'), cmd(`${PROJ} -m pytest tests/test_z.py -q`, '3 passed', 0)])
  const row = listFacts(state)[0]
  assert.equal(row.fire, '5/5')
  assert.equal(row.state, 'ACTIVE')
})

test('foldSession: options.injectedIds overrides the pending seed', () => {
  const state = createState({ profile: PROFILE_ENVFACTS, repo: 'acme/widget' })
  foldBrokenSessions(state, 4)
  // No render happened, but the adapter says the session was given the fact.
  fold(state, [edit('pkg/z.py'), cmd(`${PROJ} -m pytest -q`, '3 passed', 0)], {
    injectedIds: ['form_repair:run_tests:python -m pytest'],
  })
  assert.equal(listFacts(state)[0].fire, '5/5')
})

test('renderInjection: caps come from options (maxFacts / maxTokens)', () => {
  const state = createState({ profile: PROFILE_ENVFACTS, repo: 'acme/widget' })
  for (let index = 0; index < 3; index += 1) {
    const fact = new EnvFact(`form_repair:run_tests:tool${index}`, 'form_repair', false, {
      intent: 'run_tests',
      a: `tool${index}`,
      b_counts: { [`/opt/${index}/bin/tool${index}`]: 3 },
      error_counts: { command_missing: 3 },
    })
    fact.life.state = 'ACTIVE'
    fact.life.fireNum = 5
    fact.life.fireDen = 5
    state.facts[fact.id] = fact.toJSON()
  }
  const capped = renderInjection(state, { maxFacts: 1 })
  assert.equal(capped.ids.length, 1)
  assert.equal(capped.text.trim().split('\n').length, 2) // header + one bullet
  const tiny = renderInjection(state, { maxTokens: 1 })
  assert.deepEqual(tiny.ids, [])
  assert.equal(tiny.text, '')
  const unlimited = renderInjection(state, { maxFacts: 3 })
  assert.equal(unlimited.ids.length, 3)
  assert.ok(unlimited.text.length <= 150 * 4)
})

test('stateFromJSON: a save/load round-trip preserves learning and rendering', () => {
  const state = createState({ profile: PROFILE_ENVFACTS, repo: 'acme/widget' })
  foldBrokenSessions(state, 4)
  const before = renderInjection(state)
  const restored = stateFromJSON(JSON.parse(JSON.stringify(state)))
  assert.equal(restored.schemaVersion, STATE_SCHEMA_VERSION)
  assert.equal(restored.profile, PROFILE_ENVFACTS)
  assert.equal(restored.repo, 'acme/widget')
  assert.equal(restored.now, state.now)
  assert.equal(restored.sessions, state.sessions)
  assert.deepEqual(Object.keys(restored.facts), Object.keys(state.facts))
  assert.deepEqual(restored.injectedIds, state.injectedIds)
  assert.deepEqual(restored.renderedIds, state.renderedIds)
  assert.equal(renderInjection(restored).text, before.text)
  // The persisted fact documents keep upstream's snake_case lifecycle keys.
  const factDoc = /** @type {any} */ (restored.facts['form_repair:run_tests:python -m pytest'])
  assert.equal(factDoc.life.state, 'ACTIVE')
  assert.equal(factDoc.life.fire_num, 4)
  assert.equal(factDoc.family, 'form_repair')
})

test('stateFromJSON: malformed persisted state recovers instead of throwing', () => {
  assert.equal(stateFromJSON('{not json').profile, PROFILE_OFF)
  assert.deepEqual(stateFromJSON(null).facts, {})
  assert.deepEqual(stateFromJSON(42).facts, {})
  const recovered = stateFromJSON({
    profile: 'garbage',
    repo: 7,
    vocab: 99,
    now: 'NaN',
    sessions: -3,
    optTokens: 123,
    facts: { bad: 3, worse: { id: 'worse', family: 'form_repair' }, good: 'nope' },
    injectedIds: 'no',
    rendered: 42,
    renderedIds: null,
    updated: 'when',
    lastDigest: [],
  })
  assert.equal(recovered.profile, PROFILE_OFF)
  assert.equal(recovered.repo, '')
  assert.equal(recovered.vocab, 'generic')
  assert.equal(recovered.now, 0)
  assert.equal(recovered.sessions, 0)
  assert.equal(recovered.optTokens, 0)
  assert.deepEqual(recovered.facts, {})
  assert.deepEqual(recovered.injectedIds, [])
  assert.equal(recovered.rendered, '')
  assert.deepEqual(recovered.renderedIds, [])
  assert.equal(recovered.updated, null)
  assert.equal(recovered.lastDigest, null)
  // And it is usable afterwards.
  fold(recovered, brokenEnv(0), { profile: PROFILE_ENVFACTS })
  assert.equal(recovered.sessions, 1)
})

test('stateFromJSON: injected/rendered ids referencing dropped facts are pruned', () => {
  const state = createState({ profile: PROFILE_ENVFACTS })
  const fact = new EnvFact('form_repair:run_tests:pytest', 'form_repair', false, { intent: 'run_tests', a: 'pytest' })
  fact.life.state = 'ACTIVE'
  fact.life.fireNum = 4
  fact.life.fireDen = 4
  state.facts[fact.id] = fact.toJSON()
  state.injectedIds = [fact.id, 'ghost']
  state.renderedIds = ['ghost', fact.id]
  const restored = stateFromJSON(state)
  assert.deepEqual(restored.injectedIds, [fact.id])
  assert.deepEqual(restored.renderedIds, [fact.id])
})

test('profile off: renderInjection clears the cached block but still lists tracked facts', () => {
  const state = createState({ profile: PROFILE_ENVFACTS, repo: 'acme/widget' })
  foldBrokenSessions(state, 4)
  renderInjection(state)
  assert.notEqual(state.rendered, '')
  const off = renderInjection(state, { profile: PROFILE_OFF })
  assert.equal(off.text, '')
  assert.deepEqual(off.ids, [])
  assert.equal(off.factsView.length, 1) // status still shows what was learned
  assert.equal(state.rendered, '')
  assert.deepEqual(state.renderedIds, [])
  assert.deepEqual(state.injectedIds, [])
})

test('cross-project isolation: two state objects never share facts', () => {
  const widget = createState({ profile: PROFILE_ENVFACTS, repo: 'acme/widget' })
  const tool = createState({ profile: PROFILE_ENVFACTS, repo: 'acme/tool' })
  for (let index = 0; index < 4; index += 1) fold(widget, brokenEnv(index))
  for (let index = 0; index < 4; index += 1) fold(tool, cleanRunner(index))
  assert.ok(Object.prototype.hasOwnProperty.call(widget.facts, 'form_repair:run_tests:python -m pytest'))
  assert.equal(Object.prototype.hasOwnProperty.call(widget.facts, 'form_repair:run_tests:pytest'), false)
  assert.ok(Object.prototype.hasOwnProperty.call(tool.facts, 'form_repair:run_tests:pytest'))
  assert.equal(Object.prototype.hasOwnProperty.call(tool.facts, 'form_repair:run_tests:python -m pytest'), false)
  assert.equal(renderInjection(widget).text.includes('`pytest …` fails here'), false)
  assert.equal(removeFact(widget, 'form_repair:run_tests:python -m pytest'), true)
  assert.equal(removeFact(tool, 'form_repair:run_tests:python -m pytest'), false)
  assert.equal(removeFact(tool, 'form_repair:run_tests:pytest'), true)
})

test('removeFact: deletes the fact, prunes ids and invalidates the cached block', () => {
  const state = createState({ profile: PROFILE_ENVFACTS, repo: 'acme/widget' })
  foldBrokenSessions(state, 4)
  const rendered = renderInjection(state)
  assert.equal(rendered.ids.length, 1)
  assert.notEqual(state.rendered, '')
  assert.equal(removeFact(state, 'not-a-fact'), false)
  assert.equal(removeFact(state, rendered.ids[0]), true)
  assert.deepEqual(state.facts, {})
  assert.deepEqual(state.injectedIds, [])
  assert.deepEqual(state.renderedIds, [])
  assert.equal(state.rendered, '')
  assert.deepEqual(renderInjection(state).text, '')
})

test('resetProjectState: a fresh empty document, independent of the old one', () => {
  const state = createState({ profile: PROFILE_ENVFACTS, repo: 'acme/widget' })
  foldBrokenSessions(state, 4)
  const fresh = resetProjectState()
  assert.equal(fresh.profile, PROFILE_OFF)
  assert.deepEqual(fresh.facts, {})
  assert.notEqual(fresh, state)
  assert.equal(Object.keys(state.facts).length, 1) // resetting returns a new document
  const labelled = resetProjectState({ repo: 'acme/widget', profile: PROFILE_ENVFACTS, vocab: 'python-git' })
  assert.equal(labelled.repo, 'acme/widget')
  assert.equal(labelled.profile, PROFILE_ENVFACTS)
  assert.equal(labelled.vocab, 'python-git')
})

test('foldSession: missing or malformed observations still advance the counter', () => {
  const state = createState({ profile: PROFILE_ENVFACTS })
  foldSession(state, /** @type {any} */ (undefined), { profile: PROFILE_ENVFACTS })
  assert.equal(state.sessions, 1)
  assert.equal(state.now, 1)
  assert.deepEqual(state.facts, {})
  foldSession(state, /** @type {any} */ ({ obs: 'nope', edited: 3, env: {} }), { profile: PROFILE_ENVFACTS })
  assert.equal(state.sessions, 2)
  // A profile off fold after envfacts keeps the profile off but the facts intact.
  const off = foldSession(state, observe(brokenEnv(0)), { profile: PROFILE_OFF })
  assert.equal(off.profile, PROFILE_OFF)
  assert.equal(off.sessions, 2)
})

test('foldSession: timestamps, telemetry and vocabulary are adapter-visible state', () => {
  const state = createState({ profile: PROFILE_ENVFACTS, repo: 'acme/widget' })
  foldBrokenSessions(state, 1)
  assert.ok(state.lastDigest)
  assert.equal(typeof state.lastDigest?.nCalls, 'number')
  assert.ok(state.lastDigest?.verdicts)
  fold(state, brokenEnv(1), { timestamp: 1_700_000_000 })
  assert.equal(state.updated, 1_700_000_000)
  assert.equal(state.now, 2)
  assert.equal(state.sessions, 2)
  assert.equal(state.vocab, 'generic')
  // The Python/fact doc keeps upstream snake_case lifecycle fields.
  const doc = /** @type {any} */ (state.facts['form_repair:run_tests:python -m pytest'])
  assert.ok(doc.life)
  assert.equal(typeof doc.life.fire_num, 'number')
})

test('renderProvenance: the untrusted-data wrapper an adapter prepends', () => {
  const state = createState({ profile: PROFILE_ENVFACTS, repo: 'acme/widget' })
  foldBrokenSessions(state, 4)
  const block = renderInjection(state).text
  const wrapped = renderProvenance(block)
  assert.ok(wrapped.startsWith('<learned-environment-facts>'))
  assert.ok(wrapped.endsWith('</learned-environment-facts>'))
  assert.ok(wrapped.includes(PROVENANCE_NOTE))
  assert.ok(wrapped.includes(block.trim()))
  // Empty blocks wrap to nothing.
  assert.equal(renderProvenance(''), '')
  assert.equal(renderProvenance('   \n'), '')
  // Idempotent: an already-wrapped block is returned unchanged.
  assert.equal(renderProvenance(wrapped), wrapped)
})

test('sanitization: learned strings never inject newlines or control characters', () => {
  const state = createState({ profile: PROFILE_ENVFACTS, repo: 'acme/widget' })
  const fact = new EnvFact('form_repair:run_tests:weird', 'form_repair', false, {
    intent: 'run_tests',
    a: 'python\nrm -rf /',
    b_counts: { '/opt/env\nrm -rf /bin/python -m pytest': 4 },
    error_counts: { command_missing: 4 },
  })
  fact.life.state = 'ACTIVE'
  fact.life.fireNum = 4
  fact.life.fireDen = 4
  state.facts[fact.id] = fact.toJSON()
  const { text } = renderInjection(state)
  assert.ok(text.length > 0)
  // Newlines are the block's own line separators; learned content may add none.
  assert.equal(/[\r\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/.test(text), false)
  const lines = text.trimEnd().split('\n')
  assert.ok(lines[0].startsWith('#'))
  for (const line of lines.slice(1)) assert.ok(line.startsWith('- '))
  assert.equal(lines.length, 2)
  for (const line of lines) assert.equal(/[\u0000-\u001f]/.test(line), false)
  assert.ok(text.includes('python rm -rf /'))
  // The persisted state is allowed to keep the raw observation; only rendering sanitizes.
  const wrapped = renderProvenance(text)
  assert.equal(/[\u0000-\u001f]/.test(wrapped.replace(/\n/g, '')), false)
})

test('state document vocab selects the header (generic vs python-git reading)', () => {
  const pythonGit = createState({ profile: PROFILE_ENVFACTS, repo: 'acme/widget', vocab: 'python-git' })
  for (let index = 0; index < 4; index += 1) fold(pythonGit, brokenEnv(index))
  assert.ok(renderInjection(pythonGit).text.startsWith('# environment facts learned from earlier tasks in this checkout'))
  const generic = createState({ profile: PROFILE_ENVFACTS, repo: 'acme/widget', vocab: 'generic' })
  for (let index = 0; index < 4; index += 1) fold(generic, brokenEnv(index))
  assert.ok(renderInjection(generic).text.startsWith('# environment facts learned from earlier sessions in this repository'))
})

