/**
 * Tool-pruning evidence: which loaded tools went unused, for how long, and
 * whether that is enough to propose leaving them out of later sessions.
 *
 * Ported from `tokeneconomizer/plugin/fold.py` (`_fold_toolprune`,
 * `enough_evidence`) and `tokeneconomizer/toolprune/stage.py` (the evidence
 * counters), Apache-2.0, microsoft/TokenEconomizer at commit
 * e428fc91b0f8ffecb5a596d56b14fe2f1485a5f9. Modified for the DSH port:
 * - pure functions, JSON state in/out; the DSH adapter persists the document
 *   through `lib/store.js`; no filesystem access here;
 * - all timestamps are explicit (`options.now`), so the module is deterministic;
 * - the upstream host writers are gone; the DSH deny-list model lives in
 *   `denylist.js` and the proposal/quiet-period state machine in `policy.js`;
 * - `applied`/`kept` are carried in the same document because the DSH adapter
 *   has one state document per project (upstream splits them across
 *   `untool.json` and the host deny-list file). Field names for the evidence
 *   itself are exactly upstream's.
 *
 * Upstream rules preserved (see docs/PORT-NOTES-toolprune.md):
 * - a tool "used" in a session is never proposed again, forever
 *   (`toolprune/stage.py:95-98,138-140`);
 * - unused streak: used this session -> 0, else +1 (`stage.py:190-194`);
 * - prompt streak: reset when used, else += that session's prompt count, with
 *   an unknown prompt count counting as one (`plugin/fold.py:113-114,159-163`);
 * - a session that ran no prompt is no evidence at all: it is not folded and
 *   does not advance the session counter (`fold.py:390-394`);
 * - enough evidence is `(unusedSessions >= m && unusedPrompts >= p*k) ||
 *   unusedSessions >= s*k`, with `k = 3` for a high-risk tool (`fold.py:97-106`);
 * - protected and already-applied/given-back tools are never proposed
 *   (`fold.py:165-167,180-185`; `toolprune/tools.py:40-48`).
 *
 * @module dsh-tokeneconomizer/toolprune/evidence
 */

import { HIGH_RISK_FACTOR, effectiveProtectedTools, HIGH_RISK_TOOLS } from './tools.js'

/**
 * @typedef {object} ToolpruneThresholds
 * @property {number} evidence Unused prompts required (upstream p, default 10).
 * @property {number} minSessions Sessions those prompts must span (upstream m, default 2).
 * @property {number} sessions Session count that alone is enough evidence (upstream s, default 5).
 * @property {number} quietMinutes Idle minutes before an apply may write (upstream q, default 60).
 * @property {number} pendingMaxSeconds A pending list older than this is applied regardless (default 24 h).
 */

/** @type {ToolpruneThresholds} */
export const DEFAULT_THRESHOLDS = Object.freeze({
  evidence: 10,
  minSessions: 2,
  sessions: 5,
  quietMinutes: 60,
  pendingMaxSeconds: 86_400,
})

/**
 * @typedef {object} CatalogObservation
 * @property {string[]} [tools] Tool names the session loaded.
 * @property {Record<string, string>} [descriptions] Tool name -> description.
 * @property {string|null} [source] Which catalog source produced the list.
 */

/**
 * One finished session as the tool-pruning mechanism sees it. A DSH adapter
 * builds this from the session's tool calls and loaded-tool catalog; it must
 * never include raw tool output.
 * @typedef {object} SessionObservation
 * @property {string[]} [toolsUsed] Tools the session called (any invocation counts).
 * @property {CatalogObservation|null} [catalog] The full catalog the session was offered, or null when unavailable.
 * @property {number|null} [prompts] User prompts in the session; null/unknown counts as 1, 0 means "no evidence".
 */

/**
 * @typedef {object} AutoPending
 * @property {string[]} items Tools waiting to be written to the deny list.
 * @property {string|null} root Repository root the list belongs to (closed-loop guard for the adapter).
 * @property {number} since Unix seconds when the list first waited.
 */

