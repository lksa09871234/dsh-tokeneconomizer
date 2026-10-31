/**
 * `TurnGuard`: the loop guard for one prompt-turn, one tool call at a time.
 *
 * Per call it folds the result into a `SpiralState`, checks the cumulative
 * backstop, and asks {@link import('./rules.js').assessAbort} (free gate ->
 * optional judge -> envelope fallback) whether the turn is stuck; the first stuck
 * verdict is answered with a redirect ("nudge"), a later one with a "notice".
 * After a redirect the per-segment state starts afresh, which is the agent's fair
 * recovery window.
 *
 * Hard invariants of the DSH port:
 *
 *   * **The guard never stops a turn.** It only returns
 *     `{action: 'nudge'|'notice', reason, text}`; the adapter decides where to
 *     inject the text and how to tell the person. There is no host stop/cancel
 *     call anywhere in this module.
 *   * **The unit is a prompt-turn** (one user prompt to the agent's stop), not a
 *     session.
 *   * **The judge is injected.** The adapter supplies an optional object with a
 *     synchronous `judge(digest)` callback and/or a background `start`/`poll`
 *     pair plus an optional redirect `writer`. With no judge wired, the strict
 *     heuristic + envelope fallback runs (cheap, no model calls).
 *   * **The envelope learns only from turns that ended green** (see
 *     `resolvedProxy`).
 *
 * Faithful port of `tokeneconomizer/loopguard/turn.py` (Apache-2.0 upstream,
 * microsoft/TokenEconomizer @ e428fc91b0f8ffecb5a596d56b14fe2f1485a5f9), minus
 * the upstream host transcript/state plumbing.
 *
 * @module dsh-tokeneconomizer/loopguard/guard
 */

import {
  DEFAULT_THRESHOLDS,
  assessAbort,
  isStuck,
  nudgeText,
} from './rules.js'
import { foldShellEdits, shellEditTargets } from './shell-edits.js'
import { SpiralState, basename, canonTool, matchesErrorMarker } from './state.js'
import { resolvedProxy as endedGreenProxy } from './envelope.js'

/** Tool calls between optional judge calls (`turn.py:191`). */
export const JUDGE_BASE_GAP = 5
/** Cap the judge gap grows to after a productive verdict (`turn.py:192`). */
export const JUDGE_MAX_GAP = 20
/** A background verdict that never came back stops blocking after this long (`turn.py:195`). */
export const JUDGE_STALE_S = 300

/** The phrase upstream's digest uses; replaced with the real verification state. */
const NOT_GREEN = 'Tests are still NOT green.'

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
const QUOTED_RE = /'[^']*'|"(?:\\.|[^"\\])*"/g
/** `|`, but not the `>|` redirect. */
const SEP_RE = /(&&|\|\||\|&|(?<!>)\||;|\n)/
/** A runner asked for its help, version or test list, not to run the tests. */
const NOT_A_RUN_RE = /\s(?:-h|--help|--version|--collect-only|--co|--list\S*)(?!\S)/
/** What may precede the command itself: `FOO=1 timeout 60 npm test`. */
const PREFIX_RE = /^\s*(?:(?:\w+=\S*|time|nice|nohup|command|env|timeout(?:\s+(?:-\S+|[A-Z]+|\d\S*))+)\s+)*/
/** What only reports on the run before it: `echo "exit=$?"`, `true`, `exit 0`. */
const REPORT_RE = /^\s*(?:echo|printf|true|:|exit)(?:\s|$)/
/** Status ranks: a later stage's `mixed` beats `hidden`, which beats `own`. */
/** @type {Record<string, number>} */
const RANK = { own: 0, hidden: 1, mixed: 2 }

/**
 * What counts as running the project's own checks, across ecosystems. Broader
 * than `state.TEST_RUN_RE` (the Python vocabulary the guard thresholds were tuned
 * on); used ONLY for the ended-green proxy, never to change what
 * `SpiralState` counts. A runner is often named by path (`python
 * tests/runtests.py`, `.venv/bin/pytest`), so the optional directories are
 * required (`turn.py:36-42`).
 * @type {RegExp}
 */
