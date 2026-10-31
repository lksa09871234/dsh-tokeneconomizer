/**
 * Environment facts: micro-skills learned for free from recurring failures.
 *
 * Ported from `tokeneconomizer/microskills/envfacts.py` (Apache-2.0,
 * microsoft/TokenEconomizer @ e428fc9). Modified for the DSH port:
 *
 * - `EnvFactsDistiller` becomes `EnvFactsModel`, whose `update` takes the
 *   already-classified observation digest (`observe.observeSession` output)
 *   instead of a transcript path -- keeping observation and fact formation
 *   separate, and the mechanism free of host readers;
 * - persistence helpers write/read plain JSON documents (the adapter stores
 *   them through `lib/store.js`); there are no filesystem calls here;
 * - every learned string is sanitized to one line at render time (UPSTREAM §8.1
 *   weakness 1) and the reward block is never delimited here: the adapter wraps
 *   it with `stage.renderProvenance`;
 * - `debugRow` becomes `factsView()` (a row array for status output).
 *
 * As a repository's sessions finish, this model looks for RECURRING SHAPES OF
 * EVIDENCE that an agent rediscovers the same environment fact by failing at it,
 * session after session. When a shape recurs, it becomes a one-line declarative
 * fact, injected at the start of the next session. Every specific string in a
 * rendered fact -- an interpreter path, a runner form, a refused host -- is a
 * PARAMETER learned from the sessions; nothing here names a path, an environment
 * manager, a repository or a benchmark.
 *
 * The families:
 *
 *   FormRepair   in one session, form A of an intent fails with an infrastructure
 *                error and a later form B succeeds. Retires when a bare form runs
 *                the test runner successfully.
 *   Boundary     every call of an operation class fails with one environmental
 *                error class and none succeeds. Retires when a fetch succeeds.
 *   EmptyProbe   discovery probes of one kind return nothing in every session.
 *                Retires -- hard -- the moment a probe returns something.
 *   ArgRepair    the runner cannot load a label of one shape and, run the same
 *                way, loads it rewritten into another shape.
 *   EnvValue     code fails asking for an environment variable by name, and a
 *                later run that sets it succeeds.
 *
 * Each fact goes through the shared `lifecycle`. No LLM is involved:
 * `opt_tokens` is 0. The block is capped at MAX_FACTS and MAX_TOKENS, and a lint
 * refuses any fact that reads as completion or verification advice.
 *
 * @module dsh-tokeneconomizer/microskills/envfacts
 */

import { Lifecycle } from './lifecycle.js'
import {
  DEFAULT_VOCAB,
  GENERIC,
  NODE_WEB,
  NETWORK_ERRORS,
  PYTHON_GIT,
  formFailed,
  formWorked,
  isBare,
  labelRule,
} from './observe.js'

/** @typedef {import('./observe.js').Observation} Observation */
/** @typedef {import('./observe.js').Vocabulary} Vocabulary */

/** Upstream state subdirectory name (§3.2; kept so a future import/export maps 1:1). */
export const STATE_SUBDIR = 'envfacts_state'
/** Maximum rendered facts per session. Upstream: `MAX_FACTS`, envfacts.py:44. */
export const MAX_FACTS = 4
/** Approximate token cap (`~4 chars per token`), header included. Upstream: envfacts.py:45. */
export const MAX_TOKENS = 150
/** Non-generic header. Upstream: `HEADER`, envfacts.py:46. */
export const HEADER = '# environment facts learned from earlier tasks in this checkout'
/** The plugin's header: a person's work comes in sessions, not tasks. Upstream: envfacts.py:48. */
export const GENERIC_HEADER = '# environment facts learned from earlier sessions in this repository'

/**
 * Words that would turn a fact into completion or verification advice.
 * Upstream: `_LINT_RE`, envfacts.py:50-52.
 */
export const LINT_RE = /\b(skip|no need|don'?t|do not|stop|done|completed?|finish(?:ed)?|verify|verification|instead of (?:running|testing))\b/i

/**
 * How a rendered fact names an environmental error class.
 * Upstream: `_ERROR_PHRASE`, envfacts.py:54-60.
 *
 * @type {Record<string, string>}
 */
export const ERROR_PHRASE = {
  module_missing: 'ModuleNotFoundError',
  command_missing: 'command not found',
  script_missing: 'a file-not-found error',
  usage_error: 'a usage error',
  permission_denied: 'permission denied',
}

/** FormRepair: consecutive contradicted tasks before one counts (envfacts.py:146). */
export const CONTRADICT_STREAK = 2

/**
 * Selection priority per family. Upstream: `_select`, envfacts.py:278-279.
 *
 * @type {Record<string, number>}
 */
const FAMILY_PRIORITY = { form_repair: 0, arg_repair: 1, env_value: 2, empty_probe: 3, boundary: 4 }

// --------------------------------------------------------------------------------------
// sanitization
// --------------------------------------------------------------------------------------

/**
 * Collapse any learned string to one line: control characters, newlines and
 * Unicode line separators become spaces. Applied to every rendered line; a
 * rendered fact can therefore never inject a new instruction line (UPSTREAM §8.1
 * weakness 1, the upstream behavior this port hardens).
 *
 * @param {unknown} value
 * @returns {string}
 */
export function sanitizeOneLine(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// --------------------------------------------------------------------------------------
// fact helpers
// --------------------------------------------------------------------------------------

/**
 * A plain numeric counter map from a fact's params; creates it when absent and
 * drops non-numeric entries from a corrupt document.
 *
 * @param {Record<string, any>} target
 * @param {string} key
 * @returns {Record<string, number>}
 */
function countRecord(target, key) {
  const value = target[key]
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    /** @type {Record<string, number>} */
    const fresh = {}
    target[key] = fresh
    return fresh
  }
  const record = /** @type {Record<string, number>} */ (value)
  for (const [name, count] of Object.entries(record)) {
    if (typeof count !== 'number' || !Number.isFinite(count)) delete record[name]
  }
  return record
}

/**
 * A copy of a numeric counter map, without mutating the fact.
 *
 * @param {unknown} value
 * @returns {Record<string, number>}
 */
function numericRecord(value) {
  /** @type {Record<string, number>} */
  const out = {}
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [name, count] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
      if (typeof count === 'number' && Number.isFinite(count)) out[name] = count
    }
  }
  return out
}

