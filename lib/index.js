/**
 * dsh-tokeneconomizer plugin entry.
 *
 * This is a Cordis plugin for the DeepSeek Harness. It is intentionally thin:
 * the host-facing wiring lives in `lib/dsh/` and the mechanism logic lives in
 * dependency-free modules under `lib/`. Runtime imports of harness packages are
 * avoided so the plugin keeps working across DSH patch releases; the only
 * runtime dependency is the configuration schema library used by DSH itself.
 *
 * Failure policy: a plugin error must never break the user's session. The
 * entry catches its own initialization failures, records a redacted diagnostic,
 * and leaves the session running as if the plugin were not installed.
 *
 * @module dsh-tokeneconomizer
 */

import { resolveEffectiveConfig } from './config.js'
import { Config } from './config-schema.js'

export { Config }

/** Stable Cordis plugin name. */
export const name = 'dsh-tokeneconomizer'

/**
 * Services this plugin reads through the host context. Both live in every
 * agent-capable DSH profile (`dsh-base`); a minimal composition without them
 * keeps the fiber pending rather than failing the host.
 */
export const inject = ['systemPrompt', 'tools']

/**
 * @typedef {import('@deepseek-ai/cordis').Context} Context
 * @typedef {import('./config.js').TokenEconomizerConfig} TokenEconomizerConfig
 */

/**
 * Initialize the plugin. Cordis calls this once when the profile row loads and
 * disposes every registered effect when the row unloads.
 *
 * @param {Context} ctx Host context.
 * @param {Partial<TokenEconomizerConfig>} [rawConfig] Validated profile configuration.
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  /** @type {{ config: TokenEconomizerConfig, warnings: string[] }} */
  let resolved
  try {
    resolved = resolveEffectiveConfig(rawConfig, process.env)
  } catch (error) {
    // Config validation failures are user errors; report them clearly but do
    // not take the host down.
    ctx.logger?.('tokeneconomizer')?.warn?.('configuration rejected: %s', errorMessage(error))
    return
  }

  const { config, warnings } = resolved
  for (const warning of warnings) ctx.logger?.('tokeneconomizer')?.warn?.('%s', warning)

  if (!config.enabled) {
    ctx.logger?.('tokeneconomizer')?.info?.('disabled by configuration or TE_DISABLE')
    return
  }

  // The full wiring is installed lazily so a missing optional service (for
  // example in a minimal profile) degrades instead of failing the host boot.
  void import('./dsh/install.js')
    .then((mod) => mod.install(ctx, config))
    .then((installed) => {
      if (installed === false) ctx.logger?.('tokeneconomizer')?.info?.('plugin loaded; no compatible host services found')
    })
    .catch((error) => {
      ctx.logger?.('tokeneconomizer')?.warn?.('initialization failed: %s', errorMessage(error))
    })
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

export default apply
// `apply.Config` lets the profile loader validate YAML configuration with the
// same schema that `--dump-config-schema` exposes.
apply.Config = Config
