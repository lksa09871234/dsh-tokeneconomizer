import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as pricing from '../../../lib/usage/pricing.js'
import {
  FALLBACK_WEIGHTS,
  PRICED_BY,
  WEIGHTS_CLAUDE,
  approxTokens,
  effective,
  effectiveTokens,
  hasBreakdown,
  resolveModel,
  weightsFor,
} from '../../../lib/usage/pricing.js'

test('pricing.weights: the cached-input curves are ratios, not currency', () => {
  assert.deepEqual(WEIGHTS_CLAUDE, { input: 1.0, cache_read: 0.1, cache_write: 1.25, output: 5.0 })
  assert.deepEqual(FALLBACK_WEIGHTS, { input: 1.0, cache_read: 0.1, cache_write: 1.25, output: 6.0 })
  // No vendor price table and no currency/amount surface exists in the module.
  const exported = Object.keys(pricing)
  assert.deepEqual(exported.filter((name) => /usd|currency|dollar|cent|amount|vendor/i.test(name)), [])
  assert.deepEqual(PRICED_BY, { model: 'model', fallback: 'fallback', noUsage: 'no_usage' })
})

test('pricing.resolveModel: explicit id, router tail, or null', () => {
  assert.equal(resolveModel({ model: 'claude-sonnet-4-6' }), 'claude-sonnet-4-6')
  assert.equal(resolveModel({ model: 'openrouter/anthropic/claude-haiku-4-5' }), 'claude-haiku-4-5')
  assert.equal(resolveModel({ model: '  deepseek-chat  ' }), 'deepseek-chat')
  assert.equal(resolveModel({ model: '' }), null)
  assert.equal(resolveModel({ model: 'openrouter/' }), null)
  assert.equal(resolveModel({}), null)
  assert.equal(resolveModel(null), null)
})

test('pricing.weightsFor: Claude ids are model-priced, unknown ids are labeled fallback', () => {
  assert.deepEqual(weightsFor({ model: 'claude-opus-4-6' }), {
    weights: WEIGHTS_CLAUDE,
    priced_by: 'model',
  })
  // A recognized-but-unpriced id (and DeepSeek ids) gets the labeled fallback,
  // never a silently invented price.
  assert.deepEqual(weightsFor({ model: 'deepseek-chat' }), {
    weights: FALLBACK_WEIGHTS,
    priced_by: 'fallback',
  })
  assert.equal(weightsFor({ model: 'gpt-5.4' }).priced_by, 'fallback')
  // Legacy rows without a model id keep upstream's historical Claude curve.
  assert.deepEqual(weightsFor({}), { weights: WEIGHTS_CLAUDE, priced_by: 'model' })
})

test('pricing.hasBreakdown: input_tokens present, even when zero', () => {
  assert.equal(hasBreakdown({ input_tokens: 0 }), true)
  assert.equal(hasBreakdown({ input_tokens: null }), false)
  assert.equal(hasBreakdown({}), false)
  assert.equal(hasBreakdown(null), false)
})

test('pricing.effectiveTokens: cache-aware breakdown on the Claude curve', () => {
  const record = {
    input_tokens: 100,
    cache_read_input_tokens: 1000,
    cache_creation_input_tokens: 100,
    output_tokens: 10,
  }
  assert.equal(effectiveTokens(record), 100 * 1.0 + 1000 * 0.1 + 100 * 1.25 + 10 * 5.0)
  assert.equal(effectiveTokens(record), 375)
  // Explicit weights override the curve for comparison work only.
  assert.equal(
    effectiveTokens(record, { input: 1, cache_read: 0, cache_write: 0, output: 0 }),
    100,
  )
  // Missing categories count as zero, not as errors.
  assert.equal(effectiveTokens({ input_tokens: 100 }), 100)
})

test('pricing.effectiveTokens: a fallback-priced model uses the labeled curve (output 6.0)', () => {
  const record = {
    model: 'deepseek-chat',
    input_tokens: 100,
    cache_read_input_tokens: 1000,
    cache_creation_input_tokens: 100,
    output_tokens: 10,
  }
  assert.equal(effectiveTokens(record), 385) // 60 for output instead of 50
})

test('pricing.effectiveTokens: legacy total fallback and no-usage zero', () => {
  assert.equal(effectiveTokens({ tokens_total: 777 }), 777)
  assert.equal(effectiveTokens({}), 0)
  assert.equal(effectiveTokens(null), 0)
  assert.equal(effectiveTokens({ tokens_total: 'x' }), 0)
})

test('pricing.effective: labeled result with model|fallback|no_usage', () => {
  const usage = { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 2 }
  assert.deepEqual(effective({ model: 'claude-sonnet-4-6', ...usage }), {
    effective_tokens: 20,
    priced_by: 'model',
  })
  assert.deepEqual(effective({ model: 'deepseek-chat', ...usage }), {
    effective_tokens: 22,
    priced_by: 'fallback',
  })
  assert.deepEqual(effective({ model: 'deepseek-chat' }), {
    effective_tokens: null,
    priced_by: 'no_usage',
  })
  // The number and its label can never be recomputed independently.
  const priced = effective({ model: 'deepseek-chat', ...usage })
  assert.equal(priced.priced_by, weightsFor({ model: 'deepseek-chat' }).priced_by)
})

test('pricing.approxTokens: ~4 characters per token, minimum 1', () => {
  assert.equal(approxTokens(''), 1)
  assert.equal(approxTokens('abc'), 1)
  assert.equal(approxTokens('abcd'), 1)
  assert.equal(approxTokens('a'.repeat(400)), 100)
  assert.equal(approxTokens(null), 1)
})
