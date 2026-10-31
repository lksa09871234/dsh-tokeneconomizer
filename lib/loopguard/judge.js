/**
 * The loop guard's two optional paid calls: a stuck judge and a redirect writer.
 *
 * Both read the same leakage-safe digest of the agent's recent actions
 * (`SpiralState.recentDigest`: commands, searches, edited file basenames, error
 * signatures — never file contents or the task text). The judge decides
 * stuck-versus-productive when the free gate is open; the writer turns the
 * redirect from a count template into one that names the pattern it sees.
 *
 * This module is deliberately side-effect free: it builds prompts and parses
 * replies. The adapter performs the model call with the harness's own login (DSH
 * side call) and passes the raw reply to the parsers; any failure returns null,
 * which the guard already treats as "ask again later / fall back to the template".
 * No network, no credentials, no vendor price data.
 *
 * Prompts are verbatim upstream (`tokeneconomizer/loopguard/judge.py:15-27,
 * 66-80`; Apache-2.0, microsoft/TokenEconomizer @
 * e428fc91b0f8ffecb5a596d56b14fe2f1485a5f9).
 *
 * @module dsh-tokeneconomizer/loopguard/judge
 */

/**
 * The stuck-judge system prompt (upstream `STUCK_JUDGE_SYSTEM`).
 * @type {string}
 */
export const STUCK_JUDGE_SYSTEM = 'You monitor an AI coding agent that is partway through ONE task in a software repo. '
  + 'A cheap heuristic flagged its recent process as a possible UNPRODUCTIVE LOOP. Read '
  + 'the leakage-safe digest of its RECENT actions and judge whether it is genuinely '
  + 'STUCK — repeating the same kind of edit/test/failure with no progress toward green '
  + 'tests, unlikely to recover if it keeps going the same way — versus still making '
  + 'real progress (changing failures, narrowing the problem, exploring new hypotheses).\n\n'
  + 'Judge ONLY the workflow from the digest; do NOT infer the task\'s solution or which '
  + 'lines to change. Favor SPARING (stuck=false) when there is any sign of progress; '
  + 'only return stuck=true with high confidence for a clear, repetitive dead-end.\n'
  + 'Return ONLY a JSON object: {"stuck": bool, "confidence": <0.0-1.0>, '
  + '"reason": "<short leakage-safe justification>"}.'

/**
 * The redirect-writer system prompt (upstream `NUDGE_WRITER_SYSTEM`). The hard
 * constraints are what keep the redirect from becoming a stop instruction.
 * @type {string}
 */
export const NUDGE_WRITER_SYSTEM = 'An AI coding agent is stuck in a REPETITIVE, UNPRODUCTIVE loop partway through one '
  + 'task in a software repo. You are given a leakage-safe digest of its RECENT ACTIONS '
  + 'only (tool names, shell commands, searched patterns, edited file BASENAMES, and '
  + 'error SIGNATURES — never file contents or the task description). Write a SHORT '
  + 'redirect (2-4 sentences) addressed to the agent that: (1) names the specific '
  + 'repetitive pattern you actually see in the digest (e.g. re-editing the same file, '
  + 're-running the same test to the same failure); (2) proposes a MATERIALLY DIFFERENT '
  + 'next step (a different file/root-cause to consider, re-reading the failing test\'s '
  + 'expectation, verifying a new hypothesis before editing again).\n'
  + 'HARD CONSTRAINTS: Do NOT tell it to stop, give up, or reduce effort — only redirect. '
  + 'Do NOT infer the task\'s solution, name specific line numbers to change, or reference '
  + 'any code/identifier you cannot see in the digest. Output ONLY the redirect as plain '
  + 'text — no preamble, no JSON, no headings.'

/** Maximum redirect text returned by the writer parser (upstream `raw[:1200]`). */
export const NUDGE_MAX_CHARS = 1200

/** Maximum justification length kept from a judge reply (upstream `[:160]`). */
export const JUDGE_REASON_MAX_CHARS = 160

/**
 * @typedef {object} StuckVerdict
 * @property {boolean|null} stuck
 * @property {number} confidence
 * @property {string} reason
 */

/**
 * Build the stuck-judge prompt from a leakage-safe digest.
 *
 * @param {string} digest
 * @returns {string}
 */
export function buildStuckJudgePrompt(digest) {
  return `${STUCK_JUDGE_SYSTEM}\n\nRecent process digest:\n${digest}\n\nReturn the JSON verdict:`
}

/**
 * Parse a stuck-judge reply. Strict: the first `{...}` JSON object must parse,
 * `stuck` must be a boolean or null when present, `confidence` a finite number
 * when present, and `reason` a string when present. Any failure returns null so
 * the caller keeps the envelope fallback.
 *
 * @param {unknown} raw Raw model reply.
 * @returns {StuckVerdict|null}
 */
export function parseStuckJudgeReply(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const match = /\{[\s\S]*\}/.exec(raw)
  if (!match) return null
  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(match[0])
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const object = /** @type {Record<string, unknown>} */ (parsed)
  /** @type {boolean|null} */
  let stuck = null
  if (Object.hasOwn(object, 'stuck')) {
    if (object.stuck === null) stuck = null
    else if (typeof object.stuck === 'boolean') stuck = object.stuck
    else return null
  }
  /** @type {number} */
  let confidence = 0
  if (Object.hasOwn(object, 'confidence') && object.confidence !== null) {
    if (typeof object.confidence !== 'number' || !Number.isFinite(object.confidence)) return null
    confidence = object.confidence
  }
  confidence = Math.max(0, Math.min(1, confidence))
  /** @type {string} */
  let reason = ''
  if (Object.hasOwn(object, 'reason') && object.reason !== null) {
    if (typeof object.reason !== 'string') return null
    reason = object.reason.slice(0, JUDGE_REASON_MAX_CHARS)
  }
  return { stuck, confidence, reason }
}

/**
 * Build the redirect-writer prompt from the same leakage-safe digest.
 *
 * @param {string} digest
 * @returns {string}
 */
export function buildNudgeWriterPrompt(digest) {
  return `${NUDGE_WRITER_SYSTEM}\n\nRecent process digest:\n${digest}\n\nWrite the redirect:`
}

/**
 * Parse a redirect-writer reply. Plain text only; empty or non-string input
 * returns null so the caller falls back to `rules.nudgeText`.
 *
 * @param {unknown} raw Raw model reply.
 * @returns {string|null}
 */
export function parseNudgeWriterReply(raw) {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (text === '') return null
  return text.slice(0, NUDGE_MAX_CHARS)
}
