import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CostLedger,
  OVERHEAD_KEYS,
  buildOverheadRecord,
  buildSessionRecord,
  effectiveExec,
  isPriced,
  mergeRecords,
  normalizeOverhead,
  overheadOf,
  priceLabelFor,
  validateRecord,
} from '../../../lib/usage/ledger.js'

/** A complete session-record input, as the DSH adapter would build it. */
function sessionInput(overrides = {}) {
  return {
    sessionId: 's1',
    host: 'dsh',
    repo: 'owner/repo',
    model: 'claude-sonnet-4-6',
    usage: {
      inputTokens: 100,
      cacheReadTokens: 1000,
      cacheWriteTokens: 100,
      outputTokens: 10,
      reasoningTokens: 5,
      totalTokens: 1210,
    },
    prompts: 4,
    requests: 12,
    turns: 3,
    nudges: 1,
    aborts: 0,
    injectedChars: 250,
    injection: { optimizer_tokens: 30, rendered_chars: 250 },
    untool: { proposal: ['Notebook'], pending: false, restored: [] },
    untoolApplied: ['Notebook'],
    overhead: { optimizer_tokens: 30, spiral_judge_tokens: 12 },
    shadow: false,
    started: 1_700_000_000,
    ended: 1_700_000_500,
    foldedAt: 1_700_000_600,
    ...overrides,
  }
}

test('ledger.overheadOf: sums only the known mechanism keys (upstream test_ledger.py:6-9)', () => {
  const row = {
    optimizer_tokens: 10,
    spiral_judge_tokens: 5,
    untool_judge_tokens: 3,
    not_an_overhead_key: 999,
  }
  assert.equal(overheadOf(row), 18)
})

test('ledger.overheadOf: ignores non-numeric values (upstream :12-13)', () => {
  assert.equal(overheadOf({ optimizer_tokens: null, spiral_judge_tokens: 'x' }), 0)
  assert.equal(overheadOf({ overhead: { optimizer_tokens: null } }), 0)
  assert.equal(overheadOf(null), 0)
})

test('ledger.overheadOf: every overhead key counts (upstream :16-18)', () => {
  /** @type {Record<string, number>} */
  const row = {}
  for (const key of OVERHEAD_KEYS) row[key] = 1
  assert.equal(overheadOf(row), OVERHEAD_KEYS.length)
  assert.equal(OVERHEAD_KEYS.length, 6)
  assert.deepEqual([...OVERHEAD_KEYS], [
    'optimizer_tokens',
    'untool_classify_tokens',
    'untool_judge_tokens',
    'codex_untool_adapt_tokens',
    'spiral_judge_tokens',
    'spiral_nudge_writer_tokens',
  ])
})

test('ledger.effectiveExec: cache-aware breakdown (upstream :21-26)', () => {
  const row = {
    input_tokens: 100,
    cache_read_input_tokens: 1000,
    cache_creation_input_tokens: 0,
    output_tokens: 10,
  }
  assert.equal(effectiveExec(row), 100 * 1.0 + 1000 * 0.1 + 10 * 5.0)
})

test('ledger.effectiveExec: falls back to tokens_total (upstream :29-30)', () => {
  assert.equal(effectiveExec({ tokens_total: 777 }), 777)
  assert.equal(effectiveExec({}), 0)
})

test('ledger.CostLedger: amortizes execution + overhead (upstream :33-40)', () => {
  const ledger = new CostLedger()
  ledger.add({ tokens_total: 100, optimizer_tokens: 20 })
  ledger.add({ tokens_total: 200 })
  assert.equal(ledger.cumExec, 300)
  assert.equal(ledger.cumOverhead, 20)
  assert.equal(ledger.cumTotal, 320)
  assert.equal(ledger.amortizedPerTask, 160)
  assert.ok(ledger.overheadFrac > 0 && ledger.overheadFrac < 1)
  assert.equal(ledger.overheadFrac, 20 / 320)
  // execCost overrides the row's own effective exec.
  const override = new CostLedger()
  assert.equal(override.add({ tokens_total: 100 }, 40), 40)
  assert.equal(new CostLedger().amortizedPerTask, 0)
})

test('ledger.buildSessionRecord: the §6.3 session schema', () => {
  const record = buildSessionRecord(sessionInput())
  assert.equal(record.kind, 'session')
  assert.equal(record.session_id, 's1')
  assert.equal(record.host, 'dsh')
  assert.equal(record.repo, 'owner/repo')
  assert.equal(record.model, 'claude-sonnet-4-6')
  assert.equal(record.folded_at, 1_700_000_600)
  assert.equal(record.started, 1_700_000_000)
  assert.equal(record.ended, 1_700_000_500)
  assert.equal(record.shadow, false)
  assert.equal(record.prompts, 4)
  assert.equal(record.requests, 12)
  assert.deepEqual(
    {
      input: record.input_tokens,
      cache_read: record.cache_read_input_tokens,
      cache_write: record.cache_creation_input_tokens,
      output: record.output_tokens,
      total: record.tokens_total,
    },
    { input: 100, cache_read: 1000, cache_write: 100, output: 10, total: 1210 },
  )
  assert.equal(record.effective_tokens, 375)
  assert.equal(record.priced_by, 'model')
  assert.equal(record.turns, 3)
  assert.equal(record.nudges, 1)
  assert.equal(record.aborts, 0)
  assert.equal(record.injected_chars, 250)
  assert.deepEqual(record.untool_applied, ['Notebook'])
  assert.deepEqual(record.injection, { optimizer_tokens: 30, rendered_chars: 250 })
  assert.deepEqual(record.untool, { proposal: ['Notebook'], pending: false, restored: [] })
  assert.equal(record.overhead?.optimizer_tokens, 30)
  assert.equal(record.overhead?.spiral_judge_tokens, 12)
  assert.deepEqual(validateRecord(record), { ok: true, errors: [] })
})

