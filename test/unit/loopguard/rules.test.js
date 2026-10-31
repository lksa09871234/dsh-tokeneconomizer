import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_THRESHOLDS,
  SPIRAL_LEVELS,
  assessAbort,
  gateForJudge,
  isStuck,
  nudgeText,
  pinLiveThresholds,
  scaledThresholds,
} from '../../../lib/loopguard/rules.js'
import { SpiralState } from '../../../lib/loopguard/state.js'

/**
 * A state that satisfies the strict stuck rule: turns >= min_turns, churn over
 * one file, sustained errors, and repeated identical failures.
 * @param {number} [turns]
 * @returns {SpiralState}
 */
function stuckState(turns = 30) {
  const state = new SpiralState()
  for (let i = 0; i < 5; i += 1) state.update('edit', { path: '/r/a.py' }, 'ok')
  for (let i = 0; i < 8; i += 1) {
    state.update('bash', { command: 'pytest -q' }, 'FAILED tests/a.py::t - AssertionError', 1)
  }
  while (state.turns < turns) state.update('read', { path: '/r/other.py' }, 'contents')
  return state
}

/** @returns {SpiralState} */
function cleanState(turns = 30) {
  const state = new SpiralState()
  for (let i = 0; i < turns; i += 1) state.update('read', { path: `/r/m${i}.py` }, 'ok')
  return state
}

test('rules.thresholdPresets: DEFAULT_THRESHOLDS is verbatim upstream §11', () => {
  assert.deepEqual(DEFAULT_THRESHOLDS, {
    min_turns: 20,
    edit_churn: 4,
    distinct_edit_files: 3,
    error_outputs: 6,
    stagnation: 0.2,
    envelope_margin: 1.25,
    envelope_pct: 90,
    envelope_min_samples: 5,
    judge_confidence: 0.7,
    backstop_mult: 2.5,
    gate_min_turns: 18,
    gate_error_outputs: 8,
  })
})

test('rules.thresholdPresets: SPIRAL_LEVELS matches upstream rules.py:53-66', () => {
  assert.deepEqual(SPIRAL_LEVELS.conservative, {
    judge_confidence: 0.85,
    envelope_margin: 1.5,
    backstop_mult: 3.5,
    stagnation: 0.3,
    gate_min_turns: 24,
    min_turns: 28,
    edit_churn: 5,
    error_outputs: 8,
    envelope_min_samples: 7,
  })
  assert.deepEqual(SPIRAL_LEVELS.default, {})
  assert.deepEqual(SPIRAL_LEVELS.aggressive, {
    judge_confidence: 0.55,
    envelope_margin: 1.0,
    backstop_mult: 1.8,
    stagnation: 0.12,
    gate_min_turns: 12,
    min_turns: 14,
    edit_churn: 3,
    error_outputs: 4,
    envelope_min_samples: 3,
    nudge_on_ambiguous: true,
  })
})

test('rules.thresholdPresets: scaledThresholds overlays the level on the defaults', () => {
  assert.deepEqual(scaledThresholds('default'), { ...DEFAULT_THRESHOLDS })
  const conservative = scaledThresholds('conservative')
  assert.equal(conservative.judge_confidence, 0.85)
  assert.equal(conservative.min_turns, 28)
  assert.equal(conservative.distinct_edit_files, DEFAULT_THRESHOLDS.distinct_edit_files)
  assert.equal(conservative.envelope_pct, 90)
  const aggressive = scaledThresholds('aggressive')
  assert.equal(aggressive.envelope_margin, 1.0)
  assert.equal(aggressive.nudge_on_ambiguous, true)
  assert.deepEqual(scaledThresholds('nonsense'), { ...DEFAULT_THRESHOLDS })
})

