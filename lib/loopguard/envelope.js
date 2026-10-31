/**
 * The per-repository envelope: how long a turn that ended well usually runs.
 *
 * `EnvelopeTracker` learns, from turns that ended well only, a percentile of
 * their lengths (the envelope past which a stuck trajectory may be acted on) and
 * the detector thresholds on top of the preset level. A turn's own outcome only
 * ever gates LATER turns.
 *
 * Faithful port of `tokeneconomizer/loopguard/envelope.py` (Apache-2.0 upstream,
 * microsoft/TokenEconomizer @ e428fc91b0f8ffecb5a596d56b14fe2f1485a5f9).
 * Persistence is the adapter's job: this module is pure JSON in/out
 * (`loadEnvelope` / `saveEnvelope` / `recordTurn`), and every timestamp the
 * adapter might add stays outside it.
 *
 * @module dsh-tokeneconomizer/loopguard/envelope
 */

import { scaledThresholds } from './rules.js'

/** Recent ended-green turns kept for the percentile (`envelope.py:148`). */
export const ENVELOPE_HISTORY = 500

/**
 * Overrides that shape the envelope itself (passed to the tracker); every other
 * pinned `loopguard.*` value is applied over the threshold dict it returns.
 * @type {Readonly<Record<string, 'margin'|'pct'|'minSamples'>>}
 */
export const ENVELOPE_OVERRIDE_KEYS = Object.freeze({
  envelope_margin: 'margin',
  envelope_pct: 'pct',
  envelope_min_samples: 'minSamples',
})

/**
 * @typedef {import('./rules.js').Thresholds} Thresholds
 * @typedef {import('./state.js').SpiralSnapshot} SpiralSnapshot
 */

/**
 * Linear-interpolated p-th percentile of xs (0 <= p <= 100). xs need not be
 * sorted (`envelope.py:14-27`).
 *
 * @param {number[]} xs
 * @param {number} p
 * @returns {number|null} null for an empty input.
 */
export function percentile(xs, p) {
  if (!Array.isArray(xs) || xs.length === 0) return null
  const sorted = [...xs].sort((a, b) => a - b)
  const n = sorted.length
  if (n === 1) return sorted[0]
  const index = (p / 100) * (n - 1)
  const lo = Math.floor(index)
  const frac = index - lo
  if (lo + 1 >= n) return sorted[n - 1]
  return sorted[lo] + frac * (sorted[lo + 1] - sorted[lo])
}

/**
 * Python's `round()` (round half to even), used for the learned threshold
 * clamps so the numbers match upstream exactly.
 *
 * @param {number} value
 * @returns {number}
 */
function roundHalfEven(value) {
  const sign = value < 0 ? -1 : 1
  const abs = Math.abs(value)
  const floor = Math.floor(abs)
  const diff = abs - floor
  let rounded = floor
  if (diff > 0.5) rounded = floor + 1
  else if (diff === 0.5) rounded = floor % 2 === 0 ? floor : floor + 1
  return sign * rounded
}

/**
 * Python `round(x, 3)` for the stagnation floor.
 * @param {number} value
 * @returns {number}
 */
function round3(value) {
  return Math.round(value * 1000) / 1000
}

/**
 * `int(max(lo, min(hi, round(v))))` (`envelope.py:120-121`).
 *
 * @param {number} value
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function clampRound(value, lo, hi) {
  return Math.max(lo, Math.min(hi, roundHalfEven(value)))
}

/**
 * @typedef {object} EnvelopeTrackerOptions
 * @property {number} [margin] Envelope multiplier; defaults to the level's value.
 * @property {number} [pct] Percentile of resolved turns; defaults to the level's value.
 * @property {number} [minSamples] Resolved turns before the envelope is trusted.
 * @property {string} [level] SPIRAL_LEVELS preset name (unknown falls back to default).
 * @property {number|null} [frozenEnvelope] Pre-registered envelope for short streams.
 */

/**
 * @typedef {object} EnvelopeDocument
 * @property {string} level
 * @property {number[]} resolved_turns
 * @property {SpiralSnapshot[]} resolved_snaps
 */

