import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  FALLBACK_WEIGHTS,
  OVERHEAD_KEYS,
  effectiveUsage,
  fmtPercent,
  fmtTokens,
  overheadOf,
  summarize,
} from '../../../lib/usage/accounting.js'
import { overheadOf as ledgerOverheadOf } from '../../../lib/usage/ledger.js'
import { buildOverheadRecord, buildSessionRecord } from '../../../lib/usage/ledger.js'

/**
 * The summary's complete key set. Anything more (a "savings" or "percent"
 * field) would be a fabricated claim, so the test pins the exact shape.
 */
const SUMMARY_KEYS = [
  'sessions',
  'priced_sessions',
  'effective_tokens',
  'overhead_tokens',
  'overhead_frac',
  'requests',
  'nudges',
  'aborts',
  'turns',
  'injected_sessions',
]

/** @param {Record<string, unknown>} overrides */
function sessionRecord(overrides = {}) {
  return {
    kind: 'session',
    session_id: 's1',
    host: 'dsh',
    requests: 0,
    turns: 0,
    nudges: 0,
    aborts: 0,
    injected_chars: 0,
    effective_tokens: null,
    overhead: {},
    ...overrides,
  }
}

test('accounting.re-exports: the canonical overhead key set and fallback curve', () => {
  assert.equal(overheadOf, ledgerOverheadOf) // one definition, re-exported for parity
  assert.equal(OVERHEAD_KEYS.length, 6)
  assert.deepEqual(FALLBACK_WEIGHTS, { input: 1, cache_read: 0.1, cache_write: 1.25, output: 6 })
})

test('accounting.effectiveUsage: labeled effective tokens, no_usage without a breakdown', () => {
  const usage = {
    input_tokens: 100,
    cache_read_input_tokens: 1000,
    cache_creation_input_tokens: 100,
    output_tokens: 10,
  }
  assert.deepEqual(effectiveUsage({ ...usage, model: 'claude-sonnet-4-6' }), {
    effective_tokens: 375,
    priced_by: 'model',
  })
  assert.deepEqual(effectiveUsage({ ...usage, model: 'deepseek-chat' }), {
    effective_tokens: 385,
    priced_by: 'fallback',
  })
  assert.deepEqual(effectiveUsage({ model: 'deepseek-chat' }), {
    effective_tokens: null,
    priced_by: 'no_usage',
  })
})

test('accounting.summarize: observed totals only (upstream accounting.py:33-53)', () => {
  const priced = sessionRecord({
    effective_tokens: 1000,
    priced_by: 'model',
    overhead: { optimizer_tokens: 10, spiral_judge_tokens: 5 },
    requests: 3,
    turns: 2,
    nudges: 1,
    aborts: 1,
    injected_chars: 100,
  })
  const unpriced = sessionRecord({
    session_id: 's2',
    priced_by: 'no_usage',
    overhead: { spiral_nudge_writer_tokens: 7 },
    requests: 2,
    turns: 1,
  })
  const detached = buildOverheadRecord({
    sessionId: 's1',
    at: 1_700_000_000,
    overhead: { spiral_judge_tokens: 100 },
  })
  const summary = summarize([priced, unpriced, detached])
  assert.deepEqual(summary, {
    sessions: 2,
    priced_sessions: 1,
    effective_tokens: 1000,
    overhead_tokens: 122,
    overhead_frac: 122 / 1122,
    requests: 5,
    nudges: 1,
    aborts: 1,
    turns: 3,
    injected_sessions: 1,
  })
  assert.deepEqual(Object.keys(summary), SUMMARY_KEYS)
})

test('accounting.summarize: overhead records count even when their session was never folded', () => {
  const overheadOnly = buildOverheadRecord({
    sessionId: 'gone',
    at: 1,
    overhead: { spiral_judge_tokens: 1300 },
  })
  const summary = summarize([overheadOnly])
  assert.equal(summary.sessions, 0)
  assert.equal(summary.priced_sessions, 0)
  assert.equal(summary.effective_tokens, 0)
  assert.equal(summary.overhead_tokens, 1300)
  assert.equal(summary.overhead_frac, 1)
})

test('accounting.summarize: empty and malformed input yields all zeros', () => {
  for (const input of [[], null, 'nope', [null, 42, {}]]) {
    const summary = summarize(input)
    assert.equal(summary.sessions, 0)
    assert.equal(summary.priced_sessions, 0)
    assert.equal(summary.overhead_tokens, 0)
    assert.equal(summary.overhead_frac, 0)
  }
})

test('accounting.summarize: no fabricated savings, only observed fields', () => {
  const priced = sessionRecord({
    effective_tokens: 250,
    overhead: { optimizer_tokens: 50 },
  })
  const summary = summarize([priced])
  const keys = Object.keys(summary)
  assert.deepEqual(keys, SUMMARY_KEYS)
  for (const key of keys) {
    assert.doesNotMatch(key, /sav|percent|reduc|improv|worth|money|usd|currency/i)
  }
  for (const value of Object.values(summary)) assert.equal(typeof value, 'number')
  // overhead_frac is the observed overhead share, not a savings estimate.
  assert.equal(summary.overhead_frac, 50 / 300)
})

test('accounting.summarize: a session record priced by the builder participates correctly', () => {
  const record = buildSessionRecord({
    sessionId: 's3',
    model: 'deepseek-chat',
    usage: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 2 },
    overhead: { spiral_judge_tokens: 30 },
    requests: 1,
    turns: 1,
  })
  const summary = summarize([record])
  assert.equal(summary.sessions, 1)
  assert.equal(summary.priced_sessions, 1)
  assert.equal(summary.effective_tokens, 22) // fallback curve: 10 + 2 * 6
  assert.equal(summary.overhead_tokens, 30)
  assert.equal(summary.overhead_frac, 30 / 52)
})

test('accounting.fmtTokens: human token counts, n/a for unknown (upstream :56-64)', () => {
  assert.equal(fmtTokens(null), 'n/a')
  assert.equal(fmtTokens(undefined), 'n/a')
  assert.equal(fmtTokens(0), '0')
  assert.equal(fmtTokens(512), '512')
  assert.equal(fmtTokens(340_000), '340.0k')
  assert.equal(fmtTokens(1_200_000), '1.2M')
  assert.equal(fmtTokens(2_500_000_000), '2.5B')
})

test('accounting.fmtPercent: display helper for the observed fraction', () => {
  assert.equal(fmtPercent(0), '0.0%')
  assert.equal(fmtPercent(0.1234), '12.3%')
  assert.equal(fmtPercent(Number.NaN), 'n/a')
})
