/**
 * One cost definition for every mechanism, plus the session-record builder.
 *
 * The cost of a task (a session, in the plugin) is the agent's EXECUTION cost
 * plus every mechanism's LLM OVERHEAD, both on the cache-aware effective basis of
 * `pricing.effectiveTokens`:
 *
 *     task_cost(t) = effective_exec(t) + overhead(t)
 *     amortized(T) = (1/T) * sum_{t<=T} task_cost(t)
 *
 * `overheadOf` sums the per-mechanism token fields a mechanism records. Every
 * field is real LLM spend made on the agent's behalf, so a mechanism that adds
 * paid proposer, judge or redirect calls pays for them in the same account as the
 * work they are meant to save. Reporting is the adapter's job; this module is
 * pure and never invents a number.
 *
 * Faithful port of `tokeneconomizer/ledger.py` and the ledger-record builder in
 * `plugin/fold.py:369-419` (Apache-2.0 upstream, microsoft/TokenEconomizer @
 * e428fc91b0f8ffecb5a596d56b14fe2f1485a5f9).
 *
 * @module dsh-tokeneconomizer/usage/ledger
 */

import {
  PRICED_BY,
  effective,
  effectiveTokens,
  weightsFor,
} from './pricing.js'

/**
 * Per-task mechanism-overhead token fields, by owning mechanism
 * (`ledger.py:19-26`). All are real mechanism-internal LLM cost that must be
 * amortized into the honest task cost.
 * @type {ReadonlyArray<string>}
 */
export const OVERHEAD_KEYS = Object.freeze([
  'optimizer_tokens', // injection: paid between-task proposer
  'untool_classify_tokens', // untooling: one-shot tool-classifier call
  'untool_judge_tokens', // untooling: per-task instruction-aware tool judge
  'codex_untool_adapt_tokens', // codex untooling: repository capability classifier
  'spiral_judge_tokens', // loop guard: paid live trace-judge
  'spiral_nudge_writer_tokens', // loop guard: targeted-nudge writer
])

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
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function numericOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * Sum every mechanism-overhead token field present on a record
 * (`ledger.py:33-35`). Non-numeric values count as zero; unknown keys are
 * ignored.
 *
 * @param {unknown} record
 * @returns {number}
 */
export function overheadOf(record) {
  if (!isPlainObject(record)) return 0
  const overhead = isPlainObject(record.overhead) ? record.overhead : record
  let total = 0
  for (const key of OVERHEAD_KEYS) total += numericOrZero(overhead[key])
  return total
}

/**
 * Cache-aware effective execution cost of a task (`ledger.py:38-40`).
 *
 * @param {unknown} record
 * @returns {number}
 */
export function effectiveExec(record) {
  return effectiveTokens(record)
}

/**
 * Accumulates the amortized cost over a stream (`ledger.py:43-74`). A thin
 * helper over the two canonical functions above, for a caller that wants a
 * running total without re-deriving the math.
 */
export class CostLedger {
  constructor() {
    /** @type {number} */
    this.cumExec = 0
    /** @type {number} */
    this.cumOverhead = 0
    /** @type {number} */
    this.n = 0
  }

  /**
   * Fold one row. `execCost` overrides the effective exec (e.g. a
   * breakdown-resolved record); defaults to this row's effective exec.
   *
   * @param {unknown} row
   * @param {number|null} [execCost]
   * @returns {number} The row's task cost.
   */
  add(row, execCost = null) {
    const exec = execCost === null ? effectiveExec(row) : execCost
    const overhead = overheadOf(row)
    this.cumExec += exec
    this.cumOverhead += overhead
    this.n += 1
    return exec + overhead
  }

  /** @returns {number} */
  get cumTotal() {
    return this.cumExec + this.cumOverhead
  }

  /** @returns {number} */
  get amortizedPerTask() {
    return this.n > 0 ? this.cumTotal / this.n : 0
  }

  /** @returns {number} */
  get overheadFrac() {
    return this.cumTotal > 0 ? this.cumOverhead / this.cumTotal : 0
  }
}