/**
 * The persisted tool-pruning document. Evidence fields are upstream's
 * `untool.json` names; `applied`/`kept` are the DSH port's deny-list state
 * (upstream keeps them in the host settings file's own records).
 * @typedef {object} ToolPruneState
 * @property {string[]} used_tools Every tool ever used here, sorted.
 * @property {Record<string, number>} streaks Consecutive folded sessions a catalog tool went unused.
 * @property {Record<string, number>} prompt_streaks Unused prompts accumulated while the tool went unused.
 * @property {string[]} catalog_tools Every tool ever seen loaded, sorted.
 * @property {Record<string, string>} catalog_desc Tool -> description (for status output and an optional judge).
 * @property {string|null} catalog_source Source of the last non-empty catalog.
 * @property {number} sessions Folds counted (sessions with at least one prompt).
 * @property {number} prompts Prompts counted across folded sessions.
 * @property {number|null} updated Unix seconds of the last fold.
 * @property {string[]} proposal Tools currently proposed for pruning (never applied/kept/protected).
 * @property {string[]} new_in_proposal Proposal entries not present at the previous fold.
 * @property {string[]} restored_protected Protected tools given back by the last policy pass.
 * @property {AutoPending|null} auto_pending A held deny list waiting out the quiet period.
 * @property {string[]|null} auto_applied Tools the last successful apply wrote.
 * @property {string|null} auto_apply_refused Reason the last apply was refused (unreadable/committed/redirected config).
 * @property {string[]} applied Tools currently left out of the catalog for this project.
 * @property {string[]} kept Tools the person gave back; never proposed again.
 */

/**
 * @typedef {object} FoldOptions
 * @property {number} now Unix seconds of the fold (required for determinism).
 * @property {Partial<ToolpruneThresholds>} [thresholds] Threshold overrides (defaults p=10/m=2/s=5).
 * @property {ReadonlyArray<string>} [protectedTools] Extra protected tool names from configuration.
 * @property {ReadonlyArray<string>} [highRiskTools] Extra high-risk tool names from configuration.
 */

/**
 * @param {number|undefined} value
 * @param {number} fallback
 * @param {number} min
 * @returns {number}
 */
function intAtLeast(value, fallback, min) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return n >= min ? n : min
}

/**
 * @param {Partial<ToolpruneThresholds>|undefined} overrides
 * @returns {ToolpruneThresholds}
 */
export function normalizeThresholds(overrides) {
  const o = overrides ?? {}
  return {
    evidence: intAtLeast(o.evidence, DEFAULT_THRESHOLDS.evidence, 1),
    minSessions: intAtLeast(o.minSessions, DEFAULT_THRESHOLDS.minSessions, 1),
    sessions: intAtLeast(o.sessions, DEFAULT_THRESHOLDS.sessions, 1),
    quietMinutes: intAtLeast(o.quietMinutes, DEFAULT_THRESHOLDS.quietMinutes, 0),
    pendingMaxSeconds: intAtLeast(o.pendingMaxSeconds, DEFAULT_THRESHOLDS.pendingMaxSeconds, 0),
  }
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function nonNegativeInt(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const n = Math.trunc(value)
  return n >= 0 ? n : fallback
}

/**
 * @param {unknown} value
 * @returns {string[]} Sorted unique non-empty strings.
 */
function stringArray(value) {
  if (!Array.isArray(value)) return []
  const out = new Set()
  for (const item of value) {
    if (typeof item === 'string' && item.length > 0) out.add(item)
  }
  return [...out].sort()
}

/**
 * @param {unknown} value
 * @returns {Record<string, number>} Counters with non-negative integer values.
 */
function counterRecord(value) {
  /** @type {Record<string, number>} */
  const out = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [key, raw] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
    if (key.length === 0) continue
    const n = nonNegativeInt(raw, -1)
    if (n >= 0) out[key] = n
  }
  return out
}

/**
 * @param {unknown} value
 * @returns {Record<string, string>}
 */
function descriptionRecord(value) {
  /** @type {Record<string, string>} */
  const out = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [key, raw] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
    if (key.length === 0) continue
    out[key] = typeof raw === 'string' ? raw : ''
  }
  return out
}

