/**
 * When a trajectory counts as stuck, and what to do about it.
 *
 * Three tiers, cheapest first:
 *
 *   * {@link gateForJudge} — free, every call: is the recent trace worth a paid
 *     look at all?
 *   * a paid judge      — optional; only when the gate is open;
 *   * {@link isStuck}   — the strict heuristic decision used when no judge is
 *     wired: churn or scatter, AND sustained errors, AND repeated identical
 *     failures.
 *
 * {@link assessAbort} runs the cascade against a per-repository envelope (how
 * long a turn that ended well usually runs) with a hard backstop the judge
 * cannot veto. {@link nudgeText} is the redirect the guard sends first: it
 * mirrors only the agent's own actions back at it, carries no outside
 * knowledge, and never tells it to stop.
 *
 * Faithful port of `tokeneconomizer/loopguard/rules.py` (Apache-2.0 upstream,
 * microsoft/TokenEconomizer @ e428fc91b0f8ffecb5a596d56b14fe2f1485a5f9).
 *
 * @module dsh-tokeneconomizer/loopguard/rules
 */

import { SpiralState } from './state.js'

/**
 * Detector thresholds (`rules.py:20-43`). Every number matters. Keys keep
 * upstream's snake_case because `loopguard_thresholds` overrides are persisted
 * and exchanged under these names, and the envelope document is a
 * compatibility surface.
 *
 * @typedef {object} Thresholds
 * @property {number} min_turns Tool calls before isStuck may fire.
 * @property {number} edit_churn Edits to one file that count as churn.
 * @property {number} distinct_edit_files OR edits scattered over this many files.
 * @property {number} error_outputs Sustained failing tool results.
 * @property {number} stagnation Share of failures that repeat an earlier signature.
 * @property {number} envelope_margin Envelope = margin x p<pct> of ended-green turns.
 * @property {number} envelope_pct Percentile of resolved turns used (not max).
 * @property {number} envelope_min_samples Ended-green turns before the envelope is trusted.
 * @property {number} judge_confidence Judge confidence needed to redirect.
 * @property {number} backstop_mult Redirect without judge past this x envelope when stuck.
 * @property {number} gate_min_turns Judge gate: do not wake before this many calls.
 * @property {number} gate_error_outputs OR this many failing results wake the judge.
 * @property {boolean} [gate_over_envelope] Judge gate also opens past the envelope.
 * @property {number} [backstop_turns] Learned, cap-aware hard backstop in tool calls.
 * @property {boolean} [nudge_on_ambiguous] Nudge a judge-ambiguous turn past the envelope.
 */

/**
 * The default detector thresholds — verbatim upstream (`rules.py:20-43`).
 * @type {Thresholds}
 */
