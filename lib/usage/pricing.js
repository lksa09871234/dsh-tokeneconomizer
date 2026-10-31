/**
 * Cache-aware effective-token accounting.
 *
 * `tokens_total` counts EVERY token at full weight. In an agent loop the
 * conversation is re-sent each turn, so most of it is cache-read input billed at
 * a small fraction of fresh input; raw totals therefore overstate cheap cached
 * re-reads and understate expensive output. `effectiveTokens` reweights a token
 * breakdown into fresh-input-token EQUIVALENTS using provider price RATIOS
 * (input := 1.0), so cost comparisons track real spend.
 *
 * This port deliberately carries **no vendor price table and no currency
 * amounts**: embedding a snapshot of other vendors' prices is out of scope, and
 * inventing DeepSeek prices would be fabrication. The only ratio curves are the
 * upstream accounting curves (`pricing.WEIGHTS_CLAUDE`, `accounting.FALLBACK_WEIGHTS`);
 * a billed model id that is not a recognized Claude id is priced on the LABELED
 * fallback curve and the record says `priced_by: "fallback"`. Unknown stays
 * labeled unknown; nothing is silently mispriced and no currency is ever
 * reported.
 *
 * Faithful port of the accounting half of `tokeneconomizer/pricing.py` and
 * `plugin/accounting.py` (Apache-2.0 upstream, microsoft/TokenEconomizer @
 * e428fc91b0f8ffecb5a596d56b14fe2f1485a5f9). `runner_effective_or_approx` and
 * the host side-call plumbing are not ported (the DSH adapter performs side
 * calls and supplies real usage when it has it).
 *
 * @module dsh-tokeneconomizer/usage/pricing
 */

/**
 * The cache-aware weight curve: fresh-input-token equivalents per category
 * (`pricing.py:101-106`). Ratios, not currency.
 *
 * @typedef {object} TokenWeights
 * @property {number} input Fresh/uncached prompt tokens.
 * @property {number} cache_read Cached re-read input tokens.
 * @property {number} cache_write Cache-creation input tokens.
 * @property {number} output Completion/output tokens.
 */

/**
 * Claude-family price ratios (upstream `WEIGHTS_CLAUDE`), used for Claude ids and
 * — for legacy rows with no resolvable model id — as the upstream default.
 * @type {Readonly<TokenWeights>}
 */
export const WEIGHTS_CLAUDE = Object.freeze({
  input: 1.0,
  cache_read: 0.1,
  cache_write: 1.25,
  output: 5.0,
})

/**
 * The labeled fallback curve for a billed model id this build cannot price
 * (upstream `accounting.FALLBACK_WEIGHTS`): the Claude curve with a higher output
 * ratio. Records priced with it must say `priced_by: "fallback"`.
 * @type {Readonly<TokenWeights>}
 */
export const FALLBACK_WEIGHTS = Object.freeze({
  input: 1.0,
  cache_read: 0.1,
  cache_write: 1.25,
  output: 6.0,
})

/**
 * Values of the `priced_by` ledger label (`accounting.py:17-26`).
 * @type {Readonly<{model: 'model', fallback: 'fallback', noUsage: 'no_usage'}>}
 */
export const PRICED_BY = Object.freeze({
  model: 'model',
  fallback: 'fallback',
  noUsage: 'no_usage',
})

/**
 * @typedef {'model'|'fallback'|'no_usage'} PricedBy
 */

/**
 * @typedef {object} UsageRecord
 * @property {string|null} [model] Billed model id (`provider/model` router ids allowed).
 * @property {number|null} [input_tokens]
 * @property {number|null} [cache_read_input_tokens]
 * @property {number|null} [cache_creation_input_tokens]
 * @property {number|null} [output_tokens]
 * @property {number|null} [tokens_total]
 */