/**
 * @param {unknown} value
 * @returns {AutoPending|null}
 */
function normalizePending(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = /** @type {Record<string, unknown>} */ (value)
  const items = stringArray(raw.items)
  if (items.length === 0) return null
  return {
    items,
    root: typeof raw.root === 'string' && raw.root.length > 0 ? raw.root : null,
    since: nonNegativeInt(raw.since, 0),
  }
}

/**
 * Coerce any JSON value (a loaded document, a partial test fixture) into a
 * complete {@link ToolPruneState}. Unknown fields are ignored and invalid
 * counters are dropped, so a hand-edited or older document opens cleanly.
 *
 * @param {unknown} [raw]
 * @returns {ToolPruneState}
 */
export function normalizeState(raw) {
  const doc = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? /** @type {Record<string, unknown>} */ (raw)
    : {}
  return {
    used_tools: stringArray(doc.used_tools),
    streaks: counterRecord(doc.streaks),
    prompt_streaks: counterRecord(doc.prompt_streaks),
    catalog_tools: stringArray(doc.catalog_tools),
    catalog_desc: descriptionRecord(doc.catalog_desc),
    catalog_source: typeof doc.catalog_source === 'string' && doc.catalog_source.length > 0
      ? doc.catalog_source
      : null,
    sessions: nonNegativeInt(doc.sessions, 0),
    prompts: nonNegativeInt(doc.prompts, 0),
    updated: nonNegativeInt(doc.updated, 0) || null,
    proposal: stringArray(doc.proposal),
    new_in_proposal: stringArray(doc.new_in_proposal),
    restored_protected: stringArray(doc.restored_protected),
    auto_pending: normalizePending(doc.auto_pending),
    auto_applied: Array.isArray(doc.auto_applied) ? stringArray(doc.auto_applied) : null,
    auto_apply_refused: typeof doc.auto_apply_refused === 'string' && doc.auto_apply_refused.length > 0
      ? doc.auto_apply_refused
      : null,
    applied: stringArray(doc.applied),
    kept: stringArray(doc.kept),
  }
}

/**
 * Start a fresh document, optionally from a partial one.
 * @param {unknown} [partial]
 * @returns {ToolPruneState}
 */
export function createState(partial) {
  return normalizeState(partial)
}

/**
 * @param {ToolPruneState} state
 * @returns {ToolPruneState} A deep copy safe to mutate locally.
 */
export function cloneState(state) {
  return normalizeState(JSON.parse(JSON.stringify(state)))
}

/**
 * The JSON form persisted by the adapter (upstream schema names, sorted arrays).
 * @param {ToolPruneState} state
 * @returns {ToolPruneState}
 */
export function toJSON(state) {
  return cloneState(state)
}

/**
 * @param {unknown} raw
 * @returns {ToolPruneState}
 */
export function fromJSON(raw) {
  return normalizeState(raw)
}

/**
 * The evidence rule. `k = 3` for a high-risk tool, 1 otherwise.
 *
 * @param {number} unusedSessions Consecutive unused sessions (`streaks[tool]`).
 * @param {number} unusedPrompts Unused prompts accumulated (`prompt_streaks[tool]`).
 * @param {ToolpruneThresholds} [thresholds]
 * @param {boolean} [highRisk]
 * @returns {boolean}
 */
export function enoughEvidence(unusedSessions, unusedPrompts, thresholds = DEFAULT_THRESHOLDS, highRisk = false) {
  const t = normalizeThresholds(thresholds)
  const k = highRisk ? HIGH_RISK_FACTOR : 1
  return (
    (unusedSessions >= t.minSessions && unusedPrompts >= t.evidence * k) ||
    unusedSessions >= t.sessions * k
  )
}

/**
 * @param {FoldOptions} options
 * @returns {Set<string>}
 */
function highRiskSet(options) {
  const set = new Set(HIGH_RISK_TOOLS)
  for (const name of options.highRiskTools ?? []) {
    if (typeof name === 'string' && name.length > 0) set.add(name)
  }
  return set
}