/**
 * Per-repo resolved-turn envelope AND runtime-learned detection thresholds.
 *
 * Envelope: `margin * p<pct>` of turn-counts among RESOLVED tasks seen so far.
 * Using a PERCENTILE (default p90), not the max, keeps one very-long resolve from
 * setting a max-based envelope far out. Stays null until `minSamples` resolved
 * tasks exist (do not trust a percentile of a handful of points), so a cold-start
 * repository is never acted on. Thresholds: `thresholds()` derives the full
 * detector dict from the same resolved-task history, so the guard adapts to the
 * agent/repository's actual turn scale; turn-scale gates scale DOWN to the
 * learned distribution while learned signal gates keep the level base as a FLOOR
 * (a learned dict is never more trigger-happy than the hand-tuned one).
 */
export class EnvelopeTracker {
  /**
   * @param {EnvelopeTrackerOptions} [options]
   */
  constructor(options = {}) {
    const { level = 'default', frozenEnvelope = null } = options
    this.level = level
    /** @type {Thresholds} */
    this.baseThr = scaledThresholds(level)
    this.margin = options.margin || this.baseThr.envelope_margin
    this.pct = options.pct === undefined ? this.baseThr.envelope_pct : options.pct
    this.minSamples = options.minSamples === undefined
      ? this.baseThr.envelope_min_samples
      : options.minSamples
    this.frozenEnvelope = frozenEnvelope
    /** @type {number[]} All RESOLVED tasks' turn counts. */
    this.resolvedTurns = []
    /** @type {SpiralSnapshot[]} Per-resolved-task SpiralState.snapshot() dicts. */
    this.resolvedSnaps = []
  }

  /**
   * Record a completed task. Only RESOLVED (ended-green) tasks feed the
   * baseline. `snapshot` is an optional `SpiralState.snapshot()` dict captured
   * from that task's whole-turn trajectory; when omitted only the turn envelope
   * learns (`envelope.py:72-80`).
   *
   * @param {number} turns Tool calls in the completed turn.
   * @param {boolean} resolved Whether the turn ended green.
   * @param {SpiralSnapshot|null} [snapshot]
   * @returns {void}
   */
  update(turns, resolved, snapshot = null) {
    if (resolved && turns) {
      this.resolvedTurns.push(turns)
      if (snapshot) this.resolvedSnaps.push(snapshot)
      if (this.resolvedTurns.length > ENVELOPE_HISTORY) {
        this.resolvedTurns = this.resolvedTurns.slice(-ENVELOPE_HISTORY)
      }
      if (this.resolvedSnaps.length > ENVELOPE_HISTORY) {
        this.resolvedSnaps = this.resolvedSnaps.slice(-ENVELOPE_HISTORY)
      }
    }
  }

  /**
   * The learned envelope in tool calls, or null while cold (or the frozen
   * pre-registered value for short streams).
   * @returns {number|null}
   */
  get envelope() {
    if (this.resolvedTurns.length < this.minSamples) return this.frozenEnvelope
    const pct = percentile(this.resolvedTurns, this.pct)
    return pct === null ? this.frozenEnvelope : pct * this.margin
  }

