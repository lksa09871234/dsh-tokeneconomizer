/**
 * Background stuck-judge and redirect-writer adapter for the loop guard.
 *
 * Implements the `JudgeLike` background protocol consumed by
 * `TurnGuard.backgroundJudge()` (`lib/loopguard/guard.js`):
 *
 * - `start(guard, digest)` begins one detached model call set and returns a
 *   non-empty job id immediately (never awaits, never throws).
 * - `poll(guard)` is synchronous: it returns `{found: false}` while the job runs
 *   or when the guard's current segment has moved on (stale verdicts are
 *   dropped), and `{found: true, verdict}` exactly once when the job for the
 *   current segment has completed.
 *
 * A completed job yields `{stuck, confidence, reason, tokens, nudge?}` — the
 * `JudgeVerdict` shape the guard already accumulates. `stuck` is `true|false|
 * null`, `confidence` is clamped to `0..1`, `reason` is capped at
 * `JUDGE_REASON_MAX_CHARS`, and `tokens` is the effective-token cost
 * (input + cacheRead + cacheWrite + output) of every paid call the job made, for
 * the guard's `judge_tokens`/ledger overhead.
 *
 * Failures never escape: an unavailable service, a failed call, or an
 * unparseable reply produces `{stuck: null, confidence: 0, reason:
 * 'judge-error'|'judge-unavailable', tokens}` so the guard falls back to its
 * envelope logic.
 *
 * One job at a time: `start()` returns `null` while a job is outstanding.
 * `dispose()` aborts in-flight calls and clears the job; no timer survives a
 * completed, failed, or disposed job.
 *
 * @module dsh-tokeneconomizer/dsh/judge
 */

import {
  JUDGE_REASON_MAX_CHARS,
  NUDGE_MAX_CHARS,
  NUDGE_WRITER_SYSTEM,
  STUCK_JUDGE_SYSTEM,
  buildNudgeWriterPrompt,
  buildStuckJudgePrompt,
  parseNudgeWriterReply,
  parseStuckJudgeReply,
} from '../loopguard/judge.js'

/**
 * @typedef {object} SideCallUsageLike
 * @property {number} [inputTokens]
 * @property {number} [outputTokens]
 * @property {number} [cacheReadTokens]
 * @property {number} [cacheWriteTokens]
 */

/**
 * @typedef {object} SideCallReplyLike
 * @property {boolean} ok
 * @property {string} [text]
 * @property {SideCallUsageLike} [usage]
 * @property {string} [finish]
 * @property {string} [code]
 * @property {string} [error]
 */

/**
 * The minimal `createSideCall()` surface this adapter needs; a real adapter or a
 * test double both satisfy it.
 * @typedef {object} SideCallLike
 * @property {(request: {prompt: string, system?: string, maxTokens?: number, signal?: AbortSignal}) => Promise<SideCallReplyLike>} call
 */

/**
 * @typedef {object} GuardLike
 * @property {number} [segment] Current fair-recovery segment (0 when absent).
 */

/**
 * @typedef {object} GuardJudgeVerdict
 * @property {boolean|null} stuck
 * @property {number} confidence
 * @property {string} reason
 * @property {number} tokens Effective-token cost of this job's paid calls.
 * @property {string} [nudge] Redirect written by the optional writer call.
 */

/**
 * @typedef {object} GuardJudgePoll
 * @property {boolean} found
 * @property {GuardJudgeVerdict} [verdict]
 */

/**
 * @typedef {object} GuardJudgeOptions
 * @property {SideCallLike|null|undefined} [sidecall] Side-call adapter (`createSideCall(...)`).
 * @property {number} [timeoutMs] Optional extra hard timeout per job; sidecall also bounds calls.
 * @property {number} [maxJudgedTokens] Optional budget: skip the redirect writer once the judge call already spent this many effective tokens (0 = no budget).
 * @property {boolean} [enableNudgeWriter] Ask the writer model for a redirect when the judge says stuck.
 */