/**
 * Recompute the proposal from the current counters without folding a session.
 * Used by the fold itself and by adapter status/repair paths.
 *
 * @param {ToolPruneState} state
 * @param {FoldOptions} options
 * @returns {string[]} Tools that should be proposed now (except applied/kept/protected/ever-used).
 */
export function computeProposal(state, options) {
  const thresholds = normalizeThresholds(options.thresholds)
  const protectedSet = effectiveProtectedTools(options.protectedTools)
  const high = highRiskSet(options)
  const used = new Set(state.used_tools)
  const applied = new Set(state.applied)
  const kept = new Set(state.kept)
  const candidateFloor = Math.max(1, thresholds.minSessions)
  /** @type {string[]} */
  const out = []
  for (const tool of state.catalog_tools) {
    if (protectedSet.has(tool) || used.has(tool) || applied.has(tool) || kept.has(tool)) continue
    const unusedSessions = state.streaks[tool] ?? 0
    const unusedPrompts = state.prompt_streaks[tool] ?? 0
    if (unusedSessions < candidateFloor) continue
    if (!enoughEvidence(unusedSessions, unusedPrompts, thresholds, high.has(tool))) continue
    out.push(tool)
  }
  return out.sort()
}

/**
 * @param {number|null|undefined} raw
 * @returns {number} The prompt count to use; 0 means "no evidence".
 */
function promptCount(raw) {
  if (raw === 0) return 0
  if (raw === null || raw === undefined) return 1
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 1
  return Math.max(1, Math.trunc(raw))
}

/**
 * Fold one finished session into the evidence document. Pure: the input state
 * is not mutated and a new normalized document is returned.
 *
 * A session with zero prompts changes nothing at all (upstream skips the fold:
 * "a session that ran no prompt is no evidence about the tools").
 *
 * @param {ToolPruneState} state
 * @param {SessionObservation} session
 * @param {FoldOptions} options
 * @returns {ToolPruneState}
 */
export function foldSession(state, session, options) {
  const current = normalizeState(state)
  const prompts = promptCount(session?.prompts)
  if (prompts === 0) return cloneState(current)

  const now = intAtLeast(options?.now, 0, 0)
  const catalog = session?.catalog ?? null
  const catalogTools = catalog?.tools ? stringArray(catalog.tools) : []
  const sessionUsed = stringArray(session?.toolsUsed)

  const used = new Set(current.used_tools)
  for (const tool of sessionUsed) used.add(tool)

  const catalogSet = new Set(current.catalog_tools)
  for (const tool of catalogTools) catalogSet.add(tool)

  /** @type {Record<string, string>} */
  const descriptions = { ...current.catalog_desc }
  for (const [name, description] of Object.entries(catalog?.descriptions ?? {})) {
    if (typeof description === 'string') descriptions[name] = description
  }

  /** @type {Record<string, number>} */
  const streaks = {}
  const usedThisSession = new Set(sessionUsed)
  for (const tool of catalogSet) {
    streaks[tool] = usedThisSession.has(tool) ? 0 : (current.streaks[tool] ?? 0) + 1
  }

  /** @type {Record<string, number>} */
  const promptStreaks = { ...current.prompt_streaks }
  for (const tool of catalogSet) {
    const previous = current.streaks[tool] ?? 0
    const next = streaks[tool] ?? 0
    if (next === 0) {
      promptStreaks[tool] = 0
    } else if (next === previous + 1) {
      promptStreaks[tool] = (promptStreaks[tool] ?? 0) + prompts
    }
  }

  const nextState = {
    ...current,
    used_tools: [...used].sort(),
    streaks,
    prompt_streaks: promptStreaks,
    catalog_tools: [...catalogSet].sort(),
    catalog_desc: descriptions,
    catalog_source: catalogTools.length > 0
      ? (catalog?.source ?? current.catalog_source)
      : current.catalog_source,
    sessions: current.sessions + 1,
    prompts: current.prompts + prompts,
    updated: now,
    restored_protected: [],
  }

  const proposal = computeProposal(nextState, options)
  return normalizeState({
    ...nextState,
    proposal,
    new_in_proposal: proposal.filter((tool) => !current.proposal.includes(tool)),
  })
}