test('ledger.buildSessionRecord: unpriced models are labeled fallback, never invented', () => {
  const record = buildSessionRecord(sessionInput({ model: 'deepseek-chat' }))
  assert.equal(record.priced_by, 'fallback')
  assert.equal(record.effective_tokens, 385) // output weight 6.0
  assert.equal(priceLabelFor(record), 'fallback')
  const unknownNoId = buildSessionRecord(sessionInput({ model: null }))
  assert.equal(unknownNoId.priced_by, 'model') // upstream legacy: no id -> Claude curve
  assert.equal(unknownNoId.effective_tokens, 375)
})

test('ledger.buildSessionRecord: no usage reports no_usage instead of a zero cost', () => {
  const record = buildSessionRecord(sessionInput({ usage: null }))
  assert.equal(record.effective_tokens, null)
  assert.equal(record.priced_by, 'no_usage')
  assert.equal(record.input_tokens, null)
  assert.equal(record.output_tokens, null)
  assert.equal(isPriced(record), false)
  // A usage block with no input count is treated the same way.
  const partial = buildSessionRecord(sessionInput({ usage: { outputTokens: 5 } }))
  assert.equal(partial.priced_by, 'no_usage')
})

test('ledger.buildSessionRecord: overhead is the six-key canonical set', () => {
  const record = buildSessionRecord(sessionInput({ overhead: { spiral_judge_tokens: 7, bogus: 5 } }))
  assert.deepEqual(Object.keys(record.overhead ?? {}).sort(), [...OVERHEAD_KEYS].sort())
  assert.equal(record.overhead?.spiral_judge_tokens, 7)
  assert.equal(record.overhead?.bogus, undefined)
  // injection.optimizer_tokens surfaces into the overhead account when not given twice.
  const fromInjection = buildSessionRecord(sessionInput({
    overhead: undefined,
    injection: { optimizer_tokens: 11, rendered_chars: 0 },
  }))
  assert.equal(fromInjection.overhead?.optimizer_tokens, 11)
  assert.equal(overheadOf(fromInjection), 11)
})

test('ledger.buildSessionRecord: a failed fold carries its error string', () => {
  const record = buildSessionRecord(sessionInput({ usage: null, error: 'transcript unreadable' }))
  assert.equal(record.error, 'transcript unreadable')
})

test('ledger.buildOverheadRecord: a detached paid call is its own record', () => {
  const record = buildOverheadRecord({
    sessionId: 's1',
    host: 'dsh',
    repo: 'owner/repo',
    job: 'job-7',
    at: 1_700_000_700,
    overhead: { spiral_judge_tokens: 1300 },
  })
  assert.equal(record.kind, 'overhead')
  assert.equal(record.session_id, 's1')
  assert.equal(record.job, 'job-7')
  assert.equal(record.at, 1_700_000_700)
  assert.equal(overheadOf(record), 1300)
  assert.deepEqual(validateRecord(record), { ok: true, errors: [] })
})

test('ledger.normalizeOverhead: finite non-negative numbers over the canonical key set', () => {
  const normalized = normalizeOverhead({ optimizer_tokens: 3, spiral_judge_tokens: -1, bad: 'x' })
  assert.deepEqual(Object.keys(normalized).sort(), [...OVERHEAD_KEYS].sort())
  assert.equal(normalized.optimizer_tokens, 3)
  assert.equal(normalized.spiral_judge_tokens, 0) // negative clamped
  assert.equal(normalized.bad, undefined)
})

test('ledger.validateRecord: rejects records that would corrupt the summary silently', () => {
  const good = buildSessionRecord(sessionInput())
  assert.equal(validateRecord(good).ok, true)
  assert.equal(validateRecord(null).ok, false)
  assert.equal(validateRecord({ kind: 'other', session_id: 'x' }).ok, false)
  assert.equal(validateRecord({ kind: 'session', session_id: '' }).ok, false)
  assert.equal(
    validateRecord({ kind: 'session', session_id: 'x', overhead: { optimizer_tokens: '3' } }).ok,
    false,
  )
  assert.equal(
    validateRecord({ kind: 'session', session_id: 'x', effective_tokens: 'NaN' }).ok,
    false,
  )
  assert.equal(
    validateRecord({ kind: 'session', session_id: 'x', priced_by: 'guess' }).ok,
    false,
  )
  assert.equal(validateRecord({ kind: 'session', session_id: 'x', requests: -1 }).ok, false)
  assert.equal(validateRecord({ kind: 'session', session_id: 'x', turns: 2 }).ok, true)
})

test('ledger.mergeRecords: a retried fold cannot double-count a session', () => {
  const first = buildSessionRecord(sessionInput())
  const second = buildSessionRecord(sessionInput({ sessionId: 's2', foldedAt: 1_700_000_601 }))
  const result = mergeRecords([first], [first, second])
  assert.equal(result.records.length, 2)
  assert.equal(result.added, 1)
  assert.equal(result.skipped, 1)
  // A fresh list starts empty; malformed batches are ignored.
  assert.deepEqual(mergeRecords(null, [first]), { records: [first], added: 1, skipped: 0 })
  assert.deepEqual(mergeRecords([first], 'nope'), { records: [first], added: 0, skipped: 0 })
  // A caller can choose its own identity.
  const bySession = mergeRecords([first], [second], { dedupeBy: (record) => String(record.session_id) })
  assert.equal(bySession.added, 1)
  assert.equal(mergeRecords([first], [first], { dedupeBy: () => 'same' }).skipped, 1)
})