test('rules.pinLiveThresholds: the live plugin never gate-opens on envelope length', () => {
  const pinned = pinLiveThresholds({ ...DEFAULT_THRESHOLDS, gate_min_turns: 6, min_turns: 20 })
  assert.equal(pinned.gate_over_envelope, false)
  assert.equal(pinned.gate_min_turns, 20)
  assert.equal(pinned.min_turns, 20)
})

test('rules.gateForJudge: needs gate_min_turns and a trouble sign', () => {
  const state = new SpiralState()
  for (let i = 0; i < 17; i += 1) state.update('bash', { command: 'pytest -q' }, 'FAILED x', 1)
  state.update('bash', { command: 'pytest -q' }, 'FAILED x', 1) // 18 turns, repeated failures
  assert.equal(gateForJudge(state), true)
  const quiet = cleanState(30)
  assert.equal(gateForJudge(quiet), false)
  const beforeGate = new SpiralState()
  for (let i = 0; i < 3; i += 1) beforeGate.update('bash', { command: 'pytest -q' }, 'FAILED x', 1)
  assert.equal(gateForJudge(beforeGate), false)
  // Dense errors without an exact repeat open the gate too.
  const noisy = cleanState(30)
  noisy.errorOutputs = 8
  assert.equal(gateForJudge(noisy), true)
})

test('rules.isStuck: requires turns AND churn/scatter AND errors AND stagnation', () => {
  assert.equal(isStuck(stuckState()), true)
  assert.equal(isStuck(cleanState(30)), false)
  // Not enough turns.
  assert.equal(isStuck(stuckState(10)), false)
  // Churn and errors but no repeats: a productive hard grind.
  const distinct = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta']
  const changing = new SpiralState()
  for (let i = 0; i < 5; i += 1) changing.update('edit', { path: '/r/a.py' }, 'ok')
  for (let i = 0; i < 8; i += 1) {
    changing.update('bash', { command: 'pytest -q' }, `FAILED x - Unique${distinct[i]}Error`, 1)
  }
  while (changing.turns < 30) changing.update('read', { path: '/r/m.py' }, 'ok')
  assert.equal(changing.repeatedFailSigs, 0)
  assert.equal(isStuck(changing), false)
  // Scatter alone is enough when the rest holds.
  const scattered = new SpiralState()
  for (let i = 0; i < 4; i += 1) scattered.update('edit', { path: `/r/f${i}.py` }, 'ok')
  for (let i = 0; i < 8; i += 1) {
    scattered.update('bash', { command: 'pytest -q' }, 'FAILED x', 1)
  }
  while (scattered.turns < 30) scattered.update('read', { path: '/r/m.py' }, 'ok')
  assert.equal(isStuck(scattered), true)
})

test('rules.assessAbort: hard backstop runs before the judge and cannot be vetoed', () => {
  const state = stuckState(30)
  let judgeCalls = 0
  const judge = () => {
    judgeCalls += 1
    return { stuck: false, confidence: 0.9 }
  }
  const decision = assessAbort(state, { envelope: 10, judge })
  assert.equal(decision.abort, true)
  assert.match(decision.reason, /^backstop:30>=25turns stagnation=0\.88/)
  assert.equal(judgeCalls, 0)
})

test('rules.assessAbort: a pinned learned backstop_turns is preferred over the multiplier', () => {
  const state = stuckState(20)
  const decision = assessAbort(state, {
    envelope: 100,
    thr: { ...DEFAULT_THRESHOLDS, backstop_turns: 12 },
  })
  assert.equal(decision.abort, true)
  assert.match(decision.reason, /^backstop:20>=12turns/)
})

test('rules.assessAbort: gate-closed spares without calling the judge', () => {
  let judgeCalls = 0
  const decision = assessAbort(cleanState(30), {
    envelope: 5,
    thr: pinLiveThresholds(DEFAULT_THRESHOLDS),
    judge: () => {
      judgeCalls += 1
      return { stuck: true, confidence: 1 }
    },
  })
  assert.deepEqual(decision, { abort: false, reason: 'gate-closed' })
  assert.equal(judgeCalls, 0)
})