  /**
   * The detector thresholds a turn is checked against: the level-scaled base,
   * overridden by what this repository's resolved-task distribution learned once
   * warm. Pass `maxTurns` (the run's turn cap) to make the hard backstop
   * REACHABLE under the cap (`envelope.py:90-144`).
   *
   * @param {number|null} [maxTurns]
   * @returns {Thresholds}
   */
  thresholds(maxTurns = null) {
    const base = this.baseThr
    /** @type {Thresholds} */
    const thr = { ...base }
    const env = this.envelope
    if (env !== null) {
      let backstop = env * thr.backstop_mult
      if (maxTurns) backstop = Math.min(backstop, 0.9 * maxTurns)
      thr.backstop_turns = backstop
    }
    if (this.resolvedTurns.length < this.minSamples) return thr

    // Turn-scale gates relative to the learned resolved-turn distribution: on a
    // short-turn agent this drops the judge gate so the guard can engage before
    // the cap; on a long-turn agent the clamp keeps it at the base ceiling.
    const p90t = percentile(this.resolvedTurns, 90) ?? 0
    thr.gate_min_turns = clampRound(0.6 * p90t, 6, base.gate_min_turns)
    thr.min_turns = clampRound(0.6 * p90t, 8, base.min_turns)

    // Signal gates: treat RESOLVED runs as the "normal" band and sit just ABOVE
    // its p90, but never BELOW the level-scaled base floor.
    if (this.resolvedSnaps.length > 0) {
      /** @param {string} key */
      const sig = (key) => this.resolvedSnaps.map((snap) => {
        const value = /** @type {Record<string, unknown>} */ (snap)[key]
        return typeof value === 'number' && Number.isFinite(value) ? value : 0
      })
      thr.edit_churn = Math.max(
        base.edit_churn,
        Math.ceil((percentile(sig('edit_churn'), 90) ?? 0) + 1),
      )
      thr.distinct_edit_files = Math.max(
        base.distinct_edit_files,
        Math.ceil((percentile(sig('distinct_edit_files'), 90) ?? 0) + 1),
      )
      thr.error_outputs = Math.max(
        base.error_outputs,
        Math.ceil((percentile(sig('error_outputs'), 90) ?? 0) + 1),
      )
      thr.gate_error_outputs = Math.max(base.gate_error_outputs, thr.error_outputs)
      thr.stagnation = Math.max(
        base.stagnation,
        round3(percentile(sig('stagnation'), 90) ?? 0),
      )
    }
    return thr
  }

  /**
   * The persisted document. Both histories are capped to
   * {@link ENVELOPE_HISTORY} newest entries, exactly like `save_envelope`.
   * @returns {EnvelopeDocument}
   */
  toJSON() {
    return {
      level: this.level,
      resolved_turns: this.resolvedTurns.slice(-ENVELOPE_HISTORY),
      resolved_snaps: this.resolvedSnaps.slice(-ENVELOPE_HISTORY),
    }
  }

  /**
   * Rebuild a tracker from its persisted document (upstream `load_envelope`).
   * Malformed data degrades to a cold tracker rather than throwing.
   *
   * @param {unknown} document
   * @param {{ level?: string, overrides?: Record<string, unknown> }} [options]
   * @returns {EnvelopeTracker}
   */
  static fromJSON(document, options = {}) {
    return loadEnvelope(document, options)
  }
}

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
function positiveInteger(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.trunc(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return 0
}

/**
 * Load a tracker from the repository's persisted `envelope.json` document
 * (`envelope.py:157-164`). `overrides` are the pinned `loopguard.*` settings;
 * the envelope-shaping ones are applied here, the rest by
 * {@link thresholdsFor}.
 *
 * @param {unknown} document Content of `envelope.json` (or a fallback object).
 * @param {{ level?: string, overrides?: Record<string, unknown> }} [options]
 * @returns {EnvelopeTracker}
 */
export function loadEnvelope(document, options = {}) {
  const { level = 'default', overrides = {} } = options
  const data = isPlainObject(document) ? document : {}
  /** @type {EnvelopeTrackerOptions} */
  const trackerOptions = { level }
  for (const [key, arg] of Object.entries(ENVELOPE_OVERRIDE_KEYS)) {
    if (Object.hasOwn(overrides, key)) {
      const value = overrides[key]
      if (typeof value === 'number' && Number.isFinite(value)) {
        trackerOptions[arg] = value
      }
    }
  }
  const tracker = new EnvelopeTracker(trackerOptions)
  const turns = Array.isArray(data.resolved_turns) ? data.resolved_turns : []
  tracker.resolvedTurns = turns
    .filter((value) => Boolean(value))
    .map(positiveInteger)
    .filter((value) => value > 0)
    .slice(-ENVELOPE_HISTORY)
  const snaps = Array.isArray(data.resolved_snaps) ? data.resolved_snaps : []
  const plainSnaps = /** @type {unknown[]} */ (snaps.filter(isPlainObject))
  tracker.resolvedSnaps = /** @type {SpiralSnapshot[]} */ (plainSnaps.slice(-ENVELOPE_HISTORY))
  return tracker
}

/**
 * The persisted document for a tracker (`envelope.py:187-191`).
 *
 * @param {EnvelopeTracker} tracker
 * @returns {EnvelopeDocument}
 */
export function saveEnvelope(tracker) {
  return tracker.toJSON()
}

/**
 * The thresholds a turn is checked against: the preset, what this repository's
 * history learned on top of it, then a person's pinned values, which win
 * (`envelope.py:167-176`).
 *
 * @param {EnvelopeTracker} tracker
 * @param {Record<string, unknown>|null} [overrides]
 * @returns {Thresholds}
 */
export function thresholdsFor(tracker, overrides = null) {
  const thr = tracker.thresholds(null)
  if (!isPlainObject(overrides)) return thr
  for (const [key, value] of Object.entries(overrides)) {
    if (Object.hasOwn(ENVELOPE_OVERRIDE_KEYS, key)) continue
    if (typeof value === 'number' && Number.isFinite(value)) {
      /** @type {Record<string, unknown>} */ (thr)[key] = value
    } else if (typeof value === 'boolean') {
      /** @type {Record<string, unknown>} */ (thr)[key] = value
    }
  }
  if (Object.hasOwn(overrides, 'backstop_mult') && tracker.envelope !== null) {
    thr.backstop_turns = tracker.envelope * thr.backstop_mult
  }
  return thr
}

/**
 * The thresholds before any learning: the preset with a person's pinned values
 * on top (`envelope.py:179-184`). What a status command reports, so the numbers
 * a setting replaces are visible.
 *
 * @param {string} [level]
 * @param {Record<string, unknown>|null} [overrides]
 * @returns {Thresholds}
 */
export function baseThresholds(level = 'default', overrides = null) {
  /** @type {Thresholds} */
  const thr = scaledThresholds(level)
  if (!isPlainObject(overrides)) return thr
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      /** @type {Record<string, unknown>} */ (thr)[key] = value
    } else if (typeof value === 'boolean') {
      /** @type {Record<string, unknown>} */ (thr)[key] = value
    }
  }
  return thr
}