/**
 * @param {unknown} value
 * @returns {Record<string, any>}
 */
function objectRecord(value) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return /** @type {Record<string, any>} */ (value)
  return {}
}

/**
 * A form that moves the shell (`cd tests && python runtests.py`). Upstream:
 * `_moves_shell`, envfacts.py:184-185.
 *
 * @param {string} form
 * @returns {boolean}
 */
function movesShell(form) {
  return form.startsWith('cd ') && form.includes(' && ')
}

/**
 * A form as a claim shows it. One that starts with `cd DIR &&` is shown as a
 * subshell: an agent whose shell keeps its directory between calls that typed
 * the bare `cd` would run every later command in DIR, where the next `cd DIR`
 * fails.
 *
 * Upstream: `_usage`, envfacts.py:188-192.
 *
 * @param {string} form
 * @param {string} [args]
 * @returns {string}
 */
export function usage(form, args = ' …') {
  return movesShell(form) ? `\`(${form}${args})\`` : `\`${form}${args}\``
}

/**
 * The part of a working form that carries the environment: its activation
 * prefix, or the directory of its explicit path.
 *
 * Upstream: `_root`, envfacts.py:195-203.
 *
 * @param {string} form
 * @returns {string}
 */
export function rootKey(form) {
  if (form.includes(' && ')) return form.split(' && ')[0]
  if (['conda run', 'poetry run', 'pipenv run', 'uv run', 'npx'].some((prefix) => form.startsWith(prefix))) {
    return form.split(/\s+/).slice(0, 3).join(' ')
  }
  const head = form.split(/\s+/)[0] ?? ''
  if (!head.includes('/')) return head
  const parts = head.split('/')
  return parts.slice(0, -1).join('/')
}

/**
 * "a", "a and b", "a, b and c"; "the hosts it tried" for none.
 * Upstream: `_join`, envfacts.py:206-212.
 *
 * @param {Iterable<string>} items
 * @returns {string}
 */
export function join(items) {
  const list = [...items]
  if (list.length === 0) return 'the hosts it tried'
  if (list.length === 1) return list[0]
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
}

/**
 * Whether a claim may be injected: it must not read as completion or
 * verification advice. Upstream: `lint_ok`, envfacts.py:215-216.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function lintOk(text) {
  return !LINT_RE.test(String(text ?? ''))
}

/**
 * The domain vocabulary named by a persisted state document.
 *
 * @param {unknown} name
 * @returns {Vocabulary}
 */
export function vocabularyByName(name) {
  if (name === 'python-git') return PYTHON_GIT
  if (name === 'node-web') return NODE_WEB
  return DEFAULT_VOCAB === GENERIC ? GENERIC : DEFAULT_VOCAB
}

// --------------------------------------------------------------------------------------
// facts
// --------------------------------------------------------------------------------------

/**
 * One learned environment fact: a family, a parameter bag and a lifecycle.
 *
 * Upstream: `EnvFact`, envfacts.py:66-143. The persisted shape is upstream's
 * `to_dict` verbatim (`{id, family, params, life}`).
 */
export class EnvFact {
  /**
   * @param {string} id
   * @param {string} family `form_repair` | `arg_repair` | `env_value` | `empty_probe` | `boundary`.
   * @param {boolean} high High-stakes fact: one clean contradiction retires it.
   * @param {Record<string, any>} [params]
   */
  constructor(id, family, high, params = {}) {
    /** @type {string} */
    this.id = id
    /** @type {string} */
    this.family = family
    /** @type {Record<string, any>} */
    this.params = params
    // An environment fact holds or not whatever files a session edits: in a
    // small repository where every session touches the same module, three
    // sessions missing `pytest` are three confirmations (envfacts.py:70-74).
    /** @type {Lifecycle} */
    this.life = new Lifecycle(id, high, false)
  }

  // ---- lifecycle passthrough ----