/**
 * @typedef {object} EffectivePrice
 * @property {number|null} effective_tokens Fresh-input-token equivalents, or null with no usage.
 * @property {PricedBy} priced_by Which curve produced the number.
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function numericOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * The billed model id for a record: its explicit `model`, with a router's
 * `provider/model` resolved to the tail (a router id names a route, not a price).
 * No per-agent defaults are needed in the DSH port (one host, one route), so an
 * absent id returns null (`pricing.py:116-132`).
 *
 * @param {unknown} record
 * @returns {string|null}
 */
export function resolveModel(record) {
  if (!isPlainObject(record)) return null
  const model = record.model
  if (typeof model !== 'string' || model.trim() === '') return null
  const id = model.trim()
  if (!id.includes('/')) return id
  const tail = id.slice(id.lastIndexOf('/') + 1)
  return tail === '' ? null : tail
}

/**
 * True when the record carries the per-task token breakdown needed for
 * cache-aware weighting (`pricing.py:163-166`).
 *
 * @param {unknown} record
 * @returns {boolean}
 */
export function hasBreakdown(record) {
  return isPlainObject(record) && record.input_tokens !== null && record.input_tokens !== undefined
}

/**
 * Pick the weight curve for a record and label where it came from.
 *
 * Resolution (`pricing.py:135-160`, adapted with a labeled fallback instead of a
 * hard error, because a user's session must still be recorded):
 *   * a `claude*` billed id            -> Claude curve, `priced_by: "model"`;
 *   * any other billed id              -> labeled fallback curve, `priced_by: "fallback"`;
 *   * no resolvable id (legacy rows)   -> Claude curve, `priced_by: "model"` (upstream
 *                                        behavior: such rows historically used it).
 *
 * @param {unknown} record
 * @returns {{ weights: TokenWeights, priced_by: PricedBy }}
 */
export function weightsFor(record) {
  const model = resolveModel(record)
  if (model === null) return { weights: WEIGHTS_CLAUDE, priced_by: PRICED_BY.model }
  return model.toLowerCase().includes('claude')
    ? { weights: WEIGHTS_CLAUDE, priced_by: PRICED_BY.model }
    : { weights: FALLBACK_WEIGHTS, priced_by: PRICED_BY.fallback }
}

/**
 * Cache-aware effective cost of one task, in fresh-input-token equivalents
 * (`pricing.py:169-186`). Uses the token breakdown when present; otherwise falls
 * back to `tokens_total` at full weight (legacy rows); 0 when neither exists.
 *
 * @param {unknown} record
 * @param {TokenWeights|null} [weights] Explicit curve (testing / comparison only).
 * @returns {number}
 */
export function effectiveTokens(record, weights = null) {
  if (!isPlainObject(record)) return 0
  const curve = weights ?? weightsFor(record).weights
  if (hasBreakdown(record)) {
    const input = numericOrZero(record.input_tokens)
    const cacheRead = numericOrZero(record.cache_read_input_tokens)
    const cacheWrite = numericOrZero(record.cache_creation_input_tokens)
    const output = numericOrZero(record.output_tokens)
    return input * curve.input
      + cacheRead * curve.cache_read
      + cacheWrite * curve.cache_write
      + output * curve.output
  }
  const total = record.tokens_total
  return typeof total === 'number' && Number.isFinite(total) ? total : 0
}

/**
 * The labeled effective-token result for a usage record
 * (upstream `plugin/accounting.effective`): `{effective_tokens: null,
 * priced_by: "no_usage"}` when there is no breakdown, else the weighted number
 * with its curve label.
 *
 * @param {unknown} record
 * @returns {EffectivePrice}
 */
export function effective(record) {
  if (!hasBreakdown(record)) return { effective_tokens: null, priced_by: PRICED_BY.noUsage }
  const { weights, priced_by } = weightsFor(record)
  return { effective_tokens: effectiveTokens(record, weights), priced_by }
}

/**
 * A character-count estimate of a text's tokens (~4 characters each;
 * `pricing.py:189-191`).
 *
 * @param {unknown} text
 * @returns {number}
 */
export function approxTokens(text) {
  return Math.max(1, Math.floor(String(text ?? '').length / 4))
}
