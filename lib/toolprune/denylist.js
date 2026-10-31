/**
 * The DSH deny-list model for tool pruning: which tool names the adapter should
 * remove from the model's tool set, derived from the policy document.
 *
 * Ported from the policy half of `tokeneconomizer/plugin/denylist.py`,
 * Apache-2.0, microsoft/TokenEconomizer at commit
 * e428fc91b0f8ffecb5a596d56b14fe2f1485a5f9. Modified for the DSH port:
 * - upstream writes each agent's own settings file (`permissions.deny` JSON,
 *   `.codex/config.toml` capabilities, Copilot MCP servers). This module writes
 *   nothing; it returns the deny set for the DSH adapter, which is expected to
 *   apply it with the harness's tool-restriction mechanism (for example a
 *   `{ deny: [...] }` mask passed to `tools.restrict()`), and to keep the
 *   plugin's own entries separate from any user-authored rules;
 * - only single tool names are modelled (the Claude-Code unit upstream); the
 *   Copilot whole-MCP-server and Codex capability-package units are not ported;
 * - `applied_for` / `kept_for` semantics are preserved: `applied` is what the
 *   plugin itself left out, `kept` is what the person gave back.
 *
 * Upstream rules preserved:
 * - protected tools are never denied, even if a stale `applied` entry exists
 *   (`plugin/fold.py:139-151`; `toolprune/tools.py:40-48`);
 * - a tool in `kept` is never written again (`fold.py:136-138,184`);
 * - only the plugin's own entries may be removed on restore; the DSH adapter
 *   must not touch user-authored restrictions (documented contract, enforced
 *   at the adapter level because the policy module does not see user rules).
 *
 * @module dsh-tokeneconomizer/toolprune/denylist
 */

import { PROTECTED_TOOLS, effectiveProtectedTools } from './tools.js'
import { normalizeState } from './evidence.js'

/**
 * @typedef {import('./evidence.js').ToolPruneState} ToolPruneState
 */

/**
 * @typedef {object} DenyList
 * @property {string[]} deny Tool names to remove from the model's tool set, sorted.
 * @property {string[]} skippedProtected Applied entries skipped because they are protected now.
 * @property {string[]} applied The plugin's own applied entries (upstream `applied_for`).
 * @property {string[]} kept Tools given back by the person (upstream `kept_for`).
 */

/**
 * The protected set including a profile's configured extensions.
 * @param {ReadonlyArray<string>} [extra]
 * @returns {string[]} Sorted union.
 */
export function mergeProtectedTools(extra = []) {
  return [...effectiveProtectedTools(extra)].sort()
}

/**
 * Derive the DSH deny list from the policy document. Pure and deterministic.
 *
 * The adapter should write only `deny` and remember it as its own contribution;
 * `skippedProtected` exists so a stale rule can be reported/given back via
 * `policy.restoreProtectedTools` rather than silently kept.
 *
 * @param {ToolPruneState} state
 * @param {{ protectedTools?: ReadonlyArray<string> }} [options]
 * @returns {DenyList}
 */
export function computeDenyList(state, options = {}) {
  const current = normalizeState(state)
  const protectedSet = effectiveProtectedTools(options.protectedTools ?? [])
  const deny = []
  const skippedProtected = []
  for (const tool of current.applied) {
    if (protectedSet.has(tool)) skippedProtected.push(tool)
    else deny.push(tool)
  }
  return {
    deny: deny.sort(),
    skippedProtected: skippedProtected.sort(),
    applied: [...current.applied],
    kept: [...current.kept],
  }
}

/**
 * Upstream `denylist.applied_for`: the tools the plugin itself left out.
 * @param {ToolPruneState} state
 * @returns {string[]}
 */
export function appliedFor(state) {
  return [...normalizeState(state).applied]
}

/**
 * Upstream `denylist.kept_for`: the tools the person gave back.
 * @param {ToolPruneState} state
 * @returns {string[]}
 */
export function keptFor(state) {
  return [...normalizeState(state).kept]
}

/**
 * Whether the model should be denied the named tool under this document.
 * @param {string} tool Tool name.
 * @param {ToolPruneState} state
 * @param {{ protectedTools?: ReadonlyArray<string> }} [options]
 * @returns {boolean}
 */
export function isDenied(tool, state, options = {}) {
  if (typeof tool !== 'string' || tool.length === 0) return false
  const protectedSet = effectiveProtectedTools(options.protectedTools ?? [])
  if (protectedSet.has(tool)) return false
  return normalizeState(state).applied.includes(tool)
}

/**
 * The default protected names, exposed for the adapter's status output.
 * @type {ReadonlyArray<string>}
 */
export const DEFAULT_PROTECTED_TOOLS = PROTECTED_TOOLS
