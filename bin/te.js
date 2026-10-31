#!/usr/bin/env node
/**
 * dsh-tokeneconomizer command line: inspect and edit the plugin's local state
 * without starting an agent or spending model tokens.
 *
 * The same command language is exposed as the `/tokeneconomizer` DSH slash
 * command; both read and write the same per-project state.
 *
 * @module dsh-tokeneconomizer/bin/te
 */

import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { runCommand } from '../lib/commands.js'
import { applyEnvOverrides, resolveEffectiveConfig } from '../lib/config.js'
import { readDiagnostics } from '../lib/diagnostics.js'
import { normalizeProjectRoot, stateDirForConfig } from '../lib/project.js'
import { ProjectRuntime } from '../lib/dsh/project-runtime.js'
import { Mechanisms } from '../lib/dsh/mechanisms.js'
import { VERSION } from '../lib/version.js'

const USAGE = `dsh-tokeneconomizer ${VERSION}

Usage: te [--cwd <dir>] [--data-dir <dir>] <command> [args]

Commands:
  status [--json]              what was learned/recorded for this project
  microskills                  learned facts (deterministic and model-assisted)
  microskills forget <id>      delete one learned fact
  toolprune [show]             pruning evidence, proposal and applied list
  toolprune apply              enable the current proposal for this project
  toolprune restore [tools]    give pruned tools back (never proposed again)
  toolprune refresh-catalog    refresh the recorded tool catalog count
  config show                  every setting in effect
  config set key=value         override a setting for this project
  config unset key             remove a project override
  usage                        recorded token usage (no prices, no savings)
  diagnostics                  recent redacted plugin diagnostics
  reset --yes                  delete this project's learned state
  help                         this text

Options:
  --cwd <dir>        project directory to inspect (default: current directory)
  --data-dir <dir>   override the state directory for this invocation

Environment:
  TE_DATA_DIR        state directory when --data-dir is not given
  DSH_HOME           DSH home used when TE_DATA_DIR is unset

State lives outside your project (default: <DSH_HOME>/tokeneconomizer). The
command never starts a model request.`

/**
 * @param {string[]} argv
 * @returns {Promise<{ code: number, output: string, error: string }>}
 */
export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv)
  if (parsed.error) return { code: 2, output: '', error: `te: ${parsed.error}\n\n${USAGE}` }
  if (parsed.command === 'help' || parsed.command === '--help' || parsed.command === '-h') {
    return { code: 0, output: `${USAGE}\n`, error: '' }
  }
  if (parsed.command === '--version' || parsed.command === '-V') {
    return { code: 0, output: `${VERSION}\n`, error: '' }
  }

  const cwd = typeof parsed.options.cwd === 'string' ? parsed.options.cwd : process.cwd()
  const root = normalizeProjectRoot(cwd)
  const dataDir = stateDirForConfig(
    typeof parsed.options['data-dir'] === 'string' ? parsed.options['data-dir'] : (process.env.TE_DATA_DIR ?? ''),
  )
  const base = resolveEffectiveConfig(undefined, process.env)
  const config = base.config
  if (base.warnings.length > 0) {
    for (const warning of base.warnings) process.stderr.write(`te: config warning: ${warning}\n`)
  }
  if (!config.enabled) {
    process.stderr.write('te: the plugin is disabled by configuration or TE_DISABLE; showing recorded state only\n')
  }
  const runtime = ProjectRuntime.open(dataDir, root, config)
  const mechanisms = new Mechanisms({ config: base.config, dataDir })

  /**
   * Effective config for the CLI: defaults, then project overrides, then env.
   * (The profile-level YAML defaults are not readable from an isolated CLI, so
   * they are documented as profile-owned; project overrides and TE_* apply.)
   */
  const effective = () => {
    /** @type {Record<string, unknown>} */
    const merged = { ...config }
    for (const [key, value] of Object.entries(runtime.overrides())) {
      if (key in merged) /** @type {Record<string, unknown>} */ (merged)[key] = value
    }
    return applyEnvOverrides(/** @type {any} */ (merged), process.env).config
  }

  const argvForCommand = [parsed.command, ...parsed.rest]
  try {
    const result = await runCommand({
      runtime,
      config: effective(),
      dataDir,
      argv: argvForCommand,
      hooks: {
        effectiveConfig: effective,
        setOverride: (key, value) => runtime.setOverride(key, value),
        unsetOverride: (key) => runtime.unsetOverride(key),
        applyToolprune: async () => {
          const state = effective()
          const available = toolpruneCatalog(runtime)
          const result = mechanisms.applyToolpruneNow(runtime, state, available, Date.now())
          if (result.state) runtime.saveToolprune(result.state)
          return { applied: result.applied, error: result.error }
        },
        restoreToolprune: async (tools) => {
          const result = mechanisms.restoreToolprune(runtime, tools, Date.now())
          if (result.state) runtime.saveToolprune(result.state)
          return { restored: result.restored, error: result.error }
        },
        refreshCatalog: async () => ({ tools: toolpruneCatalog(runtime).length }),
        resetProject: async () => runtime.reset(),
        forgetFact: (id) => mechanisms.forgetFact(runtime, id),
      },
    })
    if (parsed.command === 'diagnostics' && result.text === 'no diagnostics recorded') {
      // Already rendered by the shared dispatcher.
    }
    return { code: result.kind === 'success' ? 0 : 1, output: `${result.text}\n`, error: '' }
  } catch (error) {
    const diagnostics = readDiagnostics(dataDir, 5)
    return {
      code: 1,
      output: '',
      error: `te: command failed: ${error instanceof Error ? error.message : String(error)}\n` +
        (diagnostics.length > 0 ? 'recent diagnostics are available with `te diagnostics`\n' : ''),
    }
  }
}

/**
 * Tool names known in the recorded catalog (used by CLI apply/refresh; the DSH
 * adapter intersects with the live profile's global tool universe instead).
 * @param {ProjectRuntime} runtime
 * @returns {string[]}
 */
function toolpruneCatalog(runtime) {
  const state = runtime.toolprune()
  const tools = state && typeof state === 'object' && Array.isArray(state.catalog_tools) ? state.catalog_tools : []
  return tools.filter((name) => typeof name === 'string')
}

/**
 * @param {string[]} argv
 * @returns {{ command: string, rest: string[], options: Record<string, string|boolean>, error?: string }}
 */
export function parseArgs(argv) {
  /** @type {Record<string, string|boolean>} */
  const options = {}
  /** @type {string[]} */
  const positional = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--cwd' || token === '--data-dir') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) return { command: '', rest: [], options, error: `${token} needs a value` }
      options[token.slice(2)] = value
      index += 1
    } else if (token.startsWith('--cwd=')) {
      options.cwd = token.slice('--cwd='.length)
    } else if (token.startsWith('--data-dir=')) {
      options['data-dir'] = token.slice('--data-dir='.length)
    } else if (token === '--json' || token === '--yes' || token === '-y') {
      positional.push(token)
    } else if (token.startsWith('--')) {
      return { command: '', rest: [], options, error: `unknown option '${token}'` }
    } else {
      positional.push(token)
    }
  }
  const [command = 'status', ...rest] = positional
  return { command, rest, options }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((result) => {
    if (result.output !== '') process.stdout.write(result.output)
    if (result.error !== '') process.stderr.write(result.error)
    process.exitCode = result.code
  }).catch((error) => {
    process.stderr.write(`te: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
