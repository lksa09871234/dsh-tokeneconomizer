import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ENVELOPE_HISTORY,
  EnvelopeTracker,
  baseThresholds,
  loadEnvelope,
  percentile,
  recordTurn,
  resolvedProxy,
  saveEnvelope,
  thresholdsFor,
} from '../../../lib/loopguard/envelope.js'
import { DEFAULT_THRESHOLDS, scaledThresholds } from '../../../lib/loopguard/rules.js'

/**
 * @param {number[]} turns
 * @param {import('../../../lib/loopguard/state.js').SpiralSnapshot[]} [snaps]
 * @param {string} [level]
 * @returns {EnvelopeTracker}
 */
function warmTracker(turns, snaps = [], level = 'default') {
  const tracker = new EnvelopeTracker({ level })
  for (let i = 0; i < turns.length; i += 1) tracker.update(turns[i], true, snaps[i] ?? null)
  return tracker
}

/** @param {Record<string, number>} overrides @returns {import('../../../lib/loopguard/state.js').SpiralSnapshot} */
function snapshot(overrides) {
  return {
    turns: 0,
    edit_churn: 0,
    distinct_edit_files: 0,
    error_outputs: 0,
    test_runs: 0,
    stagnation: 0,
    repeated_fail_sigs: 0,
    ...overrides,
  }
}

test('envelope.percentile: linear interpolation, unsorted input', () => {
  assert.equal(percentile([], 90), null)
  assert.equal(percentile([7], 90), 7)
  assert.equal(percentile([4, 1, 3, 2], 50), 2.5)
  assert.ok(Math.abs((percentile([1, 2, 3, 4], 90) ?? 0) - 3.7) < 1e-9)
  assert.equal(percentile([1, 2, 3, 4], 100), 4)
  assert.equal(percentile([1, 2, 3, 4], 0), 1)
})

test('envelope.coldStart: the envelope stays null until min_samples ended-green turns', () => {
  const tracker = warmTracker([8, 8, 8, 8])
  assert.equal(tracker.minSamples, DEFAULT_THRESHOLDS.envelope_min_samples)
  assert.equal(tracker.envelope, null)
  // Cold thresholds are the level base with no learned overrides at all.
  assert.deepEqual(tracker.thresholds(), { ...DEFAULT_THRESHOLDS })
  tracker.update(8, true)
  assert.equal(tracker.envelope, 10) // p90(8) * margin 1.25
  // Only resolved turns feed it; unresolved or empty turns are ignored.
  const cold = new EnvelopeTracker()
  cold.update(30, false)
  cold.update(0, true, snapshot({}))
  assert.deepEqual(cold.resolvedTurns, [])
  assert.deepEqual(cold.resolvedSnaps, [])
})

test('envelope.frozenEnvelope: a pre-registered value engages on a short stream', () => {
  const tracker = new EnvelopeTracker({ frozenEnvelope: 30 })
  assert.equal(tracker.envelope, 30)
  const thr = tracker.thresholds()
  assert.equal(thr.backstop_turns, 75)
  assert.equal(thr.min_turns, DEFAULT_THRESHOLDS.min_turns)
})

test('envelope.thresholds: learned turn-scale gates clamp to [6,base] and [8,base]', () => {
  const tracker = warmTracker([8, 8, 8, 8, 8])
  assert.equal(tracker.envelope, 10)
  const thr = tracker.thresholds()
  assert.equal(thr.gate_min_turns, 6)
  assert.equal(thr.min_turns, 8)
  assert.equal(thr.backstop_turns, 25)
  // A long-turn repository keeps the base ceilings.
  const long = warmTracker([100, 110, 90, 120, 100])
  const longThr = long.thresholds()
  assert.equal(longThr.gate_min_turns, DEFAULT_THRESHOLDS.gate_min_turns)
  assert.equal(longThr.min_turns, DEFAULT_THRESHOLDS.min_turns)
})