export const VERIFY_RE = /(?:^|[\s;&|(])(?:~?\/)?(?:[\w.\-]+\/)*(?:pytest|py\.test|tox|nox|python\d?(?:\.\d+)?\s+-m\s+(?:pytest|unittest)|manage\.py\s+test|runtests(?:\.py)?|jest|vitest|mocha|ava|playwright\s+test|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test|go\s+test|cargo\s+(?:test|nextest)|(?:mvn|mvnw|\.\/mvnw)\s+(?:\S+\s+)*test|(?:gradle|gradlew|\.\/gradlew)\s+(?:\S+\s+)*test|make\s+(?:test|check)|ctest|rspec|phpunit|dotnet\s+test|swift\s+test|mix\s+test|deno\s+test|node\s+--test|bazel\s+test|(?:\.\/)?bin\/test)(?![\w.\-/])/i

/** A test runner's summary of its run, which holds whatever the command line's exit status. */
const RUN_FAILED_RE = new RegExp([
  String.raw`\b[1-9]\d* (?:failed|errors?)\b.*\bin \d+(?:\.\d+)?s\b`, // pytest
  String.raw`^FAILED \((?:failures|errors)=`, // unittest, Django
  String.raw`^tests finished:.*\b[1-9]\d* (?:failed|exceptions?)\b`, // sympy's bin/test
  String.raw`^# fail [1-9]`, // TAP (`node --test`)
  String.raw`^Tests:.*\b[1-9]\d* failed\b`, // jest
  String.raw`^\s*Tests\s+[1-9]\d* failed\b`, // vitest
  String.raw`^\s*[1-9]\d* failing\b`, // mocha
  String.raw`^(?:--- FAIL: |FAIL\t|FAIL$)`, // go
  String.raw`^test result: FAILED`, // cargo
  String.raw`\b\d+ examples?, [1-9]\d* failures?\b`, // rspec
  String.raw`Tests run: \d+, Failures: (?:[1-9]|0, Errors: [1-9])`, // JUnit
  String.raw`BUILD FAIL(?:URE|ED)`,
].join('|'), 'm')

/** A test runner's summary saying its run passed. */
const RUN_PASSED_RE = new RegExp([
  String.raw`\b\d+ passed\b.*\bin \d+(?:\.\d+)?s\b`,
  String.raw`^OK(?: \(.*\))?\s*$`,
  String.raw`^tests finished: \d+ passed`,
  String.raw`^# fail 0\b`,
  String.raw`^Tests:\s+\d+ passed`,
  String.raw`^\s*Tests\s+\d+ passed`,
  String.raw`^\s*\d+ passing\b`,
  String.raw`^ok\s+\S+\s+(?:\d+(?:\.\d+)?s|\(cached\))`,
  String.raw`^test result: ok\.`,
  String.raw`\b\d+ examples?, 0 failures\b`,
  String.raw`BUILD SUCCESS`,
].join('|'), 'm')

/** `_EDIT` in `turn.py:173`. */
const EDIT_TOOLS = new Set(['edit', 'create'])

/**
 * @typedef {import('./rules.js').Thresholds} Thresholds
 * @typedef {import('./rules.js').JudgeVerdict} JudgeVerdict
 */

/**
 * @typedef {object} GuardToolCall
 * @property {string} [tool] DSH-normalized tool name (`NormalizedToolCall.tool`).
 * @property {string} [name] Alias for `tool`.
 * @property {Record<string, unknown>} [args] Parsed tool arguments.
 * @property {string} [resultText] Model-facing result text.
 * @property {string} [result] Alias for `resultText`.
 * @property {boolean} [failed] Host-reported failure flag (`isError`).
 * @property {number|null} [exitCode] Shell exit code when recoverable.
 */

/**
 * @typedef {(digest: string) => ({ text?: string, tokens?: number, _tokens?: number }|null)} NudgeWriter
 */

/**
 * A background-judge poll result: `{found, verdict}` (`plugin/judge.py` interface).
 * @typedef {{ found: boolean, verdict?: JudgeVerdict|null }} JudgePollResult
 */

/**
 * The injected optional judge. All members are optional; the adapter decides
 * whether to wire a synchronous judge, a background job pair, a writer, or none.
 *
 * @typedef {object} JudgeLike
 * @property {(digest: string) => JudgeVerdict|null} [judge] Synchronous sampled judge.
 * @property {(guard: TurnGuard, digest: string) => unknown} [start] Start a background job.
 * @property {(guard: TurnGuard) => JudgePollResult} [poll] Poll the background job.
 * @property {NudgeWriter} [writer] Optional redirect writer.
 */

/**
 * @typedef {object} FoldOptions
 * @property {number|null} [envelope] Learned resolved-turn length (tool calls).
 * @property {Thresholds} [thr] Detector thresholds (preset + learned + pinned).
 * @property {JudgeLike|null} [judge] Optional judge interface.
 * @property {NudgeWriter|null} [writer] Optional redirect writer (also accepted on the judge).
 * @property {number} [nudgeBudget] Redirects per turn (upstream `loopguard_nudges`, default 1).
 * @property {number} [now] Unix seconds for the judge-staleness check (tests inject this).
 */

/**
 * @typedef {object} GuardDecision
 * @property {'nudge'|'notice'} action `nudge` = redirect the model, `notice` = tell the person.
 * @property {string} reason Short machine reason (`cum-backstop:…`, `judge-stuck@…`, ...).
 * @property {string} text Text the adapter delivers; for a notice it has no stop hint.
 */

/**
 * @typedef {object} GuardEvent
 * @property {number} segment
 * @property {'nudge'|'abort'} action
 * @property {number} turn_in_segment
 * @property {number} cum_turns
 * @property {number|null} envelope
 * @property {string} reason
 * @property {import('./state.js').SpiralSnapshot} snapshot
 */

/**
 * @typedef {object} JudgePending
 * @property {unknown} id
 * @property {number} since Unix seconds.
 * @property {number} segment
 */

/**
 * @typedef {object} TurnGuardDocument
 * @property {string} turn_key
 * @property {import('./state.js').SpiralStateDocument} st
 * @property {import('./state.js').SpiralStateDocument} whole
 * @property {number} cum_turns
 * @property {number} segment
 * @property {number} nudges_done
 * @property {boolean} aborted
 * @property {boolean} abort_delivered
 * @property {GuardEvent[]} events
 * @property {number} judge_last
 * @property {number} judge_gap
 * @property {number} judge_calls
 * @property {number} judge_tokens
 * @property {number} writer_tokens
 * @property {number} last_edit
 * @property {number} last_verify
 * @property {boolean} last_verify_failed
 * @property {number} edits
 * @property {number} verifications
 * @property {JudgePending|null} judge_pending
 * @property {string|null} nudge_ready
 */

/**
 * `strip a leading command prefix then test VERIFY_RE at the start of the stage
 * (Python `VERIFY_RE.match(_PREFIX_RE.sub("", stage))`).
 *
 * @param {string} stage
 * @returns {boolean}
 */
function stageVerifies(stage) {
  const stripped = stage.replace(PREFIX_RE, '')
  const match = VERIFY_RE.exec(stripped)
  return match !== null && match.index === 0
}

/**
 * What `cmd`'s exit status says of the test runs in it: null when it runs none;
 * `own` when it is theirs (a run is last, or followed only by `&&`, or piped
 * under `pipefail`); `hidden` when a pipe, `||` or a mere report of the status
 * replaced it; `mixed` when other commands ran after, their output in the result
 * too. A command recorded as `bash -lc '<script>'` is judged by its script
 * (`turn.py:64-101`).
 *
 * @param {unknown} cmd
 * @returns {'own'|'hidden'|'mixed'|null}
 */
export function statusOfTests(cmd) {
  if (typeof cmd !== 'string') return null
  let command = cmd
  /** @type {string[]} */
  let parts
  try {
    parts = shlexSplit(command)
  } catch {
    parts = []
  }
  if (
    parts.length >= 3
    && SHELLS.has(basename(parts[0]))
    && parts[1].startsWith('-')
    && parts[1].includes('c')
  ) {
    command = parts[2]
  }
  const quoted = command.replace(QUOTED_RE, 'Q')
  const cleaned = quoted.replace(/[(){}]/g, ' ')
  const pieces = cleaned.split(SEP_RE)
  while (pieces.length > 1 && pieces[pieces.length - 1].trim() === '') pieces.splice(-2)
  const pipefail = command.includes('pipefail')
  /** @type {'own'|'hidden'|'mixed'|null} */
  let found = null
  for (let i = 0; i < pieces.length; i += 2) {
    const stage = pieces[i]
    if (!stageVerifies(stage) || NOT_A_RUN_RE.test(stage)) continue
    /** @type {'own'|'hidden'|'mixed'} */
    let status = 'own'
    for (let j = i + 1; j + 1 < pieces.length; j += 2) {
      const sep = pieces[j]
      const then = pieces[j + 1]
      if (sep === '&&' || (pipefail && (sep === '|' || sep === '|&'))) continue
      if (sep === '|' || sep === '|&' || sep === '||') {
        status = 'hidden'
        break
      }
      if (!REPORT_RE.test(then)) {
        status = 'mixed'
        break
      }
      status = 'hidden'
    }
    if (found === null || RANK[status] > RANK[found]) found = status
  }
  return found
}

/**
 * True when a test runner's summary in `text` says its run failed, false when one
 * says it passed (and none failed), null when `text` holds no summary
 * (`turn.py:132-139`).
 *
 * @param {unknown} text
 * @returns {boolean|null}
 */
export function runnerVerdict(text) {
  if (typeof text !== 'string' || text === '') return null
  if (RUN_FAILED_RE.test(text)) return true
  return RUN_PASSED_RE.test(text) ? false : null
}

/**
 * A POSIX-ish `shlex.split`: whitespace-separated words with quotes removed and
 * backslash escapes outside single quotes. Throws on an unbalanced quote, like
 * `shlex.split`.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function shlexSplit(text) {
  /** @type {string[]} */
  const out = []
  let current = ''
  let started = false
  /** @type {string|null} */
  let quote = null
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote !== null) {
      if (ch === quote) {
        quote = null
      } else if (quote === '"' && ch === '\\' && i + 1 < text.length) {
        i += 1
        current += text[i]
      } else {
        current += ch
      }
      started = true
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      started = true
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      if (started) {
        out.push(current)
        current = ''
        started = false
      }
      continue
    }
    if (ch === '\\' && i + 1 < text.length) {
      i += 1
      current += text[i]
      started = true
      continue
    }
    current += ch
    started = true
  }
  if (quote !== null) throw new Error('shlexSplit: unbalanced quote')
  if (started) out.push(current)
  return out
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
 * @param {number} fallback
 * @returns {number}
 */
function readNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function readInteger(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function tokenCost(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

/**
 * The loop guard for one prompt-turn, persisted between adapter callbacks via
 * {@link TurnGuard#toJSON} / {@link TurnGuard.fromJSON}.
 */
export class TurnGuard {
  /**
   * @param {{ turnKey?: string, data?: unknown }} [options]
   */
  constructor(options = {}) {
    const data = isPlainObject(options.data) ? options.data : {}
    this.turnKey = typeof data.turn_key === 'string' ? data.turn_key : (options.turnKey ?? '')
    /** @type {SpiralState} This segment's state; reset after a nudge. */
    this.st = SpiralState.fromJSON(data.st)
    /** @type {SpiralState} The whole turn's state; never reset. */
    this.whole = SpiralState.fromJSON(data.whole)
    /** @type {number} */
    this.cumTurns = readInteger(data.cum_turns, 0)
    /** @type {number} */
    this.segment = readInteger(data.segment, 0)
    /** @type {number} */
    this.nudgesDone = readInteger(data.nudges_done, 0)
    /** @type {boolean} */
    this.aborted = data.aborted === true
    /** @type {boolean} */
    this.abortDelivered = data.abort_delivered === true
    /** @type {GuardEvent[]} */
    this.events = Array.isArray(data.events)
      ? data.events.filter(isPlainObject).map((event) => /** @type {GuardEvent} */ (event))
      : []
    /** @type {number} */
    this.judgeLast = readInteger(data.judge_last, -999)
    /** @type {number} */
    this.judgeGap = readInteger(data.judge_gap, JUDGE_BASE_GAP)
    /** @type {number} */
    this.judgeCalls = readInteger(data.judge_calls, 0)
    /** @type {number} */
    this.judgeTokens = readNumber(data.judge_tokens, 0)
    /** @type {number} */
    this.writerTokens = readNumber(data.writer_tokens, 0)
    /** @type {number} */
    this.lastEdit = readInteger(data.last_edit, 0)
    /** @type {number} */
    this.lastVerify = readInteger(data.last_verify, 0)
    /** @type {boolean} */
    this.lastVerifyFailed = data.last_verify_failed === true
    /** @type {number} */
    this.edits = readInteger(data.edits, 0)
    /** @type {number} */
    this.verifications = readInteger(data.verifications, 0)
    /** @type {JudgePending|null} */
    this.judgePending = isPlainObject(data.judge_pending)
      ? {
        id: data.judge_pending.id,
        since: readNumber(data.judge_pending.since, 0),
        segment: readInteger(data.judge_pending.segment, 0),
      }
      : null
    /** @type {string|null} A redirect a background judge already wrote. */
    this.nudgeReady = typeof data.nudge_ready === 'string' && data.nudge_ready !== ''
      ? data.nudge_ready
      : null
  }

  /**
   * Serializable form (`turn.py:221-232`). Keys are upstream's snake_case: this
   * is the persisted per-turn compatibility surface.
   * @returns {TurnGuardDocument}
   */
  toJSON() {
    return {
      turn_key: this.turnKey,
      st: this.st.toJSON(),
      whole: this.whole.toJSON(),
      cum_turns: this.cumTurns,
      segment: this.segment,
      nudges_done: this.nudgesDone,
      aborted: this.aborted,
      abort_delivered: this.abortDelivered,
      events: this.events.slice(-20),
      judge_last: this.judgeLast,
      judge_gap: this.judgeGap,
      judge_calls: this.judgeCalls,
      judge_tokens: this.judgeTokens,
      writer_tokens: this.writerTokens,
      last_edit: this.lastEdit,
      last_verify: this.lastVerify,
      last_verify_failed: this.lastVerifyFailed,
      edits: this.edits,
      verifications: this.verifications,
      judge_pending: this.judgePending,
      nudge_ready: this.nudgeReady,
    }
  }

  /**
   * Rebuild a guard from its serialized form. Malformed input degrades to a fresh
   * guard rather than throwing.
   *
   * @param {unknown} data
   * @returns {TurnGuard}
   */
  static fromJSON(data) {
    return new TurnGuard({ data })
  }

  // ---- outcome tracking for the ended-green proxy -------------------------------------

  /**
   * @param {string} name
   * @param {Record<string, unknown>} args
   * @param {string} result
   * @param {number|null} exitCode
   * @param {string[]} [shellEdits]
   * @returns {void}
   */
  track(name, args, result, exitCode, shellEdits = []) {
    const tool = canonTool(name)
    if (EDIT_TOOLS.has(tool)) {
      this.lastEdit = this.cumTurns
      this.edits += 1
      return
    }
    const cmd = tool === 'bash' && typeof args.command === 'string' ? args.command : null
    const verifies = typeof cmd === 'string' && VERIFY_RE.test(cmd)
    if (shellEdits.length > 0) {
      // `sed -i ... && pytest`: the edit comes first, so the run verifies it.
      this.lastEdit = this.cumTurns - (verifies ? 1 : 0)
      this.edits += 1
    }
    if (verifies) {
      this.lastVerify = this.cumTurns
      this.verifications += 1
      if (exitCode !== null) {
        this.lastVerifyFailed = exitCode !== 0
      } else {
        // The host reported no exit code (e.g. content tools): the output decides.
        this.lastVerifyFailed = matchesErrorMarker(result)
      }
    }
  }

  /**
   * Did this turn END GREEN? The stand-in for the grader the envelope cannot have
   * (`turn.py:255-264`). Green unless a verification after the last edit failed.
   *
   * @param {boolean} [stoppedNormally]
   * @returns {boolean}
   */
  resolvedProxy(stoppedNormally = true) {
    return endedGreenProxy(this, stoppedNormally)
  }

  // ---- what the judge is told ---------------------------------------------------------

  /**
   * How the turn's last verification went, for the judge/digest
   * (`turn.py:272-277`).
   * @returns {string}
   */
  verificationState() {
    if (this.verifications === 0) {
      return 'No test or verification run has been seen in this turn.'
    }
    const state = this.lastVerifyFailed ? 'failed' : 'passed'
    const since = this.lastEdit > this.lastVerify ? ' There have been edits since.' : ''
    return `The last verification run ${state}.${since}`
  }

  /**
   * Replace the digest's "Tests are still NOT green." claim with the real
   * verification state (`turn.py:279-280`).
   *
   * @param {unknown} digest
   * @returns {string}
   */
  liveDigest(digest) {
    const text = typeof digest === 'string' ? digest : ''
    return text.replaceAll(NOT_GREEN, this.verificationState())
  }

  // ---- the judge, rate-limited with backoff -------------------------------------------

  /**
   * After a productive (`stuck: false`) verdict the gap grows by
   * `JUDGE_BASE_GAP` up to `JUDGE_MAX_GAP`; any other verdict resets it
   * (`turn.py:283-287`).
   *
   * @param {JudgeVerdict|null} verdict
   * @returns {void}
   */
  backoff(verdict) {
    if (verdict && verdict.stuck === false) {
      this.judgeGap = Math.min(JUDGE_MAX_GAP, this.judgeGap + JUDGE_BASE_GAP)
    } else {
      this.judgeGap = JUDGE_BASE_GAP
    }
  }

  /**
   * `_sampled` for a synchronous judge (`turn.py:289-303`).
   *
   * @param {JudgeLike} judge
   * @returns {(digest: string) => JudgeVerdict|null}
   */
  sampledJudge(judge) {
    return (digest) => {
      if (this.st.turns - this.judgeLast < this.judgeGap) return null
      this.judgeLast = this.st.turns
      this.judgeCalls += 1
      /** @type {JudgeVerdict|null} */
      let verdict = null
      try {
        verdict = typeof judge.judge === 'function' ? judge.judge(this.liveDigest(digest)) : null
      } catch {
        verdict = null
      }
      if (verdict) this.judgeTokens += judgeCost(verdict)
      this.backoff(verdict)
      return verdict
    }
  }

  /**
   * `_background` for a judge that runs detached: a verdict is taken whenever one
   * has come back, a new job starts under the same rate limit, and while one is
   * out the judge answers nothing — which `assessAbort` reads as throttled, the
   * same as a call the rate limit skipped. A pending job older than
   * `JUDGE_STALE_S` stops blocking the next one (`turn.py:305-330`).
   *
   * @param {JudgeLike} judge
   * @param {number} now Unix seconds.
   * @returns {(digest: string) => JudgeVerdict|null}
   */
  backgroundJudge(judge, now) {
    return (digest) => {
      const polled = typeof judge.poll === 'function'
        ? judge.poll(this)
        : { found: false, verdict: null }
      if (polled.found) {
        this.judgePending = null
        const verdict = polled.verdict ?? null
        if (verdict) {
          const written = typeof verdict.nudge === 'string'
            ? verdict.nudge
            : typeof verdict._nudge === 'string' ? verdict._nudge : ''
          this.nudgeReady = written.trim() === '' ? null : written.trim()
        }
        this.backoff(verdict)
        return verdict
      }
      if (this.judgePending) {
        if (now - this.judgePending.since < JUDGE_STALE_S) return null
        this.judgePending = null // its job never answered
      }
      if (this.st.turns - this.judgeLast < this.judgeGap) return null
      this.judgeLast = this.st.turns
      this.judgeCalls += 1
      const job = typeof judge.start === 'function'
        ? judge.start(this, this.liveDigest(digest))
        : null
      if (job) this.judgePending = { id: job, since: now, segment: this.segment }
      return null
    }
  }

  // ---- one completed tool call --------------------------------------------------------

  /**
   * Fold one completed tool call; return the decision the adapter may deliver, or
   * null. `nudge` means inject `text` as context; `notice` means tell the person
   * (the adapter appends how to interrupt the turn — this module never stops it).
   *
   * A returned nudge is already applied to the guard: the segment state is reset
   * (upstream's `after_nudge`), so the adapter must not call {@link afterNudge}
   * again for the same decision.
   *
   * @param {GuardToolCall} toolCall
   * @param {FoldOptions} [options]
   * @returns {GuardDecision|null}
   */
  fold(toolCall, options = {}) {
    const call = isPlainObject(toolCall) ? toolCall : {}
    const name = typeof call.tool === 'string'
      ? call.tool
      : typeof call.name === 'string' ? call.name : ''
    const args = isPlainObject(call.args) ? call.args : {}
    const result = typeof call.resultText === 'string'
      ? call.resultText
      : typeof call.result === 'string' ? call.result : ''
    /** @type {number|null} */
    let exitCode = typeof call.exitCode === 'number' && Number.isFinite(call.exitCode)
      ? call.exitCode
      : null
    const hostFailed = typeof call.failed === 'boolean' ? call.failed : null
    const thr = options.thr ?? DEFAULT_THRESHOLDS
    const envelope = options.envelope ?? null
    const judge = options.judge ?? null
    const nudgeBudget = options.nudgeBudget ?? 1
    const now = typeof options.now === 'number' ? options.now : Date.now() / 1000

    const canon = canonTool(name)
    const cmd = canon === 'bash' && typeof args.command === 'string' ? args.command : null
    const shellEdits = cmd === null ? [] : shellEditTargets(cmd)
    const status = statusOfTests(cmd)
    if (status === 'hidden' || status === 'mixed') {
      const verdict = runnerVerdict(result)
      if (verdict !== null) exitCode = verdict ? 1 : 0
      else if (status === 'hidden') exitCode = null
    }
    // Upstream derives `failed` only from the exit code; DSH also reports an
    // `isError` flag, used only when no exit code could be recovered.
    const failed = exitCode !== null ? exitCode !== 0 : hostFailed

    this.st.update(name, args, result, failed)
    this.whole.update(name, args, result, failed)
    foldShellEdits(this.st, shellEdits)
    foldShellEdits(this.whole, shellEdits)
    this.cumTurns += 1
    this.track(name, args, result, exitCode, shellEdits)
    if (this.aborted) return null

    // Hard cumulative backstop, with the "nudge first" ladder.
    let backstop = typeof thr.backstop_turns === 'number' ? thr.backstop_turns : null
    if (backstop === null && envelope !== null) backstop = envelope * thr.backstop_mult
    if (backstop !== null && this.cumTurns >= backstop && isStuck(this.st, thr)) {
      const reason = `cum-backstop:${this.cumTurns}>=${backstop.toFixed(0)}t`
      if (this.nudgesDone < nudgeBudget) return this.stop('nudge', reason, envelope, options)
      return this.stop('abort', reason, envelope, options)
    }

    /** @type {((digest: string) => JudgeVerdict|null)|null} */
    let wired = null
    // The live plugin does not consult a judge in a repository whose usual turns
    // it has not learned yet (`plugin/controller.py:290-291`): the envelope-only
    // fallback cannot act on a cold repository either, so cold start never
    // intervenes. Enforced here so the adapter cannot accidentally pay for a
    // judge call on an unlearned repository.
    if (judge !== null && envelope !== null) {
      if (typeof judge.poll === 'function' && typeof judge.start === 'function') {
        wired = this.backgroundJudge(judge, now)
      } else if (typeof judge.judge === 'function') {
        wired = this.sampledJudge(judge)
      }
    }
    const decision = assessAbort(this.st, { envelope, judge: wired, thr })
    if (!decision.abort) {
      if (
        thr.nudge_on_ambiguous
        && decision.reason === 'judge-ambiguous-spared'
        && this.nudgesDone < nudgeBudget
      ) {
        return this.stop('nudge', 'ambiguous-past-envelope', envelope, options)
      }
      return null
    }
    if (this.nudgesDone < nudgeBudget) return this.stop('nudge', decision.reason, envelope, options)
    return this.stop('abort', decision.reason, envelope, options)
  }

  /**
   * Record a visible action. Only `abort` marks the turn aborted; the returned
   * decision is what the adapter delivers. A nudge computes its redirect text and
   * resets the segment state (`turn.py:387-424`).
   *
   * @param {'nudge'|'abort'} kind
   * @param {string} reason
   * @param {number|null} envelope
   * @param {FoldOptions} options
   * @returns {GuardDecision}
   */
  stop(kind, reason, envelope, options) {
    this.events.push({
      segment: this.segment,
      action: kind,
      turn_in_segment: this.st.turns,
      cum_turns: this.cumTurns,
      envelope,
      reason,
      snapshot: this.st.snapshot(),
    })
    if (kind === 'abort') {
      this.aborted = true
      this.abortDelivered = true
      return { action: 'notice', reason, text: this.noticeText(reason) }
    }
    const writer = typeof options.writer === 'function'
      ? options.writer
      : options.judge && typeof options.judge.writer === 'function'
        ? options.judge.writer
        : null
    const text = this.nudgeBody({ envelope: envelope ?? null, writer })
    this.afterNudge()
    return { action: 'nudge', reason, text }
  }

  /**
   * The "still stuck" notice text. The adapter appends the person's way to stop
   * the turn (upstream per-host `stop_hint`); the guard only supplies the
   * measurement, never a stop call.
   *
   * @param {string} reason
   * @returns {string}
   */
  noticeText(reason) {
    const short = reason.split(':')[0]
    return `TokenEconomizer: this turn still looks stuck after a redirect (${short}, ${this.cumTurns} tool calls).`
  }

  /**
   * The redirect text: the one a background judge already wrote with its verdict,
   * else an LLM-written one when a writer is wired, else the count template
   * (`nudgeText`), which mirrors only the agent's own actions
   * (`turn.py:396-413`).
   *
   * @param {{ envelope?: number|null, writer?: NudgeWriter|null }} [options]
   * @returns {string}
   */
  nudgeBody(options = {}) {
    if (this.nudgeReady) {
      const ready = this.nudgeReady
      this.nudgeReady = null
      return ready
    }
    const writer = options.writer ?? null
    if (writer) {
      /** @type {{ text?: string, tokens?: number, _tokens?: number }|null} */
      let out = null
      try {
        out = writer(this.liveDigest(this.st.recentDigest(24, options.envelope ?? null)))
      } catch {
        out = null
      }
      if (out) {
        this.writerTokens += tokenCost(out.tokens ?? out._tokens)
        const text = typeof out.text === 'string' ? out.text.trim() : ''
        if (text) return text
      }
    }
    return nudgeText(this.st)
  }

  /**
   * Start the post-nudge segment with a fresh state: the agent's fair
   * re-assessment window (`turn.py:415-424`). {@link fold} calls this itself when
   * it returns a nudge; call it directly only when the adapter built its own
   * redirect.
   *
   * @returns {void}
   */
  afterNudge() {
    this.nudgesDone += 1
    this.segment += 1
    this.st = new SpiralState()
    this.judgeLast = -999
    this.judgeGap = JUDGE_BASE_GAP
    this.judgePending = null // a verdict on the old segment is about the old one
    this.nudgeReady = null
  }

  /**
   * Per-turn summary for the ledger (`turn.py:426-431`).
   *
   * @param {boolean} [stoppedNormally]
   * @returns {{ turn_key: string, tool_calls: number, nudges: number, aborted: boolean,
   *   resolved_proxy: boolean, edits: number, verifications: number,
   *   judge_tokens: number, writer_tokens: number }}
   */
  summary(stoppedNormally = true) {
    return {
      turn_key: this.turnKey,
      tool_calls: this.cumTurns,
      nudges: this.nudgesDone,
      aborted: this.aborted,
      resolved_proxy: this.resolvedProxy(stoppedNormally),
      edits: this.edits,
      verifications: this.verifications,
      judge_tokens: this.judgeTokens,
      writer_tokens: this.writerTokens,
    }
  }
}

/**
 * Effective-token cost carried on a judge verdict (`_tokens` upstream, `tokens`
 * here; both tolerated).
 *
 * @param {JudgeVerdict} verdict
 * @returns {number}
 */
function judgeCost(verdict) {
  return tokenCost(verdict.tokens ?? verdict._tokens)
}
