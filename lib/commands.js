/**
 * Command surface shared by the DSH slash command and the terminal CLI.
 *
 * The dispatcher is intentionally free of Cordis types: the adapter supplies the
 * project runtime and the small set of mutating mechanism hooks. Both entry
 * points therefore render identical text and share the same semantics.
 *
 * @module dsh-tokeneconomizer/commands
 */

import { DEFAULTS, MICROSKILLS_MODES, TOOLPRUNE_MODES, LOOPGUARD_MODES } from './config.js'
import { readDiagnostics } from './diagnostics.js'
import {
  buildStatus,
  renderConfigText,
  renderHelpText,
  renderMicroskillsText,
  renderStatusText,
  renderToolpruneText,
  renderUsageText,
} from './report.js'
import { VERSION } from './version.js'

/**
 * @typedef {object} CommandContext
 * @property {import('./dsh/project-runtime.js').ProjectRuntime} runtime
 * @property {import('./config.js').TokenEconomizerConfig} config Effective plugin config.
 * @property {string} dataDir Plugin data directory.
 * @property {string[]} argv Command line split into tokens.
 * @property {{
 *   applyToolprune: () => Promise<{ applied: string[], error?: string }>,
 *   restoreToolprune: (tools: string[]) => Promise<{ restored: string[], error?: string }>,
 *   refreshCatalog: () => Promise<{ tools: number }>,
 *   resetProject: () => Promise<boolean>,
 *   forgetFact: (id: string) => boolean,
 *   setOverride: (key: string, value: unknown) => boolean,
 *   unsetOverride: (key: string) => boolean,
 *   effectiveConfig: () => import('./config.js').TokenEconomizerConfig,
 * }} hooks
 */

/**
 * Run one command line.
 *
 * @param {CommandContext} context
 * @returns {Promise<{ kind: 'success'|'error', text: string }>}
 */
export async function runCommand(context) {
  const { runtime, argv, dataDir } = context
  const [command = 'status', ...rest] = argv
  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      return success(renderHelpText())
    case '--version':
    case '-V':
      return success(VERSION)
    case 'status':
      return status(runtime, context, rest)
    case 'microskills':
    case 'facts':
      return microskills(runtime, context, rest)
    case 'toolprune':
    case 'untool':
      return await toolprune(runtime, context, rest)
    case 'config':
      return configCommand(runtime, context, rest)
    case 'usage':
      return usage(runtime, context)
    case 'diagnostics':
    case 'doctor': {
      const records = readDiagnostics(dataDir, 20)
      if (records.length === 0) return success('no diagnostics recorded')
      return success(records.map((record) => `${record.at} ${record.level} ${record.scope}: ${record.message}${record.error ? ` (${record.error})` : ''}`).join('\n'))
    }
    case 'reset':
      return await reset(runtime, context, rest)
    default:
      return error(`unknown command '${command}'\n\n${renderHelpText()}`)
  }
}

/**
 * @param {string} text
 * @returns {{kind:'success', text:string}}
 */
function success(text) {
  return { kind: 'success', text }
}

/**
 * @param {string} text
 * @returns {{kind:'error', text:string}}
 */
function error(text) {
  return { kind: 'error', text }
}

/**
 * View learned knowledge, or delete one fact.
 *
 * @param {CommandContext['runtime']} runtime
 * @param {CommandContext} context
 * @param {string[]} rest
 * @returns {{kind:'success'|'error', text:string}}
 */
function microskills(runtime, context, rest) {
  const action = rest[0]
  if (action === 'forget' || action === 'delete') {
    const id = rest[1]
    if (typeof id !== 'string' || id.trim() === '') {
      return error('microskills forget needs a fact id (run `microskills` first to list them)')
    }
    const removed = context.hooks.forgetFact(id.trim())
    return removed
      ? success(`microskills: forgot fact '${id.trim()}'`)
      : error(`microskills: no fact with id '${id.trim()}'`)
  }
  return success(renderMicroskillsText(buildStatus(runtime, { config: context.hooks.effectiveConfig(), dataDir: context.dataDir })))
}

/**
 * @param {CommandContext['runtime']} runtime
 * @param {CommandContext} context
 * @param {string[]} rest
 * @returns {Promise<{kind:'success'|'error', text:string}>}
 */
async function status(runtime, context, rest) {
  const view = buildStatus(runtime, { config: context.hooks.effectiveConfig(), dataDir: context.dataDir })
  if (rest.includes('--json')) return success(JSON.stringify(view, null, 2))
  return success(renderStatusText(view))
}

/**
 * @param {CommandContext['runtime']} runtime
 * @param {CommandContext} context
 * @param {string[]} rest
 * @returns {Promise<{kind:'success'|'error', text:string}>}
 */