/**
 * Host-neutral usage categories as the DSH adapter accumulates them
 * (`lib/dsh/session-accumulator.js`).
 *
 * @typedef {object} UsageCategories
 * @property {number} [inputTokens]
 * @property {number} [cacheReadTokens]
 * @property {number} [cacheWriteTokens]
 * @property {number} [outputTokens]
 * @property {number} [reasoningTokens] Recorded for transparency only; never priced.
 * @property {number} [totalTokens]
 */

/**
 * @typedef {object} SessionRecordInput
 * @property {string} sessionId
 * @property {string} [host] Defaults to `"dsh"`.
 * @property {string} [repo] Repository label (never a raw absolute path).
 * @property {string|null} [model] Billed model id used for pricing.
 * @property {UsageCategories|null} [usage] Session token totals; null/absent means no_usage.
 * @property {number|null} [prompts] Host-reported prompt count (null when unknown).
 * @property {number} [requests] Model requests.
 * @property {number} [turns] Completed prompt-turns.
 * @property {number} [nudges] Loop-guard redirects delivered.
 * @property {number} [aborts] Loop-guard notices delivered.
 * @property {number} [injectedChars] Characters injected as learned context.
 * @property {{ optimizer_tokens?: number, rendered_chars?: number }|null} [injection]
 * @property {{ proposal?: string[], pending?: boolean, restored?: string[] }|null} [untool]
 * @property {string[]} [untoolApplied] Tool names the plugin pruned.
 * @property {Record<string, number>} [overhead] Per-mechanism token costs.
 * @property {boolean} [shadow] Compute-only session.
 * @property {number|null} [started] Unix seconds.
 * @property {number|null} [ended] Unix seconds.
 * @property {number} [foldedAt] Unix seconds; defaults to now.
 * @property {string} [error] Present only on a failed fold.
 */

/**
 * @typedef {object} LedgerRecord
 * @property {'session'|'overhead'} kind
 * @property {string} [session_id]
 * @property {string} [host]
 * @property {string} [repo]
 * @property {string|null} [model]
 * @property {number} [folded_at]
 * @property {number|null} [started]
 * @property {number|null} [ended]
 * @property {number|null} [at] Unix seconds (overhead records).
 * @property {unknown} [job] Background job id (overhead records).
 * @property {boolean} [shadow]
 * @property {number|null} [prompts]
 * @property {string} [error]
 * @property {{ optimizer_tokens: number, rendered_chars: number }} [injection]
 * @property {{ proposal: string[], pending: boolean, restored: string[] }} [untool]
 * @property {number} [requests]
 * @property {number|null} [input_tokens]
 * @property {number|null} [cache_read_input_tokens]
 * @property {number|null} [cache_creation_input_tokens]
 * @property {number|null} [output_tokens]
 * @property {number|null} [tokens_total]
 * @property {number|null} [effective_tokens]
 * @property {import('./pricing.js').PricedBy} [priced_by]
 * @property {number} [turns]
 * @property {number} [nudges]
 * @property {number} [aborts]
 * @property {number} [injected_chars]
 * @property {string[]} [untool_applied]
 * @property {Record<string, number>} [overhead]
 */

/**
 * Zeroed overhead object over the canonical key set, with any supplied numbers
 * laid on top. Values are clamped to finite non-negative numbers.
 *
 * @param {unknown} overhead
 * @returns {Record<string, number>}
 */
