/**
 * The lifecycle every learned fact goes through, whoever proposed it.
 *
 * Ported from `tokeneconomizer/microskills/lifecycle.py` (Apache-2.0,
 * microsoft/TokenEconomizer @ e428fc9). Modified for the DSH port: ESM, a
 * camelCase object API, and an upstream-compatible JSON shape (`toJSON`
 * emits the exact snake_case keys upstream persists, so fact state written
 * by the Python version translates).
 *
 * A fact is a CANDIDATE until it is confirmed on K_PROMOTE tasks -- tasks that
 * edited different files, for a fact about the code (stable across the
 * repository's history, not one task's coincidence); any K_PROMOTE tasks, for
 * a fact about the environment, which does not change with the files a task
 * edits (`drift=false`). It is then ACTIVE until a recency-weighted score,
 * with contradictions weighted LAMBDA times a confirmation, falls below the
 * floor -- or at once, for a high-stakes fact, on one clean contradiction. An
 * ACTIVE fact is injected only while it clears the firing gate: the waste it
 * prevents occurred (or, once injected, kept being prevented) on at least
 * FIRE_GATE of the tasks that exercised it.
 *
 * Deterministic and side-effect free: `now` is always an explicit task index,
 * never wall-clock time.
 *
 * @module dsh-tokeneconomizer/microskills/lifecycle
 */

// ---- lifecycle knobs (the validated replay constants; lifecycle.py:15-21) ----
/** Confirmations (drifted, where drift applies) to promote -> ACTIVE. */
export const K_PROMOTE = 3
/** Recency decay per task-ago. */
export const GAMMA = 0.8
/** Contradiction weight (asymmetry: fail toward retirement). */
export const LAMBDA = 5.0
/** Retire ACTIVE when recency score < floor. */
export const SCORE_FLOOR = 0.0
/** High-stakes fact: single clean contradiction retires now. */
export const HARD_KILL = true
/** Inject only if the firing rate on this repository is at least this. */
export const FIRE_GATE = 0.4
/** ... measured over at least this many exercised tasks. */
export const FIRE_MIN_N = 4

/**
 * One lifecycle state value. Kept as a string union rather than an enum so a
 * persisted document round-trips through plain JSON unchanged.
 *
 * @typedef {'CANDIDATE'|'ACTIVE'|'RETIRED'} LifecycleState
 */

/**
 * A verdict a family hands the lifecycle for one task.
 *
 * @typedef {'confirm'|'contradict'|null} Verdict
 */

/**
 * The persisted shape of a lifecycle. This is upstream's `to_dict` verbatim;
 * keeping the snake_case names is deliberate (see module docstring).
 *
 * @typedef {object} LifecycleDoc
 * @property {string} key Stable fact identity.
 * @property {boolean} high High-stakes fact: one clean contradiction retires it.
 * @property {boolean} drift True when promotion needs confirmations on different files.
 * @property {LifecycleState} state Current lifecycle state.
 * @property {Array<[number, string[]]>} confirms `[taskIndex, editedFileBasenames]` per confirmation.
 * @property {number[]} contradicts Task indices whose task contradicted the fact.
 * @property {number} fire_num Tasks where the waste the fact prevents occurred.
 * @property {number} fire_den Tasks where the fact was exercised.
 * @property {number|null} promoted_at Task index of promotion, or null.
 * @property {number|null} retired_at Task index of retirement, or null.
 */

/**
 * The shared state machine for one learned fact.
 */
export class Lifecycle {
  /**
   * @param {string} key Stable fact identity (`family:params...`).
   * @param {boolean} high High-stakes fact: one clean contradiction retires it.
   * @param {boolean} [drift] True when promotion needs confirmations on different
   *   edited files; environment facts pass `false` (envfacts.py:74).
   */
  constructor(key, high, drift = true) {
    /** @type {string} */
    this.key = key
    /** @type {boolean} */
    this.high = high
    /** @type {boolean} */
    this.drift = drift
    /** @type {LifecycleState} */
    this.state = 'CANDIDATE'
    /** @type {Array<[number, string[]]>} */
    this.confirms = []
    /** @type {number[]} */
    this.contradicts = []
    /** @type {number} */
    this.fireNum = 0
    /** @type {number} */
    this.fireDen = 0
    /** @type {number|null} */
    this.promotedAt = null
    /** @type {number|null} */
    this.retiredAt = null
  }

  /**
   * The persisted document, with upstream's exact snake_case keys.
   *
   * @returns {LifecycleDoc}
   */
  toJSON() {
    return {
      key: this.key,
      high: this.high,
      drift: this.drift,
      state: this.state,
      confirms: this.confirms.map(([task, files]) => [task, [...files]]),
      contradicts: [...this.contradicts],
      fire_num: this.fireNum,
      fire_den: this.fireDen,
      promoted_at: this.promotedAt,
      retired_at: this.retiredAt,
    }
  }