export const DEFAULT_THRESHOLDS = Object.freeze({
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

/**
 * A single LEVEL scales the thresholds the guard starts from; the per-repository
 * {@link import('./envelope.js').EnvelopeTracker} then learns on top, flooring
 * learned signal gates against it. `default` is {@link DEFAULT_THRESHOLDS}
 * exactly (`rules.py:53-66`).
 *
 * @type {Readonly<Record<'conservative'|'default'|'aggressive', Partial<Thresholds>>>}
 */
export const SPIRAL_LEVELS = Object.freeze({
  conservative: Object.freeze({
    judge_confidence: 0.85,
    envelope_margin: 1.5,
    backstop_mult: 3.5,
    stagnation: 0.3,
    gate_min_turns: 24,
    min_turns: 28,
    edit_churn: 5,
    error_outputs: 8,
    envelope_min_samples: 7,
  }),
  default: Object.freeze({}),
  aggressive: Object.freeze({
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
  }),
})

/**
 * The threshold preset names accepted by the configuration.
 * @type {ReadonlyArray<'conservative'|'default'|'aggressive'>}
 */
export const SPIRAL_LEVEL_NAMES = Object.freeze([
  'conservative',
  'default',
  'aggressive',
])

/**
 * Default thresholds overlaid with the named level's overrides. An unknown level
 * falls back to `default` (verbatim defaults). This is the BASE the envelope
 * tracker starts from (`rules.py:69-75`).
 *
 * @param {string} [level]
 * @returns {Thresholds}
 */
export function scaledThresholds(level = 'default') {
  const overrides = Object.hasOwn(SPIRAL_LEVELS, level)
    ? SPIRAL_LEVELS[/** @type {'conservative'|'default'|'aggressive'} */ (level)]
    : SPIRAL_LEVELS.default
  return { ...DEFAULT_THRESHOLDS, ...overrides }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * TIER-0 (free, every turn): cheap rule-based trigger deciding whether the recent
 * trace is worth ELEVATING to the paid LLM judge. Permissive — it only needs a
 * sign of POSSIBLE trouble after the loop has had time to form: a repeated
 * identical failure (the cheapest "no progress" signal) OR a high error density.
 * Productive trajectories (changing failures, few repeats) mostly keep this gate
 * CLOSED, so the judge is rarely consulted (`rules.py:78-90`).
 *
 * @param {SpiralState} state
 * @param {Thresholds} [thr]
 * @returns {boolean}
 */
export function gateForJudge(state, thr = DEFAULT_THRESHOLDS) {
  if (state.turns < thr.gate_min_turns) return false
  return state.repeatedFailSigs >= 1 || state.errorOutputs >= thr.gate_error_outputs
}

/**
 * Strict heuristic "this looks like an unproductive loop" classifier — the
 * DECISION used only in the no-judge fallback. Must have run a while AND show
 * churn/scatter AND repeated identical failures (stagnation): the last term is
 * what separates a doomed spiral from a productive hard grind (`rules.py:93-106`).
 *
 * @param {SpiralState} state
 * @param {Thresholds} [thr]
 * @returns {boolean}
 */
export function isStuck(state, thr = DEFAULT_THRESHOLDS) {
  if (state.turns < thr.min_turns) return false
  const churny = state.editChurn >= thr.edit_churn
    || state.distinctEditFiles >= thr.distinct_edit_files
  const noisy = state.errorOutputs >= thr.error_outputs
  const repeating = state.stagnation >= thr.stagnation
  return churny && noisy && repeating
}

/**
 * A judge verdict: `stuck` true/false, or null when the judge is ambiguous.
 *
 * @typedef {object} JudgeVerdict
 * @property {boolean|null} stuck
 * @property {number} confidence
 * @property {string} [reason]
 * @property {number} [tokens] Effective-token cost of the judge call.
 * @property {number} [_tokens] Upstream spelling of the same cost.
 * @property {string} [nudge] A redirect a background judge already wrote.
 * @property {string} [_nudge] Upstream spelling of the same redirect.
 */

/**
 * @typedef {object} AssessOptions
 * @property {number|null} [envelope] Learned resolved-turn length in tool calls.
 * @property {((digest: string) => JudgeVerdict|null) | null} [judge] Rate-limited
 *   judge callback (the caller owns rate limiting); may throw or return null.
 * @property {Thresholds} [thr]
 */

/**
 * @typedef {object} AbortDecision
 * @property {boolean} abort
 * @property {string} reason
 */

/**
 * Decide whether to abort, TRACE-FIRST, as an explicit two-tier cascade
 * (`rules.py:109-180`). Returns `{abort, reason}`.
 *
 * Decision order is exactly upstream's:
 *
 * 1. HARD BACKSTOP (checked BEFORE the judge): far past the envelope AND stuck
 *    by the strict heuristic -> abort regardless of any judge verdict. A judge
 *    cannot veto it. `backstop_turns` (learned, cap-aware) is preferred when the
 *    tracker supplied it; else `envelope * backstop_mult`.
 * 2. WITH A JUDGE: if neither the free gate nor (optionally) the envelope is
 *    open -> `gate-closed`; a judge exception or null -> `judge-throttled`;
 *    stuck and confident -> abort; `stuck === false` -> `judge-productive`;
 *    ambiguous -> `judge-ambiguous-spared` (envelope alone never kills; only the
 *    backstop can).
 * 3. NO-JUDGE FALLBACK: `not-stuck`; stuck and at/over the envelope -> abort;
 *    else `stuck-but-within-envelope`.
 *
 * @param {SpiralState} state
 * @param {AssessOptions} [options]
 * @returns {AbortDecision}
 */
export function assessAbort(state, options = {}) {
  const thr = options.thr ?? DEFAULT_THRESHOLDS
  const envelope = options.envelope ?? null
  const judge = options.judge ?? null

  let backstopTurns = typeof thr.backstop_turns === 'number' ? thr.backstop_turns : null
  if (backstopTurns === null && envelope !== null) {
    backstopTurns = envelope * thr.backstop_mult
  }
  if (backstopTurns !== null && state.turns >= backstopTurns && isStuck(state, thr)) {
    return {
      abort: true,
      reason: `backstop:${state.turns}>=${backstopTurns.toFixed(0)}turns stagnation=${state.stagnation.toFixed(2)}`,
    }
  }

  if (judge !== null) {
    const overEnvelope = envelope !== null
      && state.turns >= envelope
      && (thr.gate_over_envelope ?? true)
    if (!(gateForJudge(state, thr) || overEnvelope)) {
      return { abort: false, reason: 'gate-closed' }
    }
    /** @type {JudgeVerdict|null} */
    let verdict = null
    try {
      verdict = judge(state.recentDigest(24, envelope))
    } catch {
      verdict = null
    }
    if (!verdict) return { abort: false, reason: 'judge-throttled' }
    const confidence = toNumber(verdict.confidence)
    if (verdict.stuck && confidence >= thr.judge_confidence) {
      const detail = typeof verdict.reason === 'string' ? verdict.reason : ''
      return { abort: true, reason: `judge-stuck@${confidence.toFixed(2)}:${detail.slice(0, 60)}` }
    }
    if (verdict.stuck === false) return { abort: false, reason: 'judge-productive' }
    // Judge AMBIGUOUS (stuck null): do NOT abort on the (possibly
    // under-calibrated) envelope alone. Ambiguity => SPARE; the hard backstop
    // checked above remains the only envelope-driven kill.
    return { abort: false, reason: 'judge-ambiguous-spared' }
  }

  if (!isStuck(state, thr)) return { abort: false, reason: 'not-stuck' }
  if (envelope !== null && state.turns >= envelope) {
    return { abort: true, reason: `envelope:${state.turns}>=${envelope.toFixed(0)}` }
  }
  return { abort: false, reason: 'stuck-but-within-envelope' }
}

/**
 * The redirect: mirror the agent's OWN repeated actions back at it. Contains
 * nothing but a summary of what it already did — leakage-safe by construction,
 * and framed to REDIRECT effort, never to stop it. Verbatim upstream template
 * (`rules.py:183-198`).
 *
 * @param {SpiralState} state
 * @returns {string}
 */
export function nudgeText(state) {
  let busiest = 'one file'
  let busiestCount = 0
  for (const [file, count] of Object.entries(state.editCounts)) {
    if (count > busiestCount) {
      busiest = file
      busiestCount = count
    }
  }
  let totalEdits = 0
  for (const count of Object.values(state.editCounts)) totalEdits += count
  return 'Process check (automated): so far you\'ve made '
    + `${totalEdits} edits across `
    + `${state.distinctEditFiles} file(s) (most to \`${busiest}\`) and run `
    + `${state.testRuns} verification(s), and the same failure has recurred `
    + `${state.repeatedFailSigs} time(s) without the tests going green. This `
    + 'looks like a repetitive loop. Do NOT stop — instead step back and try a '
    + 'MATERIALLY DIFFERENT hypothesis: re-read the failing test\'s expectation, '
    + 'consider a different file or root cause than the ones you\'ve been editing, '
    + 'and verify the new hypothesis directly before editing again.'
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

/**
 * Thresholds as the LIVE plugin uses them (`plugin/controller.py:314-320`):
 * never wake the judge merely because a turn outran this repository's usual
 * length (interactive turns do that all the time; the experiments' agents ran
 * under a turn cap, hence their envelope gate), and do not open the judge gate
 * before the strict stuck floor. `assessAbort` keeps upstream's harness default
 * (`gate_over_envelope` true); a DSH adapter's per-tool-call path pins it off
 * with this helper, exactly like the upstream controller.
 *
 * @param {Thresholds} thr
 * @returns {Thresholds}
 */
export function pinLiveThresholds(thr) {
  return {
    ...thr,
    gate_over_envelope: false,
    gate_min_turns: Math.max(thr.gate_min_turns, thr.min_turns),
  }
}

/**
 * Validate a threshold override map (e.g. a user's pinned `loopguard_*`
 * settings): only known keys with finite numbers are accepted. The adapter is
 * responsible for range checks (upstream `config.py` LOOPGUARD_KEYS); this helper
 * only guards the arithmetic.
 *
 * @param {unknown} overrides
 * @returns {Partial<Thresholds>}
 */
export function sanitizeThresholdOverrides(overrides) {
  /** @type {Partial<Thresholds>} */
  const out = {}
  if (!isPlainObject(overrides)) return out
  const record = /** @type {Record<string, unknown>} */ (overrides)
  for (const [key, value] of Object.entries(record)) {
    if (!Object.hasOwn(DEFAULT_THRESHOLDS, key)) continue
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    const target = /** @type {Record<string, number|boolean>} */ (out)
    target[key] = value
  }
  return out
}