export function normalizeOverhead(overhead) {
  /** @type {Record<string, number>} */
  const out = {}
  for (const key of OVERHEAD_KEYS) out[key] = 0
  if (!isPlainObject(overhead)) return out
  for (const [key, value] of Object.entries(overhead)) {
    if (!Object.hasOwn(out, key)) continue // canonical key set only
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = Math.max(0, value)
  }
  return out
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function nonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Build one `kind: "session"` ledger record (`plugin/fold.py:369-419`, schema in
 * UPSTREAM §6.3). The effective-token fields come from `pricing.effective`, so
 * the label and the number can never disagree.
 *
 * @param {SessionRecordInput} input
 * @returns {LedgerRecord}
 */
export function buildSessionRecord(input) {
  const usage = isPlainObject(input.usage) ? input.usage : null
  const hasUsage = usage !== null && typeof usage.inputTokens === 'number'
  /** @type {LedgerRecord} */
  const record = {
    kind: 'session',
    session_id: String(input.sessionId),
    host: input.host ?? 'dsh',
    repo: input.repo ?? '',
    folded_at: numericOr(input.foldedAt, Date.now() / 1000),
    started: typeof input.started === 'number' ? input.started : null,
    ended: typeof input.ended === 'number' ? input.ended : null,
    shadow: input.shadow === true,
    prompts: isPlainObject(input) && typeof input.prompts === 'number' ? input.prompts : null,
    injection: {
      optimizer_tokens: numericOr(
        isPlainObject(input.injection) ? input.injection.optimizer_tokens : 0,
        0,
      ),
      rendered_chars: numericOr(
        isPlainObject(input.injection) ? input.injection.rendered_chars : 0,
        0,
      ),
    },
    untool: {
      proposal: isPlainObject(input.untool) && Array.isArray(input.untool.proposal)
        ? input.untool.proposal.map((name) => String(name))
        : [],
      pending: isPlainObject(input.untool) ? input.untool.pending === true : false,
      restored: isPlainObject(input.untool) && Array.isArray(input.untool.restored)
        ? input.untool.restored.map((name) => String(name))
        : [],
    },
    model: resolveModelForRecord(input),
    requests: nonNegative(input.requests),
    input_tokens: hasUsage ? nonNegative(usage?.inputTokens) : null,
    cache_read_input_tokens: hasUsage ? nonNegative(usage?.cacheReadTokens) : null,
    cache_creation_input_tokens: hasUsage ? nonNegative(usage?.cacheWriteTokens) : null,
    output_tokens: hasUsage ? nonNegative(usage?.outputTokens) : null,
    effective_tokens: null,
    priced_by: PRICED_BY.noUsage,
    turns: nonNegative(input.turns),
    nudges: nonNegative(input.nudges),
    aborts: nonNegative(input.aborts),
    injected_chars: nonNegative(input.injectedChars),
    untool_applied: Array.isArray(input.untoolApplied)
      ? input.untoolApplied.map((name) => String(name))
      : [],
    overhead: normalizeOverhead(input.overhead),
  }
  if (hasUsage && isPlainObject(usage) && typeof usage.totalTokens === 'number') {
    record.tokens_total = nonNegative(usage.totalTokens)
  }
  if (input.error !== undefined) record.error = String(input.error)
  const priced = effective(record)
  record.effective_tokens = priced.effective_tokens
  record.priced_by = priced.priced_by
  // `injection.optimizer_tokens` is the same spend as `overhead.optimizer_tokens`:
  // surface it there so the overhead total is complete even when a caller passes
  // only the injection block.
  if (record.overhead && record.overhead.optimizer_tokens === 0) {
    const fromInjection = numericOr(record.injection?.optimizer_tokens, 0)
    if (fromInjection > 0) record.overhead.optimizer_tokens = fromInjection
  }
  return record
}

/**
 * Build one `kind: "overhead"` ledger record for a paid call whose session had
 * already ended (upstream `plugin/judge.py:92-94`).
 *
 * @param {{ sessionId?: string, host?: string, repo?: string, job?: unknown,
 *   at?: number, overhead: Record<string, number> }} input
 * @returns {LedgerRecord}
 */
export function buildOverheadRecord(input) {
  /** @type {LedgerRecord} */
  const record = {
    kind: 'overhead',
    session_id: String(input.sessionId ?? ''),
    host: input.host ?? 'dsh',
    repo: input.repo ?? '',
    at: numericOr(input.at, Date.now() / 1000),
    overhead: normalizeOverhead(input.overhead),
  }
  if (input.job !== undefined) record.job = input.job
  return record
}

/**
 * @param {SessionRecordInput} input
 * @returns {string|null}
 */
function resolveModelForRecord(input) {
  if (typeof input.model !== 'string' || input.model.trim() === '') return null
  const id = input.model.trim()
  return id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id
}

/**
 * @typedef {object} RecordValidation
 * @property {boolean} ok
 * @property {string[]} errors
 */

/**
 * Validate one ledger record against the §6.3 schema. Tolerant of extra fields
 * (a newer adapter may add them) but strict about the fields the accounting
 * reads: a wrong kind or a non-numeric cost would corrupt the summary silently.
 *
 * @param {unknown} record
 * @returns {RecordValidation}
 */
export function validateRecord(record) {
  /** @type {string[]} */
  const errors = []
  if (!isPlainObject(record)) return { ok: false, errors: ['record is not an object'] }
  const kind = record.kind
  if (kind !== 'session' && kind !== 'overhead') {
    errors.push(`kind must be "session" or "overhead" (got ${JSON.stringify(kind)})`)
  }
  if (typeof record.session_id !== 'string' || record.session_id === '') {
    errors.push('session_id must be a non-empty string')
  }
  if (Object.hasOwn(record, 'overhead')) {
    if (!isPlainObject(record.overhead)) {
      errors.push('overhead must be an object')
    } else {
      for (const [key, value] of Object.entries(record.overhead)) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
          errors.push(`overhead.${key} must be a finite non-negative number`)
        }
      }
    }
  }
  for (const key of [
    'input_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
    'output_tokens',
    'tokens_total',
    'effective_tokens',
  ]) {
    const value = record[key]
    if (value === undefined || value === null) continue
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(`${key} must be a number or null`)
    }
  }
  if (Object.hasOwn(record, 'priced_by')) {
    const label = record.priced_by
    if (label !== 'model' && label !== 'fallback' && label !== 'no_usage' && label !== null) {
      errors.push('priced_by must be "model", "fallback", "no_usage", or null')
    }
  }
  for (const key of ['requests', 'turns', 'nudges', 'aborts', 'injected_chars']) {
    const value = record[key]
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      errors.push(`${key} must be a finite non-negative number`)
    }
  }
  return { ok: errors.length === 0, errors }
}

