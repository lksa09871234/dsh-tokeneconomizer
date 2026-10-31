/**
 * What the loop guard reads off a trajectory: a per-call fold of its failure-loop
 * signals.
 *
 * A `SpiralState` is updated once per completed tool call and keeps only counts
 * and a short, leakage-safe action log: edits per file, files edited, error
 * outputs, verification runs, and how often a failure repeats one seen before
 * (`stagnation`, the signal that separates a loop from a hard but productive
 * grind). Nothing from file contents, edit bodies, view output, or the task text
 * is retained — the digest is the only thing an optional model judge ever sees.
 *
 * Faithful port of `tokeneconomizer/loopguard/state.py` (Apache-2.0 upstream,
 * microsoft/TokenEconomizer @ e428fc91b0f8ffecb5a596d56b14fe2f1485a5f9). The
 * host-specific `completed_calls` stream parser is not ported: the DSH adapter
 * supplies already-paired calls (see lib/dsh/normalize.js).
 *
 * @module dsh-tokeneconomizer/loopguard/state
 */

import { createHash } from 'node:crypto'

/**
 * An output that RAN code to verify behavior (the test/repro step of the
 * edit->test loop).
 * @type {RegExp}
 */
export const TEST_RUN_RE = /(runtests(\.py)?|\bpytest\b|py\.test|manage\.py\s+test|python\s+-m\s+unittest|\btox\b|\bnox\b|\btrial\b|python\d?\s+-c\b)/i

/**
 * Error/failure markers in a tool output. This is the case-insensitive half of
 * upstream's `ERR_RE`; the three all-caps alternatives that must stay
 * case-sensitive (`--- FAIL: `, `FAIL\t`, `FAIL$`) live in
 * {@link ERR_RE_CASE_SENSITIVE} and are combined by
 * {@link matchesErrorMarker}. Splitting them keeps the same semantics without a
 * scoped inline-flag group, which JavaScript regular expressions do not support.
 * @type {RegExp}
 */
