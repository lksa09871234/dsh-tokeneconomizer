/**
 * Tool-pruning proposal policy: hold a proposal, wait out the repository's
 * quiet period, apply it, refuse it safely, and take tools back.
 *
 * Ported from `tokeneconomizer/plugin/fold.py` (`_hold`, `apply_pending`,
 * `last_activity`, the protected-tool restore in `_fold_toolprune`) and the
 * upstream `toolprune restore` semantics, Apache-2.0, microsoft/TokenEconomizer
 * e428fc91b0f8ffecb5a596d56b14fe2f1485a5f9. Modified for the DSH port:
 * - pure state machine over the {@link ToolPruneState} document; the DSH
 *   adapter persists it through `lib/store.js` and performs the actual tool
 *   restriction write (upstream edits each agent's settings file here);
 * - all decisions take explicit `now`/`lastActivity` Unix-second values;
 * - `propose` mode keeps a proposal visible but never mutates `applied`;
 * - a pending list is dropped when the mode is no longer `apply`
 *   (upstream test `test_live_hooks.py:744`);
 * - `restore` marks tools as given back forever (never proposed again).
 *
 * Upstream rules preserved:
 * - `apply` holds a new list instead of writing immediately; it writes once the
 *   repository's sessions have been idle for `quietMinutes` (q=60), or once the
 *   list has waited `pendingMaxSeconds` (24 h) — never earlier
 *   (`fold.py:42-51,51,312-341`);
 * - a refusal (unreadable/committed/redirected settings file) is recorded and
 *   the proposal survives for a later retry (`fold.py:337-340`);
 * - a tool that has since become protected is given back by removing the
 *   plugin's own rule (`fold.py:139-151`);
 * - tools in the give-back list are never proposed again (`fold.py:136-138,184`).
 *
 * @module dsh-tokeneconomizer/toolprune/policy
 */

import {
  cloneState,
  normalizeState,
  normalizeThresholds,
  DEFAULT_THRESHOLDS,
} from './evidence.js'
import { effectiveProtectedTools } from './tools.js'

/**
 * @typedef {import('./evidence.js').ToolPruneState} ToolPruneState
 */

/** @typedef {'off'|'propose'|'apply'} ToolpruneMode */

/**
 * @typedef {object} HoldOptions
 * @property {ToolpruneMode} mode Mechanism mode. Only `apply` may hold a list.
 * @property {number} now Unix seconds.
 * @property {string|null} [root] Repository root recorded with the pending list.
 */

/**
 * @typedef {object} ApplyDecision
 * @property {boolean} apply True when the adapter should write the deny list now.
 * @property {string[]} items Tools to write (applied/given-back entries removed).
 * @property {string} reason Why (`idle`, `pending-max-age`, `waiting`, `no-pending`, `nothing-pending`, `mode`).
 * @property {number|null} waitSeconds When waiting: seconds until it is worth looking again.
 */

/**
 * @typedef {object} NowOptions
 * @property {number} now Unix seconds.
 */

/**
 * @param {ToolPruneState} state
 * @returns {ToolPruneState}
 */
function clearPending(state) {
  return normalizeState({ ...state, auto_pending: null })
}

/**
 * Hold the current proposal for a later apply. A no-op (and clears any older
 * pending list) unless the mechanism is in `apply` mode and the proposal is
 * non-empty. The `since` timestamp of an already-waiting list is preserved, so
 * repeated folds cannot extend the wait forever.
 *
 * @param {ToolPruneState} state
 * @param {HoldOptions} options
 * @returns {ToolPruneState}
 */
export function holdProposal(state, options) {
  const current = normalizeState(state)
  if (options?.mode !== 'apply') return clearPending(current)
  if (current.proposal.length === 0) return clearPending(current)
  const items = current.proposal
    .filter((tool) => !current.applied.includes(tool) && !current.kept.includes(tool))
    .sort()
  if (items.length === 0) return clearPending(current)
  const since = current.auto_pending ? current.auto_pending.since : options.now
  return normalizeState({
    ...current,
    auto_pending: {
      items,
      root: typeof options.root === 'string' && options.root.length > 0 ? options.root : null,
      since,
    },
  })
}

/**
 * Decide whether a held list may be written now.
 *
 * The list waits while the repository is still active and it is younger than
 * the 24 h cap; once every session has been idle for `quietMinutes`, or the
 * list is older than the cap, it is applied even if sessions never pause.
 *
 * @param {ToolPruneState} state
 * @param {{
 *   now: number,
 *   lastActivity?: number|null,
 *   quietMinutes?: number,
 *   pendingMaxSeconds?: number,
 *   mode?: ToolpruneMode,
 * }} options
 * @returns {ApplyDecision}
 */
