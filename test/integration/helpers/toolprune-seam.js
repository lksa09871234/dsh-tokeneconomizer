/**
 * Integration seam: how the pure tool-pruning core plugs into the real DSH
 * tool-restriction API.
 *
 * The plugin adapter is expected to do exactly this (with additional
 * persistence/announcement/error handling):
 *
 *   state -> computeDenyList(state) -> { deny } -> agentCtx.tools.restrict({ deny })
 *
 * `lib/toolprune/*` is pure policy; this file is the only place the integration
 * tests bridge it to the host. It is deliberately small so the Lead can lift or
 * rewrite it when wiring `lib/dsh/mechanisms.js`.
 *
 * @module dsh-tokeneconomizer/test/integration/helpers/toolprune-seam
 */

import { computeDenyList } from '../../../lib/toolprune/denylist.js'

/**
 * Compute and apply the DSH deny list for one agent scope.
 *
 * @param {any} agentCtx Agent-scoped context (must expose `tools.restrict`).
 * @param {import('../../../lib/toolprune/evidence.js').ToolPruneState} state Tool-pruning document.
 * @param {{ protectedTools?: ReadonlyArray<string> }} [options]
 * @returns {{ deny: string[], skippedProtected: string[], dispose: () => void }}
 */
export function applyToolPruneDeny(agentCtx, state, options = {}) {
  const { deny, skippedProtected } = computeDenyList(state, options)
  if (deny.length === 0) {
    return { deny, skippedProtected, dispose: () => {} }
  }
  const dispose = agentCtx.tools.restrict({ deny })
  return {
    deny,
    skippedProtected,
    dispose: typeof dispose === 'function' ? dispose : () => {},
  }
}

/**
 * The deny list the adapter would write for the model view.
 * @param {import('../../../lib/toolprune/evidence.js').ToolPruneState} state
 * @param {{ protectedTools?: ReadonlyArray<string> }} [options]
 * @returns {string[]}
 */
export function denyListFor(state, options = {}) {
  return computeDenyList(state, options).deny
}