export const ERR_RE = /(Traceback \(most recent call last\)|\b\w*Error\b|\bFAILED\b|\bassert\b|Exception|errors during collection|^# fail [1-9]|^not ok \d|\b[1-9]\d* (?:failing|failures?)\b|Failures: [1-9])/im

/**
 * The case-sensitive tail of upstream's `ERR_RE` (other ecosystems' failing-test
 * summaries that name no error).
 * @type {RegExp}
 */
export const ERR_RE_CASE_SENSITIVE = /^(?:--- FAIL: |FAIL\t|FAIL$)/m

/** Tools whose output is file content, not the outcome of running anything. */
const CONTENT_TOOLS = new Set(['view', 'grep', 'glob'])

/** Tools that count as an edit after canonicalization. */
const EDIT_TOOLS = new Set(['edit', 'str_replace', 'create'])

/**
 * Normalize agent-specific tool names to the copilot-style canonical names the
 * folding logic keys on, so one code path handles every host's schema. Unknown
 * names pass through unchanged. Upstream map plus DSH tool spellings (built-in
 * fs tools and the native ops tools) so the adapter can pass names verbatim.
 * @type {Readonly<Record<string, string>>}
 */
const TOOL_CANON = Object.freeze({
  // upstream mapping (`state.py:38-50`)
  bash: 'bash',
  shell: 'bash',
  read: 'view',
  view: 'view',
  grep: 'grep',
  glob: 'glob',
  edit: 'edit',
  multiedit: 'edit',
  str_replace: 'edit',
  apply_patch: 'edit',
  write: 'create',
  create: 'create',
  // DSH spellings (the adapter may pass raw DSH tool ids)
  pwsh: 'bash',
  powershell: 'bash',
  terminal: 'bash',
  ops_bash: 'bash',
  exec_command: 'bash',
  run_command: 'bash',
  shell_command: 'bash',
  read_file: 'view',
  read_files: 'view',
  inspect_local_file: 'view',
  edit_file: 'edit',
  multi_edit: 'edit',
  replace_in_file: 'edit',
  write_file: 'create',
  create_file: 'create',
  search_files: 'grep',
  search_content: 'grep',
  list_files: 'glob',
  find_files: 'glob',
})

/** Cap on the leakage-safe action log kept in memory (`state.py:211-212`). */
export const RECENT_LIMIT = 40

/**
 * Canonicalize a tool name. Unknown names pass through unchanged; an absent or
 * empty name becomes `"?"` (upstream `canon_tool`, `state.py:49-50`).
 *
 * @param {unknown} name
 * @returns {string}
 */
export function canonTool(name) {
  const raw = name === undefined || name === null ? '' : String(name)
  const lower = raw.toLowerCase()
  return TOOL_CANON[lower] ?? (raw || '?')
}

/**
 * The final path component of a path. Handles both POSIX `/` and Windows `\`
 * separators (upstream is POSIX-only; DSH runs on Windows too).
 *
 * @param {unknown} p
 * @returns {string}
 */
export function basename(p) {
  if (typeof p !== 'string' || p === '') return ''
  const trimmed = p.replace(/[\\/]+$/, '')
  if (trimmed === '') return ''
  const parts = trimmed.split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}

/**
 * Whether a text carries any error/failure marker. Upstream's single `ERR_RE`
 * test (`state.py:199`, `turn.py:253`).
 *
 * @param {unknown} text
 * @returns {boolean}
 */
export function matchesErrorMarker(text) {
  if (typeof text !== 'string' || text === '') return false
  ERR_RE.lastIndex = 0
  ERR_RE_CASE_SENSITIVE.lastIndex = 0
  return ERR_RE.test(text) || ERR_RE_CASE_SENSITIVE.test(text)
}

/**
 * A normalized signature of a failing output: drop numbers/addresses/paths so
 * two runs that fail the SAME way hash identically (used to detect "no progress"
 * — the same failure recurring after edits). Leakage-safe: a hash, never the
 * content. Upstream `_failure_sig` (`state.py:120-134`).
 *
 * @param {unknown} text
 * @returns {string|null} 10 hex characters, or null when no error line exists.
 */
export function failureSignature(text) {
  if (typeof text !== 'string' || text === '') return null
  let first = null
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (matchesErrorMarker(line)) {
      first = line
      break
    }
  }
  if (first === null) return null
  const normalized = first.replace(/0x[0-9a-f]+|\d+|\/\S+/g, '').trim()
  return createHash('md5').update(normalized, 'utf8').digest('hex').slice(0, 10)
}

/**
 * @typedef {object} SpiralSnapshot
 * @property {number} turns
 * @property {number} edit_churn
 * @property {number} distinct_edit_files
 * @property {number} error_outputs
 * @property {number} test_runs
 * @property {number} stagnation
 * @property {number} repeated_fail_sigs
 */

/**
 * @typedef {object} SpiralStateDocument
 * @property {number} turns
 * @property {Record<string, number>} edit_counts
 * @property {string[]} edit_order
 * @property {number} error_outputs
 * @property {number} test_runs
 * @property {Record<string, number>} fail_sigs
 * @property {number} repeated_fail_sigs
 * @property {string[]} recent
 */

/**
 * Compact, incremental fold of one trajectory's spiral signals. Cheap to update
 * per event so it can run live.
 *
 * Field names are camelCase in JavaScript; the serialized document and
 * `snapshot()` keep upstream's snake_case keys because they are the persisted
 * compatibility surface (`envelope.json`, session records).
 */
export class SpiralState {
  constructor() {
    /** @type {number} Completed tool calls folded into this state. */
    this.turns = 0
    /** @type {Record<string, number>} Basename -> edit count. */
    this.editCounts = /** @type {Record<string, number>} */ (Object.create(null))
    /** @type {string[]} Ordered basenames of edit targets. */
    this.editOrder = []
    /** @type {number} Tool outputs carrying an error/failure marker. */
    this.errorOutputs = 0
    /** @type {number} Code-execution verification steps. */
    this.testRuns = 0
    /** @type {Record<string, number>} Failure signature -> count. */
    this.failSigs = /** @type {Record<string, number>} */ (Object.create(null))
    /** @type {number} Failing outputs that REPEAT an earlier signature. */
    this.repeatedFailSigs = 0
    /** @type {string[]} Leakage-safe rolling log of recent actions. */
    this.recent = []
  }