export function shouldApply(state, options) {
  const current = normalizeState(state)
  const mode = options?.mode ?? 'apply'
  if (mode !== 'apply') {
    return { apply: false, items: [], reason: 'mode', waitSeconds: null }
  }
  const pending = current.auto_pending
  if (!pending) {
    return { apply: false, items: [], reason: 'no-pending', waitSeconds: null }
  }
  const applied = new Set(current.applied)
  const kept = new Set(current.kept)
  const items = pending.items.filter((tool) => !applied.has(tool) && !kept.has(tool)).sort()
  if (items.length === 0) {
    return { apply: false, items: [], reason: 'nothing-pending', waitSeconds: null }
  }
  const thresholds = normalizeThresholds({
    quietMinutes: options.quietMinutes,
    pendingMaxSeconds: options.pendingMaxSeconds,
  })
  const now = typeof options.now === 'number' && Number.isFinite(options.now) ? options.now : 0
  const lastActivity = typeof options.lastActivity === 'number' && Number.isFinite(options.lastActivity)
    ? options.lastActivity
    : 0
  const idleSeconds = Math.max(0, now - lastActivity)
  const quietSeconds = thresholds.quietMinutes * 60
  const waitedSeconds = Math.max(0, now - pending.since)

  if (idleSeconds < quietSeconds && waitedSeconds < thresholds.pendingMaxSeconds) {
    return {
      apply: false,
      items,
      reason: 'waiting',
      waitSeconds: Math.min(quietSeconds - idleSeconds, thresholds.pendingMaxSeconds - waitedSeconds),
    }
  }
  return {
    apply: true,
    items,
    reason: idleSeconds >= quietSeconds ? 'idle' : 'pending-max-age',
    waitSeconds: null,
  }
}

/**
 * Record a successful write: the tools become the applied set, leave the
 * proposal, and the pending list is cleared.
 *
 * @param {ToolPruneState} state
 * @param {{ items: string[], now: number }} options
 * @returns {ToolPruneState}
 */
export function markApplied(state, options) {
  const current = normalizeState(state)
  const applied = new Set(current.applied)
  for (const tool of options.items) {
    if (typeof tool === 'string' && tool.length > 0) applied.add(tool)
  }
  const written = [...new Set(options.items.filter((tool) => typeof tool === 'string' && tool.length > 0))].sort()
  return normalizeState({
    ...current,
    applied: [...applied].sort(),
    proposal: current.proposal.filter((tool) => !written.includes(tool)),
    auto_pending: null,
    auto_applied: written,
    auto_apply_refused: null,
  })
}

/**
 * Record a refused write. The proposal is kept for a later retry; the pending
 * list is cleared (the next fold re-holds it with a fresh `since`).
 *
 * @param {ToolPruneState} state
 * @param {{ error: string }} options
 * @returns {ToolPruneState}
 */
export function markRefused(state, options) {
  const current = normalizeState(state)
  const message = typeof options?.error === 'string' && options.error.length > 0
    ? options.error
    : 'apply refused'
  return normalizeState({
    ...current,
    auto_pending: null,
    auto_apply_refused: message,
  })
}

/**
 * Give tools back: remove the plugin's own entries and remember them so they
 * are never proposed again.
 *
 * @param {ToolPruneState} state
 * @param {ReadonlyArray<string>} tools
 * @returns {ToolPruneState}
 */
export function restoreTools(state, tools) {
  const current = normalizeState(state)
  const given = new Set(
    tools.filter((tool) => typeof tool === 'string' && tool.length > 0),
  )
  if (given.size === 0) return cloneState(current)
  const applied = current.applied.filter((tool) => !given.has(tool))
  const kept = new Set(current.kept)
  for (const tool of given) kept.add(tool)
  return normalizeState({
    ...current,
    applied,
    kept: [...kept].sort(),
    proposal: current.proposal.filter((tool) => !given.has(tool)),
  })
}

/**
 * Take back rules for tools that have since become protected (the work
 * surface, web tools, a profile's new `protectedTools` entry). Only the
 * plugin's own applied rules are removed; the tools are already protected, so
 * they are not added to `kept`.
 *
 * @param {ToolPruneState} state
 * @param {{ protectedTools?: ReadonlyArray<string> }} [options]
 * @returns {ToolPruneState}
 */
export function restoreProtectedTools(state, options = {}) {
  const current = normalizeState(state)
  const protectedSet = effectiveProtectedTools(options.protectedTools ?? [])
  const restored = current.applied.filter((tool) => protectedSet.has(tool)).sort()
  if (restored.length === 0) {
    return normalizeState({ ...current, restored_protected: [] })
  }
  const restoredSet = new Set(restored)
  return normalizeState({
    ...current,
    applied: current.applied.filter((tool) => !restoredSet.has(tool)),
    proposal: current.proposal.filter((tool) => !restoredSet.has(tool)),
    auto_pending: current.auto_pending
      ? { ...current.auto_pending, items: current.auto_pending.items.filter((tool) => !restoredSet.has(tool)) }
      : null,
    restored_protected: restored,
  })
}

/**
 * Tools the person gave back; they are never proposed again.
 * @param {ToolPruneState} state
 * @returns {string[]}
 */
export function givenBack(state) {
  return [...normalizeState(state).kept]
}

/**
 * The tools waiting out the quiet period (after removing applied/kept).
 * @param {ToolPruneState} state
 * @returns {string[]}
 */
export function pendingItems(state) {
  const current = normalizeState(state)
  if (!current.auto_pending) return []
  const applied = new Set(current.applied)
  const kept = new Set(current.kept)
  return current.auto_pending.items.filter((tool) => !applied.has(tool) && !kept.has(tool))
}

export { DEFAULT_THRESHOLDS }