/**
 * @typedef {object} JudgeJob
 * @property {string} id
 * @property {number} segment
 * @property {AbortController} controller
 * @property {ReturnType<typeof setTimeout>|null} timer
 * @property {boolean} done
 * @property {GuardJudgeVerdict|null} verdict
 */

/**
 * @typedef {object} GuardJudge
 * @property {(guard: GuardLike, digest: string) => string|null} start
 * @property {(guard: GuardLike) => GuardJudgePoll} poll
 * @property {() => void} dispose
 */

/** @param {unknown} value @returns {number} */
function numberOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/**
 * Effective-token cost carried on a judge verdict (same formula the ledger uses:
 * input + cacheRead + cacheWrite + output).
 *
 * @param {SideCallUsageLike | undefined} usage
 * @returns {number}
 */
function effectiveTokens(usage) {
  if (usage === null || usage === undefined || typeof usage !== 'object') return 0
  return numberOrZero(usage.inputTokens) + numberOrZero(usage.cacheReadTokens)
    + numberOrZero(usage.cacheWriteTokens) + numberOrZero(usage.outputTokens)
}

/**
 * Strip the system prompt duplicated inside a builder's prompt.
 *
 * The `lib/loopguard/judge.js` builders embed the system text at the top of the
 * prompt for callers that use a single message. When the system text is sent on
 * the sidecall's `system` channel instead, sending it twice would pay for it
 * twice, so the duplicated prefix is removed. A future helper format without the
 * prefix falls back to the untouched prompt.
 *
 * @param {string} prompt
 * @param {string} system
 * @returns {string}
 */
function stripSystemPrefix(prompt, system) {
  if (typeof prompt !== 'string') return ''
  if (prompt.startsWith(system)) return prompt.slice(system.length).replace(/^[\s:]+/, '')
  return prompt
}

/**
 * Create the background guard judge.
 *
 * @param {GuardJudgeOptions} [options]
 * @returns {GuardJudge}
 */