test('envelope.thresholds: cap-aware backstop is reachable under a tight turn cap', () => {
  const tracker = warmTracker([8, 8, 8, 8, 8])
  assert.equal(tracker.thresholds(20).backstop_turns, 18) // min(25, 0.9 * 20)
  assert.equal(tracker.thresholds(80).backstop_turns, 25)
  assert.equal(tracker.thresholds(0).backstop_turns, 25)
})

test('envelope.thresholds: learned signal gates floor on the level-scaled base', () => {
  const snaps = [
    snapshot({ edit_churn: 2, distinct_edit_files: 1, error_outputs: 1, stagnation: 0 }),
    snapshot({ edit_churn: 3, distinct_edit_files: 1, error_outputs: 2, stagnation: 0 }),
    snapshot({ edit_churn: 4, distinct_edit_files: 2, error_outputs: 3, stagnation: 0.1 }),
    snapshot({ edit_churn: 5, distinct_edit_files: 2, error_outputs: 4, stagnation: 0.2 }),
    snapshot({ edit_churn: 1, distinct_edit_files: 3, error_outputs: 5, stagnation: 0.3 }),
  ]
  const thr = warmTracker([8, 8, 8, 8, 8], snaps).thresholds()
  assert.equal(thr.edit_churn, 6) // ceil(p90 4.6 + 1) = 6 > base 4
  assert.equal(thr.distinct_edit_files, 4) // ceil(p90 2.6 + 1) = 4 > base 3
  assert.equal(thr.error_outputs, 6) // ceil(p90 4.6 + 1) = 6, floor base 6
  assert.equal(thr.gate_error_outputs, 8)
  assert.ok(Math.abs(thr.stagnation - 0.26) < 1e-9)
  // The floor holds when the learned band is lower than the level base.
  const quietSnaps = [snapshot({ edit_churn: 0 }), snapshot({ edit_churn: 0 })]
  const quiet = warmTracker([8, 8, 8, 8, 8], quietSnaps).thresholds()
  assert.equal(quiet.edit_churn, DEFAULT_THRESHOLDS.edit_churn)
  assert.equal(quiet.stagnation, DEFAULT_THRESHOLDS.stagnation)
})

test('envelope.thresholds: an aggressive level lowers the floors it learns against', () => {
  const aggressive = new EnvelopeTracker({ level: 'aggressive' })
  for (const turns of [8, 8, 8]) aggressive.update(turns, true)
  assert.equal(aggressive.envelope, 8) // margin 1.0 for the aggressive preset
  const thr = aggressive.thresholds()
  assert.equal(thr.gate_min_turns, 6)
  assert.equal(thr.min_turns, 8)
  assert.equal(thr.backstop_turns, 8 * 1.8)
})

test('envelope.loadEnvelope/saveEnvelope: round-trip through the persisted document', () => {
  const tracker = warmTracker([8, 8, 8, 8, 8], [snapshot({ edit_churn: 1 })])
  const saved = saveEnvelope(tracker)
  assert.equal(saved.level, 'default')
  assert.deepEqual(saved.resolved_turns, [8, 8, 8, 8, 8])
  assert.equal(saved.resolved_snaps.length, 1)
  const restored = loadEnvelope(JSON.parse(JSON.stringify(saved)))
  assert.deepEqual(restored.resolvedTurns, tracker.resolvedTurns)
  assert.equal(restored.envelope, tracker.envelope)
  assert.deepEqual(restored.thresholds(), tracker.thresholds())
  // `JSON.stringify(tracker)` uses toJSON directly.
  assert.deepEqual(JSON.parse(JSON.stringify(tracker)), saved)
  // Malformed documents degrade to a cold tracker instead of throwing.
  const broken = loadEnvelope({ resolved_turns: 'nope', resolved_snaps: [null, 3] })
  assert.equal(broken.envelope, null)
  assert.deepEqual(broken.resolvedSnaps, [])
})

test('envelope.saveEnvelope: history is capped at ENVELOPE_HISTORY', () => {
  const tracker = new EnvelopeTracker({ minSamples: 1 })
  for (let i = 1; i <= ENVELOPE_HISTORY + 100; i += 1) tracker.update(i, true)
  assert.equal(tracker.toJSON().resolved_turns.length, ENVELOPE_HISTORY)
  assert.equal(tracker.resolvedTurns[0], 101)
})