test('rules.assessAbort: judge-stuck with sufficient confidence aborts', () => {
  const decision = assessAbort(stuckState(20), {
    judge: () => ({ stuck: true, confidence: 0.82, reason: 'same edit/error over and over' }),
  })
  assert.equal(decision.abort, true)
  assert.equal(decision.reason, 'judge-stuck@0.82:same edit/error over and over')
})

test('rules.assessAbort: judge-stuck below the confidence cutoff is ambiguous, so spared', () => {
  const decision = assessAbort(stuckState(20), {
    judge: () => ({ stuck: true, confidence: 0.5 }),
  })
  assert.deepEqual(decision, { abort: false, reason: 'judge-ambiguous-spared' })
})

test('rules.assessAbort: a productive verdict spares even past the envelope', () => {
  const decision = assessAbort(cleanState(20), {
    envelope: 10,
    judge: () => ({ stuck: false, confidence: 0.8 }),
  })
  assert.deepEqual(decision, { abort: false, reason: 'judge-productive' })
})

test('rules.assessAbort: a judge exception/None reads as throttled, never as stuck', () => {
  const throwing = assessAbort(stuckState(20), {
    judge: () => {
      throw new Error('side call failed')
    },
  })
  assert.deepEqual(throwing, { abort: false, reason: 'judge-throttled' })
  const silent = assessAbort(stuckState(20), { judge: () => null })
  assert.deepEqual(silent, { abort: false, reason: 'judge-throttled' })
})

test('rules.assessAbort: judge ambiguity never kills on the envelope alone', () => {
  const decision = assessAbort(stuckState(20), {
    envelope: 10,
    judge: () => ({ stuck: null, confidence: 0.99 }),
  })
  assert.deepEqual(decision, { abort: false, reason: 'judge-ambiguous-spared' })
})

test('rules.assessAbort: no-judge fallback decision order', () => {
  assert.deepEqual(
    assessAbort(cleanState(30), { envelope: 10 }),
    { abort: false, reason: 'not-stuck' },
  )
  assert.deepEqual(
    assessAbort(stuckState(30), { envelope: 40 }),
    { abort: false, reason: 'stuck-but-within-envelope' },
  )
  // Past the envelope but not yet at the 2.5x hard backstop.
  const aborted = assessAbort(stuckState(20), { envelope: 10 })
  assert.equal(aborted.abort, true)
  assert.equal(aborted.reason, 'envelope:20>=10')
  // Without an envelope the fallback never acts (cold start).
  assert.deepEqual(
    assessAbort(stuckState(30), {}),
    { abort: false, reason: 'stuck-but-within-envelope' },
  )
})

test('rules.nudgeText: verbatim upstream template with the observed counts', () => {
  const state = new SpiralState()
  state.update('edit', { path: '/r/a.py' }, 'ok')
  state.update('edit', { path: '/r/a.py' }, 'ok')
  state.update('edit', { path: '/r/b.py' }, 'ok')
  state.update('bash', { command: 'pytest -q' }, 'FAILED tests/a.py::t - AssertionError', 1)
  state.update('bash', { command: 'pytest -q' }, 'FAILED tests/a.py::t - AssertionError', 1)
  assert.equal(
    nudgeText(state),
    'Process check (automated): so far you\'ve made 3 edits across 2 file(s) '
    + '(most to `a.py`) and run 2 verification(s), and the same failure has recurred '
    + '1 time(s) without the tests going green. This looks like a repetitive loop. '
    + 'Do NOT stop — instead step back and try a MATERIALLY DIFFERENT hypothesis: '
    + 're-read the failing test\'s expectation, consider a different file or root cause '
    + 'than the ones you\'ve been editing, and verify the new hypothesis directly before '
    + 'editing again.',
  )
  assert.equal(nudgeText(new SpiralState()).includes('most to `one file`'), true)
})