export function createGuardJudge(options = {}) {
  const sidecall = options.sidecall ?? null
  const timeoutMs = numberOrZero(options.timeoutMs)
  const maxJudgedTokens = numberOrZero(options.maxJudgedTokens)
  const enableNudgeWriter = options.enableNudgeWriter === true

  /** @type {JudgeJob|null} */
  let pending = null
  let disposed = false
  let sequence = 0

  /**
   * Failure verdict for one job; keeps any tokens already spent.
   *
   * @param {string} code
   * @param {number} tokens
   * @returns {GuardJudgeVerdict}
   */
  function failureVerdict(code, tokens) {
    const reason = code === 'llm-unavailable' || code === 'module-unavailable' || code === 'disposed'
      ? 'judge-unavailable'
      : 'judge-error'
    return { stuck: null, confidence: 0, reason, tokens }
  }

  /**
   * Run the paid call set for one job.
   *
   * @param {string} digest
   * @param {AbortSignal} signal
   * @returns {Promise<GuardJudgeVerdict>}
   */
  async function runJob(digest, signal) {
    /** @type {number} */
    let tokens = 0
    const activeSidecall = /** @type {SideCallLike} */ (sidecall)
    /** @type {SideCallReplyLike} */
    let judged
    try {
      judged = await activeSidecall.call({
        system: STUCK_JUDGE_SYSTEM,
        prompt: stripSystemPrefix(buildStuckJudgePrompt(typeof digest === 'string' ? digest : String(digest ?? '')), STUCK_JUDGE_SYSTEM),
        signal,
      })
    } catch (error) {
      return failureVerdict('error', tokens)
    }
    if (!judged || judged.ok !== true) return failureVerdict(judged?.code ?? 'error', tokens)
    tokens += effectiveTokens(judged.usage)
    const parsed = parseStuckJudgeReply(judged.text)
    if (parsed === null) return { stuck: null, confidence: 0, reason: 'judge-error', tokens }
    const verdict = {
      stuck: parsed.stuck,
      confidence: Math.max(0, Math.min(1, numberOrZero(parsed.confidence))),
      reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, JUDGE_REASON_MAX_CHARS) : '',
      tokens,
    }
    if (verdict.stuck !== true || !enableNudgeWriter) return verdict
    if (maxJudgedTokens > 0 && tokens >= maxJudgedTokens) return verdict
    /** @type {SideCallReplyLike} */
    let written
    try {
      written = await activeSidecall.call({
        system: NUDGE_WRITER_SYSTEM,
        prompt: stripSystemPrefix(buildNudgeWriterPrompt(typeof digest === 'string' ? digest : String(digest ?? '')), NUDGE_WRITER_SYSTEM),
        maxTokens: NUDGE_MAX_CHARS,
        signal,
      })
    } catch (error) {
      return verdict
    }
    if (!written || written.ok !== true) return verdict
    tokens += effectiveTokens(written.usage)
    const text = parseNudgeWriterReply(written.text)
    if (text !== null && text !== '') return { ...verdict, tokens, nudge: text }
    return { ...verdict, tokens }
  }

  /** @type {GuardJudge} */
  const judge = {
    /**
     * Start one detached judge job for the guard's current segment.
     *
     * @param {GuardLike} guard
     * @param {string} digest
     * @returns {string|null} Job id, or `null` when unavailable/busy/disposed.
     */
    start(guard, digest) {
      try {
        if (disposed || sidecall === null || typeof sidecall.call !== 'function') return null
        if (pending !== null) return null
        sequence += 1
        /** @type {JudgeJob} */
        const job = {
          id: `judge-${sequence}`,
          segment: typeof guard?.segment === 'number' && Number.isFinite(guard.segment) ? guard.segment : 0,
          controller: new AbortController(),
          timer: null,
          done: false,
          verdict: null,
        }
        pending = job
        if (timeoutMs > 0) {
          job.timer = setTimeout(() => {
            try {
              job.controller.abort(new Error('guard judge job timed out'))
            } catch {
              /* abort never throws */
            }
          }, timeoutMs)
        }
        const finish = (/** @type {GuardJudgeVerdict} */ verdict) => {
          if (job.timer !== null) {
            clearTimeout(job.timer)
            job.timer = null
          }
          job.verdict = verdict
          job.done = true
        }
        Promise.resolve()
          .then(() => runJob(digest, job.controller.signal))
          .then(finish, () => finish(failureVerdict('error', 0)))
        return job.id
      } catch {
        return null
      }
    },

    /**
     * Return the completed verdict for the guard's CURRENT segment.
     *
     * @param {GuardLike} guard
     * @returns {GuardJudgePoll}
     */
    poll(guard) {
      try {
        if (pending === null) return { found: false }
        const segment = typeof guard?.segment === 'number' && Number.isFinite(guard.segment) ? guard.segment : 0
        if (pending.segment !== segment) {
          // The guard entered a new fair-recovery segment: the old verdict is
          // about the old segment and must never be delivered. Abort it to stop
          // paying for a result nobody will read.
          const stale = pending
          pending = null
          if (stale.timer !== null) {
            clearTimeout(stale.timer)
            stale.timer = null
          }
          try {
            stale.controller.abort(new Error('guard segment changed before the judge verdict arrived'))
          } catch {
            /* abort never throws */
          }
          return { found: false }
        }
        if (!pending.done) return { found: false }
        const job = pending
        pending = null
        const verdict = job.verdict ?? failureVerdict('error', 0)
        return { found: true, verdict }
      } catch {
        return { found: false }
      }
    },

    /** Abort in-flight work and make the judge inert. Idempotent; never throws. */
    dispose() {
      if (disposed) return
      disposed = true
      const job = pending
      pending = null
      if (job === null) return
      if (job.timer !== null) {
        clearTimeout(job.timer)
        job.timer = null
      }
      try {
        job.controller.abort(new Error('guard judge disposed'))
      } catch {
        /* abort never throws */
      }
    },
  }
  return judge
}