/**
 * What the ended-green proxy needs from a finished turn.
 *
 * @typedef {object} GreenTurnView
 * @property {number} cumTurns
 * @property {boolean} aborted
 * @property {number} lastEdit
 * @property {number} lastVerify
 * @property {boolean} lastVerifyFailed
 */

/**
 * Did this turn END GREEN? The stand-in for the grader the envelope cannot have
 * (`turn.py:255-264`).
 *
 * Green unless a verification after the last edit failed. Requiring a PASSING
 * check after the last edit was tried upstream on a continuous stream and made
 * the envelope longer, not shorter: it drops the short turns that edit without
 * running anything, while the long failing turns end with the agent's own checks
 * passing either way.
 *
 * @param {GreenTurnView} guard
 * @param {boolean} [stoppedNormally]
 * @returns {boolean}
 */
export function resolvedProxy(guard, stoppedNormally = true) {
  if (!stoppedNormally || guard.aborted || guard.cumTurns === 0) return false
  return !(guard.lastVerifyFailed && guard.lastVerify > guard.lastEdit)
}

/**
 * Fold a finished turn into the envelope: only ended-green turns feed it, with
 * the snapshot of the WHOLE turn (`guard.whole`), not the post-nudge segment, as
 * the experiments snapshot a resolved task's full trajectory
 * (`envelope.py:194-205`). Persistence and locking are the adapter's job; call
 * this under the store lock and save the returned tracker.
 *
 * @param {EnvelopeTracker} tracker
 * @param {{ cumTurns: number, aborted: boolean, lastEdit: number, lastVerify: number,
 *   lastVerifyFailed: boolean, whole: { snapshot: () => SpiralSnapshot } }} guard
 * @param {boolean} [stoppedNormally]
 * @returns {EnvelopeTracker}
 */
export function recordTurn(tracker, guard, stoppedNormally = true) {
  tracker.update(
    guard.cumTurns,
    resolvedProxy(guard, stoppedNormally),
    guard.whole.snapshot(),
  )
  return tracker
}