  /** @returns {number} The busiest file's edit count. */
  get editChurn() {
    let max = 0
    for (const count of Object.values(this.editCounts)) {
      if (count > max) max = count
    }
    return max
  }

  /** @returns {number} How many distinct files were edited. */
  get distinctEditFiles() {
    return Object.keys(this.editCounts).length
  }

  /**
   * Fraction of failing outputs that repeat an earlier identical failure (the
   * agent edited but the SAME failure came back = no progress). 0 with no fails.
   * @returns {number}
   */
  get stagnation() {
    let total = 0
    for (const count of Object.values(this.failSigs)) total += count
    return total > 0 ? this.repeatedFailSigs / total : 0
  }

  /**
   * Fold one completed tool call into the state.
   *
   * @param {unknown} toolName Host-reported tool name (canonicalized here).
   * @param {unknown} args Parsed tool arguments.
   * @param {unknown} resultText Model-facing result text.
   * @param {boolean|number|null} [failed] What the agent reported about the call: true
   *   for a non-zero exit or a tool error, false for success, null/undefined when
   *   it did not say. `0`/`1` are tolerated as false/true. Decides whether the
   *   output can be a failing one.
   * @returns {void}
   */
  update(toolName, args, resultText, failed = null) {
    this.turns += 1
    const toolArgs = isPlainObject(args) ? args : {}
    const tool = canonTool(toolName)
    let action = tool || '?'

    if (EDIT_TOOLS.has(tool)) {
      const target = basename(firstString(toolArgs, ['path', 'filePath', 'file_path']))
      if (target) {
        this.editOrder.push(target)
        this.editCounts[target] = (this.editCounts[target] ?? 0) + 1
        action = `edit ${target}`
      }
    }

    const cmd = tool === 'bash' && typeof toolArgs.command === 'string' ? toolArgs.command : ''
    if (cmd) {
      const short = cmd.trim().replace(/\s+/g, ' ').slice(0, 90)
      action = `$ ${short}`
      if (TEST_RUN_RE.test(cmd)) this.testRuns += 1
    } else if (tool === 'grep' || tool === 'glob') {
      action = `${tool} ${String(toolArgs.pattern ?? '').slice(0, 40)}`
    } else if (tool === 'view') {
      action = `view ${basename(firstString(toolArgs, ['path', 'file_path']))}`
    }

    /** @type {string|null} */
    let fail = null
    const reported = failed === true || failed === 1
      ? true
      : failed === false || failed === 0 ? false : null
    const canFail = CONTENT_TOOLS.has(tool) ? reported === true : reported !== false
    const text = typeof resultText === 'string' ? resultText : ''
    if (text && canFail && matchesErrorMarker(text)) {
      this.errorOutputs += 1
      const sig = failureSignature(text)
      if (sig) {
        fail = sig
        if (sig in this.failSigs) this.repeatedFailSigs += 1
        this.failSigs[sig] = (this.failSigs[sig] ?? 0) + 1
      }
    }

    // Rolling leakage-safe action log (tool name / command / search /
    // error-SIGNATURE only), capped to the recent window.
    const tag = fail ? `  [err#${fail}]` : ''
    this.recent.push(`${String(this.turns).padStart(3)}: ${action}${tag}`)
    if (this.recent.length > RECENT_LIMIT) this.recent = this.recent.slice(-RECENT_LIMIT)
  }