async function toolprune(runtime, context, rest) {
  const action = rest[0] ?? 'show'
  const config = context.hooks.effectiveConfig()
  if (action === 'show' || action === 'status') {
    return success(renderToolpruneText(buildStatus(runtime, { config, dataDir: context.dataDir })))
  }
  if (action === 'apply') {
    const result = await context.hooks.applyToolprune()
    if (result.error) return error(`toolprune apply refused: ${result.error}`)
    return success(result.applied.length === 0
      ? 'toolprune: nothing to apply (no proposal with enough evidence)'
      : `toolprune: applied ${result.applied.join(', ')} — pruned tool definitions are removed from this project's next model requests`)
  }
  if (action === 'restore') {
    const tools = rest.slice(1)
    const result = await context.hooks.restoreToolprune(tools)
    if (result.error) return error(`toolprune restore failed: ${result.error}`)
    return success(result.restored.length === 0
      ? 'toolprune: nothing to restore'
      : `toolprune: restored ${result.restored.join(', ')} — restored tools will not be pruned again`)
  }
  if (action === 'refresh-catalog') {
    const result = await context.hooks.refreshCatalog()
    return success(`toolprune: catalog refreshed from recorded request headers (${result.tools} tool(s) known)`)
  }
  return error(`unknown toolprune action '${action}' (show, apply, restore, refresh-catalog)`)
}

/**
 * @param {CommandContext['runtime']} runtime
 * @param {CommandContext} context
 * @param {string[]} rest
 * @returns {{kind:'success'|'error', text:string}}
 */
function configCommand(runtime, context, rest) {
  const action = rest[0] ?? 'show'
  if (action === 'show' || action === undefined) {
    return success(renderConfigText(context.hooks.effectiveConfig(), runtime.overrides()))
  }
  if (action === 'set') {
    const pairs = rest.slice(1)
    if (pairs.length === 0) return error('config set needs one or more key=value pairs')
    const applied = []
    for (const pair of pairs) {
      const index = pair.indexOf('=')
      if (index <= 0) return error(`invalid setting '${pair}'; expected key=value`)
      const key = pair.slice(0, index)
      const value = pair.slice(index + 1)
      const parsed = parseSetting(key, value)
      if (parsed === undefined) return error(`unknown or invalid setting '${key}'; see status/config catalog`)
      if (!context.hooks.setOverride(key, parsed.value)) return error(`could not persist ${key}`)
      applied.push(`${key}=${JSON.stringify(parsed.value)}`)
    }
    return success(`config: set ${applied.join(', ')} for this project (applies to the next agent/session)`)
  }
  if (action === 'unset') {
    const keys = rest.slice(1)
    if (keys.length === 0) return error('config unset needs one or more setting names')
    for (const key of keys) {
      if (!(key in DEFAULTS)) return error(`unknown setting '${key}'`)
      context.hooks.unsetOverride(key)
    }
    return success(`config: unset ${keys.join(', ')} for this project`)
  }
  return error(`unknown config action '${action}' (show, set, unset)`)
}

/**
 * Parse and validate one project-scoped setting value.
 *
 * @param {string} key
 * @param {string} raw
 * @returns {{value: unknown}|undefined} Undefined when the key/value is invalid.
 */
export function parseSetting(key, raw) {
  if (!(key in DEFAULTS)) return undefined
  const defaults = /** @type {Record<string, unknown>} */ (DEFAULTS)
  const current = defaults[key]
  if (key === 'microskills') {
    return MICROSKILLS_MODES.includes(raw) ? { value: raw } : undefined
  }
  if (key === 'toolprune') {
    return TOOLPRUNE_MODES.includes(raw) ? { value: raw } : undefined
  }
  if (key === 'loopguard') {
    return LOOPGUARD_MODES.includes(raw) ? { value: raw } : undefined
  }
  if (key === 'diagnostics') {
    return raw === 'redacted' || raw === 'off' ? { value: raw } : undefined
  }
  if (typeof current === 'boolean') {
    if (['1', '0', 'on', 'off', 'true', 'false', 'yes', 'no'].includes(raw.toLowerCase())) {
      return { value: ['1', 'on', 'true', 'yes'].includes(raw.toLowerCase()) }
    }
    return undefined
  }
  if (typeof current === 'number') {
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return undefined
    if (parsed < 0) return undefined
    return { value: parsed }
  }
  if (Array.isArray(current)) {
    return { value: raw.split(',').map((item) => item.trim()).filter((item) => item !== '') }
  }
  if (key === 'dataDir') return { value: raw }
  return undefined
}

/**
 * @param {CommandContext['runtime']} runtime
 * @param {CommandContext} context
 * @returns {{kind:'success', text:string}}
 */
function usage(runtime, context) {
  const view = buildStatus(runtime, { config: context.hooks.effectiveConfig(), dataDir: context.dataDir })
  return success(renderUsageText(view, runtime.readLedger(50)))
}

/**
 * @param {CommandContext['runtime']} runtime
 * @param {CommandContext} context
 * @param {string[]} rest
 * @returns {Promise<{kind:'success'|'error', text:string}>}
 */
async function reset(runtime, context, rest) {
  if (!rest.includes('--yes') && !rest.includes('-y')) {
    return error(`reset deletes this project's learned state (facts, evidence, ledger).\nRe-run as 'reset --yes' to confirm.`)
  }
  const ok = await context.hooks.resetProject()
  return ok
    ? success(`reset: deleted learned state for this project (${runtime.recordProject().label})`)
    : error('reset failed: the state directory could not be cleared')
}