  /**
   * Restore one lifecycle from a persisted document. Faithful to upstream's
   * `from_dict` (lifecycle.py:72-76): `drift` comes from the document, and the
   * state machine fields are restored as-is. Callers that want environment
   * drift semantics force `drift=false` themselves (envfacts.py:142).
   *
   * Throws a `TypeError` when the document is not a lifecycle document; the
   * tolerance for corrupt persisted state lives at the state-document level
   * (`stage.stateFromJSON`).
   *
   * @param {unknown} doc
   * @returns {Lifecycle}
   */
  static fromJSON(doc) {
    if (doc === null || typeof doc !== 'object') {
      throw new TypeError('Lifecycle.fromJSON: document must be an object')
    }
    const record = /** @type {Record<string, unknown>} */ (doc)
    if (typeof record.key !== 'string' || record.key === '') {
      throw new TypeError('Lifecycle.fromJSON: missing key')
    }
    if (typeof record.high !== 'boolean') {
      throw new TypeError('Lifecycle.fromJSON: missing high')
    }
    const life = new Lifecycle(record.key, record.high)
    if (typeof record.drift === 'boolean') life.drift = record.drift
    if (record.state === 'CANDIDATE' || record.state === 'ACTIVE' || record.state === 'RETIRED') {
      life.state = record.state
    }
    if (Array.isArray(record.confirms)) {
      /** @type {Array<[number, string[]]>} */
      const confirms = []
      for (const entry of record.confirms) {
        if (!Array.isArray(entry) || entry.length < 2) continue
        const task = entry[0]
        const files = entry[1]
        if (typeof task !== 'number' || !Array.isArray(files)) continue
        confirms.push([task, files.filter((file) => typeof file === 'string')])
      }
      life.confirms = confirms
    }
    if (Array.isArray(record.contradicts)) {
      life.contradicts = record.contradicts.filter((task) => typeof task === 'number')
    }
    if (typeof record.fire_num === 'number') life.fireNum = record.fire_num
    if (typeof record.fire_den === 'number') life.fireDen = record.fire_den
    if (typeof record.promoted_at === 'number') life.promotedAt = record.promoted_at
    if (typeof record.retired_at === 'number') life.retiredAt = record.retired_at
    return life
  }

  /**
   * Confirmations that count toward promotion. With `drift`, each kept
   * confirmation must involve a file set disjoint from every earlier kept
   * confirmation (a fact about the code must not be one task's coincidence);
   * a confirmation with no file set always counts. With `drift=false` every
   * confirmation counts.
   *
   * Upstream: `_drifted_confirms`, lifecycle.py:78-86.
   *
   * @returns {number}
   */
  driftedConfirms() {
    if (!this.drift) return this.confirms.length
    /** @type {Array<Set<string>>} */
    const kept = []
    for (const [, files] of this.confirms) {
      const set = new Set(files)
      if (set.size === 0 || kept.every((prior) => intersects(set, prior) === false)) {
        kept.push(set)
      }
    }
    return kept.length
  }

  /**
   * Recency-weighted score: confirmations add `GAMMA^(now - task)`,
   * contradictions subtract `LAMBDA * GAMMA^(now - task)`.
   *
   * @param {number} now Current task index.
   * @returns {number}
   */
  score(now) {
    let total = 0
    for (const [task] of this.confirms) total += GAMMA ** (now - task)
    for (const task of this.contradicts) total -= LAMBDA * GAMMA ** (now - task)
    return total
  }

  /**
   * How often exercising this fact came with the waste it prevents.
   *
   * @returns {number} 0 when never exercised.
   */
  firingRate() {
    return this.fireDen > 0 ? this.fireNum / this.fireDen : 0
  }

  /**
   * ACTIVE and clears the firing gate -> goes into the rendered notes.
   *
   * @returns {boolean}
   */
  injectable() {
    return this.state === 'ACTIVE' && this.fireDen >= FIRE_MIN_N && this.firingRate() >= FIRE_GATE
  }

  /**
   * Fold one task's verdict into the state machine. Upstream: `update`,
   * lifecycle.py:102-117.
   *
   * @param {number} now Task index.
   * @param {Verdict} verdict
   * @param {boolean} fired The waste the fact prevents occurred this task.
   * @param {boolean} exercised The fact was relevant this task.
   * @param {Iterable<string>} files Edited-file basenames this task.
   * @returns {void}
   */
  update(now, verdict, fired, exercised, files) {
    if (exercised) {
      this.fireDen += 1
      if (fired) this.fireNum += 1
    }
    if (verdict === 'confirm') {
      this.confirms.push([now, [...files].sort()])
    } else if (verdict === 'contradict') {
      this.contradicts.push(now)
    }
    if (this.state === 'CANDIDATE') {
      if (this.driftedConfirms() >= K_PROMOTE) {
        this.state = 'ACTIVE'
        this.promotedAt = now
      }
    } else if (this.state === 'ACTIVE') {
      const hard = this.high && verdict === 'contradict' && HARD_KILL
      if (hard || this.score(now) < SCORE_FLOOR) {
        this.state = 'RETIRED'
        this.retiredAt = now
      }
    }
  }
}

/**
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {boolean}
 */
function intersects(a, b) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  for (const value of small) {
    if (large.has(value)) return true
  }
  return false
}