test('envelope.loadEnvelope: pinned envelope-shaping overrides reach the tracker', () => {
  const tracker = loadEnvelope({ resolved_turns: [10, 10, 10, 10, 10] }, {
    overrides: { envelope_margin: 2, envelope_pct: 50, envelope_min_samples: 6 },
  })
  assert.equal(tracker.margin, 2)
  assert.equal(tracker.pct, 50)
  assert.equal(tracker.minSamples, 6)
  assert.equal(tracker.envelope, null) // 5 samples < 6
  tracker.update(10, true)
  assert.equal(tracker.envelope, 20)
})

test('envelope.thresholdsFor: pinned overrides win and backstop_mult recomputes the backstop', () => {
  const tracker = warmTracker([8, 8, 8, 8, 8])
  const thr = thresholdsFor(tracker, { min_turns: 99, backstop_mult: 3, envelope_margin: 2 })
  assert.equal(thr.min_turns, 99)
  assert.equal(thr.backstop_turns, 30) // envelope 10 * pinned 3, not margin-shaped override
  assert.equal(thr.envelope_margin, DEFAULT_THRESHOLDS.envelope_margin)
  // Non-numeric pins are ignored rather than corrupting the arithmetic.
  const ignored = thresholdsFor(tracker, { min_turns: 'many', backstop_mult: 'x' })
  assert.equal(ignored.min_turns, 8)
  assert.equal(ignored.backstop_turns, 25)
})

test('envelope.baseThresholds: preset plus pinned values, before any learning', () => {
  assert.deepEqual(baseThresholds(), { ...DEFAULT_THRESHOLDS })
  const pinned = baseThresholds('aggressive', { min_turns: 99, judge_confidence: 0.9 })
  assert.equal(pinned.min_turns, 99)
  assert.equal(pinned.judge_confidence, 0.9)
  assert.equal(pinned.envelope_margin, scaledThresholds('aggressive').envelope_margin)
})

test('envelope.resolvedProxy: green unless a verification after the last edit failed', () => {
  /** @param {Partial<import('../../../lib/loopguard/envelope.js').GreenTurnView>} overrides */
  const guard = (overrides = {}) => ({
    cumTurns: 5,
    aborted: false,
    lastEdit: 3,
    lastVerify: 5,
    lastVerifyFailed: false,
    ...overrides,
  })
  assert.equal(resolvedProxy(guard()), true)
  assert.equal(resolvedProxy(guard(), false), false) // the person interrupted
  assert.equal(resolvedProxy(guard({ aborted: true })), false)
  assert.equal(resolvedProxy(guard({ cumTurns: 0 })), false)
  // A failing check after the last edit is red...
  assert.equal(resolvedProxy(guard({ lastVerifyFailed: true, lastEdit: 3, lastVerify: 5 })), false)
  // ...but a failing check BEFORE the last edit is not (the agent kept working).
  assert.equal(resolvedProxy(guard({ lastVerifyFailed: true, lastEdit: 6, lastVerify: 5 })), true)
  // Same call: not a verification after the edit.
  assert.equal(resolvedProxy(guard({ lastVerifyFailed: true, lastEdit: 5, lastVerify: 5 })), true)
})

test('envelope.recordTurn: only ended-green turns feed the envelope, with the whole snapshot', () => {
  const tracker = new EnvelopeTracker()
  /** @param {{ green: boolean }} options */
  const fakeGuard = (options) => ({
    cumTurns: 6,
    aborted: false,
    lastEdit: 3,
    lastVerify: 6,
    lastVerifyFailed: !options.green,
    whole: { snapshot: () => snapshot({ turns: 6, edit_churn: 2 }) },
  })
  recordTurn(tracker, fakeGuard({ green: false }))
  assert.deepEqual(tracker.resolvedTurns, [])
  recordTurn(tracker, fakeGuard({ green: true }))
  assert.deepEqual(tracker.resolvedTurns, [6])
  assert.equal(tracker.resolvedSnaps.length, 1)
  assert.equal(tracker.resolvedSnaps[0]?.edit_churn, 2)
})