/**
 * @typedef {object} MergeResult
 * @property {LedgerRecord[]} records Existing records, then new unique records.
 * @property {number} added How many incoming records were appended.
 * @property {number} skipped How many incoming records duplicated an existing one.
 */

/**
 * Merge a batch of records into an existing list, dropping duplicates by a stable
 * identity so a retried fold cannot double-count a session (`folded.json`
 * idempotency lives in the adapter, but this keeps the ledger itself honest).
 * Identity defaults to `kind:session_id:folded_at` (or `kind:session_id:at` for
 * overhead records); callers may pass their own `dedupeBy`.
 *
 * @param {unknown} existing
 * @param {unknown} incoming
 * @param {{ dedupeBy?: (record: LedgerRecord) => string }} [options]
 * @returns {MergeResult}
 */
export function mergeRecords(existing, incoming, options = {}) {
  const dedupeBy = options.dedupeBy ?? defaultDedupeKey
  /** @type {LedgerRecord[]} */
  const out = []
  /** @type {Set<string>} */
  const seen = new Set()
  for (const record of toRecordArray(existing)) {
    out.push(record)
    seen.add(dedupeBy(record))
  }
  let added = 0
  let skipped = 0
  for (const record of toRecordArray(incoming)) {
    const key = dedupeBy(record)
    if (seen.has(key)) {
      skipped += 1
      continue
    }
    seen.add(key)
    out.push(record)
    added += 1
  }
  return { records: out, added, skipped }
}

/**
 * @param {LedgerRecord} record
 * @returns {string}
 */
function defaultDedupeKey(record) {
  const id = record.session_id ?? ''
  const time = record.folded_at ?? record.at ?? ''
  return `${record.kind}:${id}:${time}`
}

/**
 * @param {unknown} value
 * @returns {LedgerRecord[]}
 */
function toRecordArray(value) {
  if (!Array.isArray(value)) return []
  return value.filter(isPlainObject).map((record) => /** @type {LedgerRecord} */ (record))
}

/**
 * Whether the record is priced (has a numeric `effective_tokens`), mirroring the
 * upstream summary's `isinstance(..., (int, float))` test.
 *
 * @param {unknown} record
 * @returns {boolean}
 */
export function isPriced(record) {
  return isPlainObject(record)
    && typeof record.effective_tokens === 'number'
    && Number.isFinite(record.effective_tokens)
}

/**
 * The weight curve label a session record would receive, for adapter logging.
 *
 * @param {unknown} record
 * @returns {import('./pricing.js').PricedBy}
 */
export function priceLabelFor(record) {
  return weightsFor(record).priced_by
}