  /**
   * A compact, leakage-safe digest of the agent's RECENT PROCESS for the
   * optional judge: commands/searches/edited basenames and error-signature
   * markers only — never file contents, edit bodies, view output, or the task
   * text (`state.py:214-232`). `envelope` (this repository's typical resolved
   * turn length) is passed as CONTEXT so a judge can recognize an
   * abnormally-long trajectory as a likely dead-end.
   *
   * @param {number} [n] Actions shown (upstream default 24).
   * @param {number|null} [envelope] Learned resolved-turn length in tool calls.
   * @returns {string}
   */
  recentDigest(n = 24, envelope = null) {
    let head = `turns=${this.turns} edit_churn=${this.editChurn} `
      + `distinct_edit_files=${this.distinctEditFiles} `
      + `error_outputs=${this.errorOutputs} test_runs=${this.testRuns} `
      + `repeated_identical_failures=${this.repeatedFailSigs} `
      + `stagnation=${this.stagnation.toFixed(2)}`
    if (envelope) {
      const ratio = this.turns / envelope
      head += `\nrepo_context: tasks here usually RESOLVE within ~${envelope.toFixed(0)} `
        + `turns; this trajectory is at ${this.turns} turns = ${ratio.toFixed(1)}x that `
        + 'typical length. Tests are still NOT green. A trajectory far past the typical '
        + 'resolved length with recurring failures is likely a dead-end loop, even if it '
        + 'touches many files.'
    }
    return `${head}\nRecent actions (oldest->newest):\n${this.recent.slice(-n).join('\n')}`
  }

  /**
   * The per-task signal snapshot stored in the learned envelope
   * (`state.py:234-239`). Keys are upstream's snake_case: they are persisted in
   * `envelope.json`.
   *
   * @returns {SpiralSnapshot}
   */
  snapshot() {
    return {
      turns: this.turns,
      edit_churn: this.editChurn,
      distinct_edit_files: this.distinctEditFiles,
      error_outputs: this.errorOutputs,
      test_runs: this.testRuns,
      stagnation: Math.round(this.stagnation * 1000) / 1000,
      repeated_fail_sigs: this.repeatedFailSigs,
    }
  }

  /**
   * Serializable form (upstream `state_to_dict`, `turn.py:176-177`).
   * @returns {SpiralStateDocument}
   */
  toJSON() {
    /** @type {Record<string, number>} */
    const editCounts = {}
    for (const [file, count] of Object.entries(this.editCounts)) editCounts[file] = count
    /** @type {Record<string, number>} */
    const failSigs = {}
    for (const [sig, count] of Object.entries(this.failSigs)) failSigs[sig] = count
    return {
      turns: this.turns,
      edit_counts: editCounts,
      edit_order: [...this.editOrder],
      error_outputs: this.errorOutputs,
      test_runs: this.testRuns,
      fail_sigs: failSigs,
      repeated_fail_sigs: this.repeatedFailSigs,
      recent: [...this.recent],
    }
  }

  /**
   * Rebuild a state from its serialized form. Malformed input degrades to a
   * fresh state rather than throwing (a corrupt session record must not break a
   * session).
   *
   * @param {unknown} data
   * @returns {SpiralState}
   */
  static fromJSON(data) {
    const state = new SpiralState()
    if (!isPlainObject(data)) return state
    const record = /** @type {Record<string, unknown>} */ (data)
    state.turns = nonNegativeInteger(record.turns)
    state.editCounts = numberRecord(record.edit_counts)
    state.editOrder = stringArray(record.edit_order)
    state.errorOutputs = nonNegativeInteger(record.error_outputs)
    state.testRuns = nonNegativeInteger(record.test_runs)
    state.failSigs = numberRecord(record.fail_sigs)
    state.repeatedFailSigs = nonNegativeInteger(record.repeated_fail_sigs)
    state.recent = stringArray(record.recent).slice(-RECENT_LIMIT)
    return state
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * First non-empty string among `keys`, or `''`.
 *
 * @param {Record<string, unknown>} args
 * @param {string[]} keys
 * @returns {string}
 */
function firstString(args, keys) {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function nonNegativeInteger(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/**
 * @param {unknown} value
 * @returns {Record<string, number>}
 */
function numberRecord(value) {
  /** @type {Record<string, number>} */
  const out = /** @type {Record<string, number>} */ (Object.create(null))
  if (!isPlainObject(value)) return out
  for (const [key, count] of Object.entries(value)) {
    if (typeof count === 'number' && Number.isFinite(count) && count > 0) out[key] = count
  }
  return out
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function stringArray(value) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string')
}