  /** @returns {import('./lifecycle.js').LifecycleState} */
  get state() {
    return this.life.state
  }

  /** @returns {boolean} */
  injectable() {
    return this.life.injectable()
  }

  /** @returns {number} */
  firingRate() {
    return this.life.firingRate()
  }

  // ---- rendering ----

  /**
   * The one-line declarative fact, sanitized to a single line. Empty when the
   * fact makes no claim (a FormRepair with no working form left).
   *
   * Upstream: `claim`, envfacts.py:88-117.
   *
   * @returns {string}
   */
  claim() {
    return sanitizeOneLine(this.rawClaim())
  }

  /**
   * @returns {string}
   */
  rawClaim() {
    const params = this.params
    if (this.family === 'form_repair') {
      const working = this.workingForm()
      if (working === null) return ''
      const error = this.best('error_counts') ?? 'module_missing'
      return `${usage(String(params.a ?? ''))} fails here with ${ERROR_PHRASE[error] ?? error}; ${usage(working)} works.`
    }
    if (this.family === 'boundary') {
      const hosts = Object.entries(numericRecord(params.hosts))
        .sort((left, right) => right[1] - left[1])
        .slice(0, 3)
        .map(([host]) => host)
      return `Outbound connections to ${join(hosts)} are refused here; nothing can be fetched from them.`
    }
    if (this.family === 'arg_repair') {
      if (params.kind === 'sep') {
        return `${usage(String(params.form ?? ''), '')} takes dotted test labels (\`module.Class.test\`, not \`module::Class::test\`).`
      }
      const examples = objectRecord(params.examples)
      const keys = Object.keys(examples)
      const pairs = (keys.length > 0 ? keys : ['x x']).map((key) => {
        const cut = key.indexOf(' ')
        return cut < 0 ? [key, key] : [key.slice(0, cut), key.slice(cut + 1)]
      })
      let shortest = pairs[0]
      for (const pair of pairs) if (pair[0].length < shortest[0].length) shortest = pair
      const [badLabel, goodLabel] = shortest
      return `${usage(String(params.form ?? ''), '')} takes test labels without the \`${params.param}\` prefix (\`${goodLabel}\`, not \`${badLabel}\`).`
    }
    if (this.family === 'env_value') {
      const good = this.best('good') ?? ''
      const bad = Object.keys(numericRecord(params.bad)).sort().filter((value) => value !== good).slice(0, 1)
      return `Code that imports the project needs \`${params.var}\` set here: \`${params.var}=${good}\` works${bad.length > 0 ? `, \`${bad[0]}\` does not.` : '.'}`
    }
    if (this.family === 'empty_probe') {
      return 'This checkout has no git remote and no branches, tags or unreachable objects beyond HEAD; its history ends at the checked-out commit.'
    }
    return ''
  }

  /**
   * The most frequent key of a counter map (first one on a tie).
   * Upstream: `_best`, envfacts.py:119-121.
   *
   * @param {string} key
   * @returns {string|null}
   */
  best(key) {
    let bestKey = null
    let bestCount = Number.NEGATIVE_INFINITY
    for (const [name, count] of Object.entries(numericRecord(this.params[key]))) {
      if (count > bestCount) {
        bestCount = count
        bestKey = name
      }
    }
    return bestKey
  }

  /**
   * The working form a FormRepair names: the one with the best record -- sessions
   * it worked in as typed less sessions it failed in -- among those that leave
   * the shell where it is (`python tests/runtests.py`, not `cd tests && python
   * runtests.py`) whenever one of them has a good record at all. None when no
   * form has: then the fact makes no claim.
   *
   * Upstream: `working_form`, envfacts.py:123-132.
   *
   * @returns {string|null}
   */
  workingForm() {
    const counts = numericRecord(this.params.b_counts)
    const fails = numericRecord(this.params.b_fails)
    /** @type {Record<string, number>} */
    const net = {}
    for (const [form, count] of Object.entries(counts)) {
      const bad = fails[form] ?? 0
      if (count > bad) net[form] = count - bad
    }
    /** @type {Record<string, number>} */
    const still = {}
    for (const [form, count] of Object.entries(net)) if (!movesShell(form)) still[form] = count
    const pool = Object.keys(still).length > 0 ? still : net
    let bestForm = null
    let bestNet = Number.NEGATIVE_INFINITY
    let bestCount = Number.NEGATIVE_INFINITY
    for (const [form, count] of Object.entries(pool)) {
      const total = counts[form] ?? 0
      if (count > bestNet || (count === bestNet && total > bestCount)) {
        bestForm = form
        bestNet = count
        bestCount = total
      }
    }
    return bestForm
  }

  /** @returns {{id: string, family: string, params: Record<string, any>, life: import('./lifecycle.js').LifecycleDoc}} */
  toJSON() {
    return { id: this.id, family: this.family, params: this.params, life: this.life.toJSON() }
  }

  /**
   * Restore one fact from a persisted document. Throws on a document that is
   * not fact-shaped; the state-level loader (`stage.stateFromJSON`) skips such
   * facts instead of failing the whole state.
   *
   * Upstream: `from_dict`, envfacts.py:138-143 -- including the quirk that the
   * lifecycle's `drift` is forced back to false on load.
   *
   * @param {unknown} doc
   * @returns {EnvFact}
   */
  static fromJSON(doc) {
    if (doc === null || typeof doc !== 'object') throw new TypeError('EnvFact.fromJSON: document must be an object')
    const record = /** @type {Record<string, unknown>} */ (doc)
    if (typeof record.id !== 'string' || record.id === '') throw new TypeError('EnvFact.fromJSON: missing id')
    if (typeof record.family !== 'string' || record.family === '') throw new TypeError('EnvFact.fromJSON: missing family')
    const life = Lifecycle.fromJSON(record.life)
    const fact = new EnvFact(record.id, record.family, life.high, objectRecord(record.params))
    life.drift = false
    fact.life = life
    return fact
  }
}

/**
 * Fold one task's verdict into a fact's lifecycle.
 *
 * Two adjustments to the shared state machine (envfacts.py:149-167). A
 * high-stakes CANDIDATE that is contradicted retires at once (`Lifecycle`
 * hard-kills only ACTIVE facts): an image whose history continues past HEAD does
 * not become clean by being probed again. And a FormRepair contradiction -- the
 * bare form ran the test runner -- only counts after CONTRADICT_STREAK
 * consecutive exercised tasks said so: one task whose tests happened to need
 * none of the missing packages is not a fixed environment.
 *
 * @param {EnvFact} fact
 * @param {number} now Task index.
 * @param {'confirm'|'contradict'|null} verdict
 * @param {boolean} fired
 * @param {boolean} exercised
 * @param {Iterable<string>} files
 * @returns {void}
 */
export function foldFact(fact, now, verdict, fired, exercised, files) {
  let effective = verdict
  if (fact.family === 'form_repair' && exercised) {
    let streak = 0
    if (typeof fact.params.contra_streak === 'number' && Number.isFinite(fact.params.contra_streak)) {
      streak = fact.params.contra_streak
    }
    streak = effective === 'contradict' ? streak + 1 : 0
    fact.params.contra_streak = streak
    if (effective === 'contradict' && streak < CONTRADICT_STREAK) effective = null
  }
  fact.life.update(now, effective, fired, exercised, files)
  if (effective === 'contradict' && fact.life.high && fact.life.state === 'CANDIDATE') {
    fact.life.state = 'RETIRED'
    fact.life.retiredAt = now
  }
}

/**
 * The form worked exactly as typed: no `VAR=value` before it, which its form
 * leaves out, had to help.
 *
 * Upstream: `typed_ok`, envfacts.py:170-174.
 *
 * @param {Observation} observation
 * @returns {boolean}
 */
export function typedOk(observation) {
  return formWorked(observation) && !observation.env
}

/**
 * Can `form` stand in for the failing `aForm`? Another form -- and, outside test
 * runs and builds, not a bare one: only a fuller spelling repairs a bare
 * interpreter or package tool.
 *
 * Upstream: `_repairs`, envfacts.py:177-181.
 *
 * @param {string} form
 * @param {string} aForm
 * @param {string} intent
 * @returns {boolean}
 */
export function repairs(form, aForm, intent) {
  return form !== aForm && (intent === 'run_tests' || intent === 'run_build' || !isBare(form))
}

// --------------------------------------------------------------------------------------
// observation digest types
// --------------------------------------------------------------------------------------

/**
 * The classified session digest produced by `observe.observeSession`.
 *
 * @typedef {object} ObservationDigest
 * @property {Observation[]} obs
 * @property {string[]} edited Edited-file basenames.
 * @property {number} nCalls
 * @property {Array<{need: string[], sets: Record<string, string>, ok: boolean, call?: number}>} env
 */

/**
 * @typedef {object} ModelOptions
 * @property {string} [repo]
 * @property {Vocabulary} [vocab]
 * @property {number} [maxFacts]
 * @property {number} [maxTokens]
 */

/**
 * @typedef {object} UpdateOptions
 * @property {string} [iid] Session/task identity, for the telemetry digest.
 * @property {boolean|null} [resolved] Whether the session ended green, for the telemetry digest.
 */

/**
 * @typedef {object} FactVerdict
 * @property {'confirm'|'contradict'|null} verdict
 * @property {boolean} fired
 * @property {boolean} exercised
 */

/**
 * @typedef {object} FactRow
 * @property {string} id
 * @property {string} family
 * @property {string} state
 * @property {string} fire `n/m`
 * @property {number} rate Firing rate, rounded to 2 decimals.
 * @property {boolean} injectable
 * @property {string} claim First 120 characters of the claim.
 */

// --------------------------------------------------------------------------------------
// the model
// --------------------------------------------------------------------------------------

/**
 * Learns and injects environment facts over a repository's session stream.
 *
 * Interface parity with upstream's `EnvFactsDistiller` (envfacts.py:222-246):
 * `update(observation)` folds one finished session, `render()` returns the block
 * for the NEXT session ('' if none), `injectedIds()`/`seedInjected(ids)` carry
 * the "what this session was given" set across processes, and
 * `toJSON()`/`EnvFactsModel.fromJSON()` are the persistence pair.
 *
 * `optTokens` is invariant at 0: nothing here is paid.
 */
export class EnvFactsModel {
  /**
   * @param {ModelOptions} [options]
   */
  constructor(options = {}) {
    /** @type {string} */
    this.repo = String(options.repo ?? '')
    /** @type {Vocabulary} */
    this.vocab = options.vocab ?? DEFAULT_VOCAB
    /** @type {number} */
    this.maxFacts = Number(options.maxFacts || MAX_FACTS)
    /** @type {number} */
    this.maxTokens = Number(options.maxTokens || MAX_TOKENS)
    /** @type {number} */
    this.now = 0
    /** @type {Map<string, EnvFact>} */
    this.facts = new Map()
    /** @type {number} Invariant: the environment-fact layer is LLM-free. */
    this.optTokens = 0
    /** @type {Set<string>} */
    this.lastInjected = new Set()
    /** @type {Record<string, any>|null} */
    this.lastDigest = null
  }

  /** @returns {string} */
  get header() {
    return this.vocab.generic ? GENERIC_HEADER : HEADER
  }

  // ---- render --------------------------------------------------------------------

  /**
   * The block for the next session: header + one bullet per fact, '' when
   * nothing qualifies. Records the chosen ids for a later fold in this process.
   *
   * @returns {string}
   */
  render() {
    const chosen = this.select()
    this.lastInjected = new Set(chosen.map((fact) => fact.id))
    if (chosen.length === 0) return ''
    return `${this.linesText(chosen)}\n`
  }

  /**
   * The ids of the facts the last `render` chose: what the next session is given.
   *
   * @returns {string[]}
   */
  injectedIds() {
    return [...this.lastInjected].sort()
  }

  /**
   * Say which facts the session about to be folded was actually given. A caller
   * that renders in one process and folds in another (a session-start hook, then
   * a fold after the session) must, or an injected fact never counts as having
   * fired and decays out of the block while it works.
   *
   * Upstream: `seed_injected`, envfacts.py:264-269.
   *
   * @param {Iterable<string>} ids
   * @returns {void}
   */
  seedInjected(ids) {
    /** @type {Set<string>} */
    const seeded = new Set()
    for (const id of ids ?? []) {
      if (typeof id === 'string' && this.facts.has(id)) seeded.add(id)
    }
    this.lastInjected = seeded
  }

  /**
   * The claims that would be injected now, one string each (no header).
   *
   * @returns {string[]}
   */
  injectableClaims() {
    return this.select().map((fact) => fact.claim())
  }

  /**
   * The triage view for `te facts`-style status output: one row per tracked fact.
   *
   * @returns {FactRow[]}
   */
  factsView() {
    /** @type {FactRow[]} */
    const rows = []
    for (const [id, fact] of this.facts) {
      rows.push({
        id,
        family: fact.family,
        state: fact.state,
        fire: `${fact.life.fireNum}/${fact.life.fireDen}`,
        rate: Math.round(fact.firingRate() * 100) / 100,
        injectable: fact.injectable(),
        claim: fact.claim().slice(0, 120),
      })
    }
    return rows
  }

  /**
   * Header + bullet lines for a set of facts, without the trailing newline.
   *
   * @param {EnvFact[]} facts
   * @returns {string}
   */
  linesText(facts) {
    const lines = this.mergedLines(facts).map((text) => `- ${sanitizeOneLine(text)}`)
    return [this.header, ...lines].join('\n')
  }

  /**
   * The facts that would be injected, chosen greedily under the caps.
   * Upstream: `_select`, envfacts.py:275-292.
   *
   * @returns {EnvFact[]}
   */
  select() {
    const candidates = [...this.facts.values()].filter((fact) => {
      if (!fact.injectable()) return false
      const claim = fact.claim()
      return claim !== '' && lintOk(claim)
    })
    candidates.sort((left, right) => {
      const leftPriority = FAMILY_PRIORITY[left.family] ?? 9
      const rightPriority = FAMILY_PRIORITY[right.family] ?? 9
      if (leftPriority !== rightPriority) return leftPriority - rightPriority
      const leftInterpreter = left.params.intent === 'run_interpreter' ? 0 : 1
      const rightInterpreter = right.params.intent === 'run_interpreter' ? 0 : 1
      if (leftInterpreter !== rightInterpreter) return leftInterpreter - rightInterpreter
      return right.firingRate() - left.firingRate()
    })
    /** @type {EnvFact[]} */
    const chosen = []
    for (const fact of candidates) {
      const trial = [...chosen, fact]
      if (trial.length > this.maxFacts) break
      if (this.linesText(trial).length > this.maxTokens * 4) continue
      chosen.push(fact)
    }
    return chosen
  }

  /**
   * FormRepair facts whose working forms share a root (the same activation
   * prefix or the same directory) collapse into one line: they are one
   * environment fact. Upstream: `_merged_lines`, envfacts.py:294-313.
   *
   * @param {EnvFact[]} facts
   * @returns {string[]}
   */
  mergedLines(facts) {
    /** @type {string[]} */
    const lines = []
    /** @type {Map<string, EnvFact[]>} */
    const groups = new Map()
    for (const fact of facts) {
      if (fact.family === 'form_repair') {
        const key = rootKey(fact.workingForm() ?? '')
        const group = groups.get(key)
        if (group === undefined) groups.set(key, [fact])
        else group.push(fact)
      } else {
        lines.push(fact.claim())
      }
    }
    for (const group of groups.values()) {
      if (group.length === 1) {
        lines.unshift(group[0].claim())
        continue
      }
      const aForms = join(group.map((fact) => usage(String(fact.params.a ?? ''))))
      const errors = [...new Set(group.map((fact) => ERROR_PHRASE[fact.best('error_counts') ?? ''] ?? ''))].filter((text) => text !== '').sort()
      const bs = [...new Set(group.map((fact) => usage(fact.workingForm() ?? '')))].sort()
      lines.unshift(`${aForms} fail here (${errors.join(', ') || 'environment error'}); ${join(bs)} ${bs.length === 1 ? 'works' : 'work'}.`)
    }
    return lines
  }

  // ---- update --------------------------------------------------------------------

  /**
   * Fold one finished session's observation digest into the fact lifecycles.
   *
   * Upstream: `update`, envfacts.py:316-521. The transcript read and the
   * `now += 1` failure path are the adapter's business now: this method takes
   * the digest the adapter already produced.
   *
   * @param {ObservationDigest} observation
   * @param {UpdateOptions} [options]
   * @returns {Record<string, any>} The per-session telemetry digest.
   */
  update(observation, options = {}) {
    const obs = Array.isArray(observation?.obs) ? observation.obs : []
    const files = new Set(Array.isArray(observation?.edited) ? observation.edited : [])
    const env = Array.isArray(observation?.env) ? observation.env : []
    const injected = new Set(this.lastInjected)
    /** @type {Record<string, FactVerdict>} */
    const verdicts = {}
    /** @type {Map<string, Observation[]>} */
    const byIntent = new Map()
    for (const item of obs) {
      const group = byIntent.get(item.intent)
      if (group === undefined) byIntent.set(item.intent, [item])
      else group.push(item)
    }

    // ---- FormRepair: discover candidates, then fold every fact ----
    for (const intent of ['run_interpreter', 'run_tests', 'run_build', 'package_tool']) {
      const seq = byIntent.get(intent) ?? []
      // A test run that failed because its LABEL did not load says nothing
      // about the way the runner was called: those are ArgRepair's.
      const fails = seq.filter((item) => formFailed(item)).filter((item) => intent === 'run_tests' || intent === 'run_build' || isBare(item.form))
      for (const a of fails) {
        const repaired = seq.some((item) => typedOk(item) && item.call > a.call && repairs(item.form, a.form, intent))
        if (!repaired) continue
        const id = `form_repair:${intent}:${a.form}`
        let fact = this.facts.get(id)
        if (fact === undefined) {
          fact = new EnvFact(id, 'form_repair', false, { intent, a: a.form, b_counts: {}, error_counts: {} })
          this.facts.set(id, fact)
        }
        const errors = countRecord(fact.params, 'error_counts')
        const outcome = a.outcome ?? ''
        errors[outcome] = (errors[outcome] ?? 0) + 1
      }
      // A session is one piece of evidence per form: every form that worked as
      // typed adds one, and a known working form that failed as typed (and never
      // worked) takes one back -- so one messy session cannot outvote several
      // clean ones, and a form that stops working stops being named.
      const ok = new Set(seq.filter((item) => typedOk(item)).map((item) => item.form))
      const failed = new Set(seq.filter((item) => formFailed(item) && !item.env).map((item) => item.form))
      for (const form of ok) failed.delete(form)
      for (const fact of this.facts.values()) {
        if (fact.family !== 'form_repair' || fact.params.intent !== intent) continue
        const bCounts = countRecord(fact.params, 'b_counts')
        const aForm = String(fact.params.a ?? '')
        for (const form of ok) {
          if (repairs(form, aForm, intent)) bCounts[form] = (bCounts[form] ?? 0) + 1
        }
        const bFails = countRecord(fact.params, 'b_fails')
        for (const form of failed) {
          if (bCounts[form] !== undefined) bFails[form] = (bFails[form] ?? 0) + 1
        }
      }
    }
    for (const fact of [...this.facts.values()].filter((item) => item.family === 'form_repair')) {
      const intent = String(fact.params.intent ?? '')
      const aForm = String(fact.params.a ?? '')
      const seq = byIntent.get(intent) ?? []
      const exercised = seq.length > 0
      const aFailed = seq.some((item) => item.form === aForm && formFailed(item))
      const bForms = new Set(Object.keys(numericRecord(fact.params.b_counts)))
      const bRan = seq.some((item) => bForms.has(item.form) && formWorked(item)) || seq.some((item) => formWorked(item) && !isBare(item.form))
      // Contradiction: the bare form ran the TEST RUNNER without an environment
      // error. A bare interpreter one-liner succeeding is not evidence (a
      // pure-Python package imports from the working tree under any interpreter).
      const aRunnerOk = (byIntent.get('run_tests') ?? []).some((item) => item.form === aForm && formWorked(item))
      const fired = aFailed || (injected.has(fact.id) && bRan && !aFailed)
      /** @type {'confirm'|'contradict'|null} */
      let verdict = null
      if (aFailed || (bRan && !aRunnerOk)) verdict = 'confirm'
      else if (aRunnerOk) verdict = 'contradict'
      foldFact(fact, this.now, verdict, fired, exercised, files)
      verdicts[fact.id] = { verdict, fired, exercised }
    }

    // ---- ArgRepair: labels the runner loads only in another shape ----
    const runs = (byIntent.get('run_tests') ?? []).filter((item) => item.labels.length > 0)
    for (let index = 0; index < runs.length; index += 1) {
      const aObs = runs[index]
      if (!aObs.labelErr) continue
      for (const aLabel of aObs.labels) {
        for (const bObs of runs.slice(index + 1)) {
          if (bObs.form !== aObs.form || !bObs.loaded) continue
          /** @type {[string, string]|null} */
          let rule = null
          for (const bLabel of bObs.labels) {
            rule = labelRule(aLabel, bLabel)
            if (rule !== null) break
          }
          if (rule === null) continue
          let bMatch = ''
          for (const bLabel of bObs.labels) {
            const candidate = labelRule(aLabel, bLabel)
            if (candidate !== null && candidate[0] === rule[0] && candidate[1] === rule[1]) {
              bMatch = bLabel
              break
            }
          }
          const id = `arg_repair:${aObs.form}:${rule[0]}:${rule[1]}`
          let fact = this.facts.get(id)
          if (fact === undefined) {
            fact = new EnvFact(id, 'arg_repair', false, { form: aObs.form, kind: rule[0], param: rule[1], examples: {} })
            this.facts.set(id, fact)
          }
          const examples = countRecord(fact.params, 'examples')
          const key = `${aLabel} ${bMatch}`
          examples[key] = (examples[key] ?? 0) + 1
          break
        }
      }
    }
    for (const fact of [...this.facts.values()].filter((item) => item.family === 'arg_repair')) {
      const form = String(fact.params.form ?? '')
      const kind = String(fact.params.kind ?? '')
      const param = String(fact.params.param ?? '')
      const mine = runs.filter((item) => item.form === form)
      /** @param {string} label @returns {boolean} */
      const bad = (label) => (kind === 'sep' ? label.includes('::') : label.startsWith(param))
      const badFailed = mine.some((item) => item.labelErr && item.labels.some((label) => bad(label)))
      const badLoaded = mine.some((item) => item.loaded && item.labels.some((label) => bad(label)))
      const goodLoaded = mine.some((item) => item.loaded && item.labels.some((label) => !bad(label)))
      const exercised = mine.length > 0
      const fired = badFailed || (injected.has(fact.id) && goodLoaded && !badFailed)
      /** @type {'confirm'|'contradict'|null} */
      let verdict = null
      if (badLoaded) verdict = 'contradict'
      else if (badFailed || goodLoaded) verdict = 'confirm'
      foldFact(fact, this.now, verdict, fired, exercised, files)
      verdicts[fact.id] = { verdict, fired, exercised }
    }

    // ---- EnvValue: a variable the code asks for, and the value that satisfied it ----
    for (let index = 0; index < env.length; index += 1) {
      const call = env[index]
      for (const variable of call.need) {
        const later = env.slice(index + 1).filter((item) => Object.prototype.hasOwnProperty.call(item.sets, variable))
        const good = later.filter((item) => item.ok && !item.need.includes(variable)).map((item) => item.sets[variable])
        if (good.length === 0) continue
        const id = `env_value:${variable}`
        let fact = this.facts.get(id)
        if (fact === undefined) {
          fact = new EnvFact(id, 'env_value', false, { var: variable, good: {}, bad: {} })
          this.facts.set(id, fact)
        }
        const goodCounts = countRecord(fact.params, 'good')
        goodCounts[good[0]] = (goodCounts[good[0]] ?? 0) + 1
        const badCounts = countRecord(fact.params, 'bad')
        for (const item of later) {
          if (!item.ok && item.sets[variable] !== good[0]) {
            const value = item.sets[variable]
            badCounts[value] = (badCounts[value] ?? 0) + 1
          }
        }
      }
    }
    for (const fact of [...this.facts.values()].filter((item) => item.family === 'env_value')) {
      const variable = String(fact.params.var ?? '')
      const good = fact.best('good')
      const asked = env.some((item) => item.need.includes(variable))
      const goodOk = env.some((item) => item.sets[variable] === good && item.ok)
      const goodFailed = env.some((item) => item.sets[variable] === good && item.need.includes(variable))
      const exercised = asked || env.some((item) => Object.prototype.hasOwnProperty.call(item.sets, variable))
      const fired = asked || (injected.has(fact.id) && goodOk)
      // Only the value working confirms the fact: code asking for the variable
      // again shows the waste recurs (it fires), not that the value is right.
      /** @type {'confirm'|'contradict'|null} */
      let verdict = null
      if (goodFailed) verdict = 'contradict'
      else if (goodOk) verdict = 'confirm'
      foldFact(fact, this.now, verdict, fired, exercised, files)
      verdicts[fact.id] = { verdict, fired, exercised }
    }

    // ---- Boundary: hosts refused ----
    const fetches = byIntent.get('fetch_remote') ?? []
    /** @type {Map<string, number>} */
    const failedHosts = new Map()
    /** @type {Set<string>} */
    const reachableHosts = new Set()
    for (const item of fetches) {
      if (item.outcome !== null && NETWORK_ERRORS.has(item.outcome)) {
        for (const host of item.hosts) failedHosts.set(host, (failedHosts.get(host) ?? 0) + 1)
      }
      if (item.outcome === 'ran') {
        for (const host of item.hosts) reachableHosts.add(host)
      }
    }
    const boundaryId = 'boundary:fetch_remote'
    let boundary = this.facts.get(boundaryId)
    if (boundary === undefined && failedHosts.size > 0) {
      boundary = new EnvFact(boundaryId, 'boundary', true, { hosts: {} })
      this.facts.set(boundaryId, boundary)
    }
    if (boundary !== undefined) {
      const hosts = countRecord(boundary.params, 'hosts')
      for (const [host, count] of failedHosts) hosts[host] = (hosts[host] ?? 0) + count
      const known = new Set(Object.keys(hosts))
      const exercised = fetches.some((item) => item.hosts.length > 0)
      const fired = failedHosts.size > 0
      /** @type {'confirm'|'contradict'|null} */
      let verdict = null
      if ([...reachableHosts].some((host) => known.has(host))) verdict = 'contradict'
      else if (failedHosts.size > 0) verdict = 'confirm'
      foldFact(boundary, this.now, verdict, fired, exercised, files)
      verdicts[boundaryId] = { verdict, fired, exercised }
    }

    // ---- EmptyProbe: refs beyond the checkout ----
    const probes = (byIntent.get('probe_vcs_refs') ?? []).filter((item) => item.outcome === 'hit' || item.outcome === 'empty')
    const probeId = 'empty_probe:vcs_refs'
    let probe = this.facts.get(probeId)
    if (probe === undefined && probes.length > 0) {
      probe = new EnvFact(probeId, 'empty_probe', true, { kinds: {} })
      this.facts.set(probeId, probe)
    }
    if (probe !== undefined) {
      const kinds = countRecord(probe.params, 'kinds')
      for (const item of probes) {
        if (item.probe === null) continue
        kinds[item.probe] = (kinds[item.probe] ?? 0) + 1
      }
      const exercised = probes.length > 0
      const fired = exercised
      /** @type {'confirm'|'contradict'|null} */
      let verdict = null
      if (probes.some((item) => item.outcome === 'hit')) verdict = 'contradict'
      else if (probes.length > 0) verdict = 'confirm'
      foldFact(probe, this.now, verdict, fired, exercised, files)
      verdicts[probeId] = { verdict, fired, exercised }
    }

    this.lastDigest = {
      iid: options.iid ?? '',
      resolved: options.resolved ?? null,
      injected: [...injected].sort(),
      verdicts,
      nCalls: Number(observation?.nCalls ?? 0),
    }
    this.lastInjected = new Set()
    this.now += 1
    return this.lastDigest
  }

  // ---- persistence -------------------------------------------------------------

  /**
   * The upstream envfacts state document: `{repo, now, opt_tokens, vocab, facts}`.
   *
   * @returns {{repo: string, now: number, opt_tokens: number, vocab: string, facts: Record<string, any>}}
   */
  toJSON() {
    /** @type {Record<string, any>} */
    const facts = {}
    for (const [id, fact] of this.facts) facts[id] = fact.toJSON()
    return { repo: this.repo, now: this.now, opt_tokens: 0, vocab: this.vocab.name, facts }
  }

  /**
   * Restore a model from a persisted document. Tolerant by design (UPSTREAM §8.1
   * weakness 5: upstream raises on malformed JSON and fails the fold): invalid
   * fact documents are skipped, a missing/unknown vocab falls back to the
   * generic reading, and a non-object document becomes an empty model.
   *
   * @param {unknown} doc
   * @param {ModelOptions} [options]
   * @returns {EnvFactsModel}
   */
  static fromJSON(doc, options = {}) {
    const record = doc !== null && typeof doc === 'object' ? /** @type {Record<string, any>} */ (doc) : {}
    const model = new EnvFactsModel({
      ...options,
      repo: options.repo ?? (typeof record.repo === 'string' ? record.repo : ''),
      vocab: options.vocab ?? vocabularyByName(record.vocab),
    })
    if (typeof record.now === 'number' && Number.isFinite(record.now) && record.now >= 0) model.now = record.now
    const facts = objectRecord(record.facts)
    for (const [id, factDoc] of Object.entries(facts)) {
      try {
        model.facts.set(id, EnvFact.fromJSON(factDoc))
      } catch {
        // A corrupt fact costs that fact, not the whole learned state.
      }
    }
    return model
  }
}
