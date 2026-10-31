/**
 * The session ledger summary: what each session cost, on the cache-aware basis,
 * and what the plugin itself spent.
 *
 * Cost is `pricing.effectiveTokens` — fresh-input-token equivalents with cached
 * re-reads at their billed fraction — plus every mechanism-overhead field
 * `OVERHEAD_KEYS` names, exactly the amortized definition the upstream results
 * tables use. One live-only allowance: a session must be recorded even when its
 * billed model id is not recognized, so an unpriced id is priced on a LABELED
 * fallback curve and the record says `priced_by: "fallback"`.
 *
 * **No fabricated savings.** This summary reports observed totals only: session
 * count, priced sessions, effective tokens, overhead tokens and fraction,
 * requests, nudges, aborts, turns, injected sessions. It has no "savings",
 * "percent saved", or counterfactual field — by design (upstream CLAUDE.md: the
 * plugin's text makes no claims of effect).
 *
 * Faithful port of `tokeneconomizer/plugin/accounting.py` (Apache-2.0 upstream,
 * microsoft/TokenEconomizer @ e428fc91b0f8ffecb5a596d56b14fe2f1485a5f9).
 *
 * @module dsh-tokeneconomizer/usage/accounting
 */

import {
  FALLBACK_WEIGHTS,
  effective,
} from './pricing.js'
import {
  OVERHEAD_KEYS,
  isPriced,
  overheadOf,
} from './ledger.js'

export { FALLBACK_WEIGHTS, OVERHEAD_KEYS, overheadOf }

/**
 * @typedef {import('./ledger.js').LedgerRecord} LedgerRecord
 * @typedef {import('./pricing.js').PricedBy} PricedBy
 */

/**
 * @typedef {object} LedgerSummary
 * @property {number} sessions `kind: "session"` records.
 * @property {number} priced_sessions Sessions with a numeric effective_tokens.
 * @property {number} effective_tokens Sum of priced sessions' effective tokens.
 * @property {number} overhead_tokens Sum of mechanism-overhead tokens (session + overhead records).
 * @property {number} overhead_frac overhead / (exec + overhead), 0 when both are 0.
 * @property {number} requests Summed model requests over sessions.
 * @property {number} nudges Summed loop-guard redirects over sessions.
 * @property {number} aborts Summed loop-guard notices over sessions.
 * @property {number} turns Summed prompt-turns over sessions.
 * @property {number} injected_sessions Sessions that injected learned context.
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * `(effective_tokens, priced_by)` for a usage breakdown; `(null, "no_usage")`
 * without one (`accounting.py:17-26`). Accepts either snake_case record fields
 * (ledger records) or a record with only `input_tokens` populated.
 *
 * @param {unknown} usage
 * @returns {{ effective_tokens: number|null, priced_by: PricedBy }}
 */
export function effectiveUsage(usage) {
  return effective(usage)
}

/**
 * Aggregate ledger records into the numbers a status command prints
 * (`accounting.py:33-53`).
 *
 * Only `kind: "session"` records count toward sessions/requests/nudges/aborts/
 * turns, and only priced sessions contribute execution totals. Overhead is
 * counted from both `session` and `overhead` records: an overhead record is a
 * paid call charged as it happened, so a call that outlived its session's fold is
 * still in the account.
 *
 * @param {unknown} records
 * @returns {LedgerSummary}
 */
export function summarize(records) {
  const list = Array.isArray(records) ? records.filter(isPlainObject) : []
  const sessions = list.filter((record) => record.kind === 'session')
  const priced = sessions.filter(isPriced)
  let effectiveTokens = 0
  for (const record of priced) effectiveTokens += Number(record.effective_tokens)
  let overheadTokens = 0
  for (const record of list) {
    if (record.kind === 'session' || record.kind === 'overhead') {
      overheadTokens += overheadOf(record)
    }
  }
  let requests = 0
  let nudges = 0
  let aborts = 0
  let turns = 0
  let injectedSessions = 0
  for (const record of sessions) {
    requests += integerOrZero(record.requests)
    nudges += integerOrZero(record.nudges)
    aborts += integerOrZero(record.aborts)
    turns += integerOrZero(record.turns)
    if (record.injected_chars) injectedSessions += 1
  }
  const total = effectiveTokens + overheadTokens
  return {
    sessions: sessions.length,
    priced_sessions: priced.length,
    effective_tokens: effectiveTokens,
    overhead_tokens: overheadTokens,
    overhead_frac: total > 0 ? overheadTokens / total : 0,
    requests,
    nudges,
    aborts,
    turns,
    injected_sessions: injectedSessions,
  }
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function integerOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0
}

/**
 * A token count as a person reads it: `1.2M`, `340k`, `512`; `n/a` for null
 * (`accounting.py:56-64`). A display helper only — never used to derive a claim.
 *
 * @param {number|null|undefined} value
 * @returns {string}
 */
export function fmtTokens(value) {
  if (value === null || value === undefined) return 'n/a'
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 0
  /** @type {Array<[string, number]>} */
  const units = [
    ['B', 1e9],
    ['M', 1e6],
    ['k', 1e3],
  ]
  for (const [unit, divisor] of units) {
    if (Math.abs(n) >= divisor) return `${(n / divisor).toFixed(1)}${unit}`
  }
  return `${Math.round(n)}`
}

/**
 * `1` for the fraction `overhead_frac` as a percentage string, e.g.
 * `"12.3%"`; the adapter decides whether to show it. Purely a formatting helper:
 * the value itself is observed, never a savings estimate.
 *
 * @param {number} fraction
 * @returns {string}
 */
export function fmtPercent(fraction) {
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return 'n/a'
  return `${(fraction * 100).toFixed(1)}%`
}
