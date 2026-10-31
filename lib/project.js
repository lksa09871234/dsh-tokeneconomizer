/**
 * Project identity and state-directory resolution.
 *
 * TokenEconomizer learns per repository. DSH sessions can start in any working
 * directory, so state is keyed by a normalized project root: a hash of the
 * realpath when it exists, else of the normalized absolute path. The hash keeps
 * machine paths out of directory names while remaining stable across restarts.
 *
 * No function here touches the network or a project's files beyond realpath
 * resolution.
 *
 * @module dsh-tokeneconomizer/project
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Resolve the DeepSeek Harness home the same way DSH does for its own data:
 * an explicit launcher-provided home wins, then `$DSH_HOME`, then `~/.dsh`.
 * (A plugin normally receives the launcher-resolved home through the
 * `profileContext` service; the environment fallback covers CLI/tests.)
 *
 * @param {string} [explicit] Absolute or tilde path from plugin config.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [launcherHome] Home resolved by the launcher (`profileContext.home`).
 * @returns {string} Absolute path; never throws for a blank value.
 */
export function resolveDshHome(explicit = '', env = process.env, launcherHome = '') {
  if (explicit.trim() !== '') return expandHome(explicit.trim(), env)
  if (typeof launcherHome === 'string' && launcherHome.trim() !== '') {
    return path.resolve(expandHome(launcherHome.trim(), env))
  }
  const fromEnv = env.DSH_HOME
  if (fromEnv !== undefined && fromEnv.trim() !== '') return path.resolve(expandHome(fromEnv.trim(), env))
  return path.join(os.homedir(), '.dsh')
}

/**
 * Resolve the plugin's state directory. `dataDir` always wins; otherwise the
 * state lives under the DSH home so it is never inside a user project and never
 * picked up by the project's version control.
 *
 * @param {string} dataDir Configured `dataDir` (may be empty).
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [launcherHome] Home resolved by the launcher.
 * @returns {string} Absolute, normalized state directory (not created here).
 */
export function stateDirForConfig(dataDir, env = process.env, launcherHome = '') {
  const trimmed = dataDir.trim()
  if (trimmed !== '') return path.resolve(expandHome(trimmed, env))
  return path.join(resolveDshHome('', env, launcherHome), 'tokeneconomizer')
}

/**
 * Expand only the documented tilde forms (`~`, `~/x`, `~\x`); other forms are
 * left untouched so the plugin never guesses at another user's home.
 *
 * @param {string} value
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function expandHome(value, env = process.env) {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    const rest = value.slice(1).replace(/^[\\/]+/, '')
    return path.join(os.homedir(), rest)
  }
  // A relative path is resolved against the caller's cwd by path.resolve later;
  // keep it untouched here so behavior is predictable.
  void env
  return value
}

/**
 * Normalize a project root for hashing and display. Uses `realpathSync.native`
 * when the directory exists (stable across symlinked and junctioned spellings),
 * falling back to `path.resolve` for paths that do not exist yet.
 *
 * @param {string} root Absolute or relative project directory.
 * @param {string} [cwd] Base for relative inputs.
 * @returns {string} Normalized absolute path.
 */
export function normalizeProjectRoot(root, cwd = process.cwd()) {
  const absolute = path.resolve(cwd, root)
  try {
    return fs.realpathSync.native(absolute)
  } catch {
    return absolute
  }
}

/**
 * Detect the repository root that should own a session's learned state: the
 * nearest ancestor (including the directory itself) that contains a `.git`
 * entry, else the session's own working directory. Walking up makes sessions
 * started in a subdirectory share the project's state, which is what upstream's
 * per-repository learning does. No `git` subprocess is started.
 *
 * @param {string} cwd Session working directory (absolute).
 * @returns {string} Normalized project root.
 */
export function detectProjectRoot(cwd) {
  const start = normalizeProjectRoot(cwd)
  let current = start
  for (let depth = 0; depth < 40; depth += 1) {
    try {
      if (fs.existsSync(path.join(current, '.git'))) return current
    } catch {
      return start
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return start
}

/**
 * Stable, filesystem-safe project key. The first 32 hex characters of the
 * SHA-256 of the normalized path are used: collision risk is negligible for a
 * local plugin and the result is short enough for Windows path limits.
 *
 * @param {string} normalizedRoot Output of {@link normalizeProjectRoot}.
 * @returns {string}
 */
export function projectKey(normalizedRoot) {
  return crypto.createHash('sha256').update(normalizedRoot, 'utf8').digest('hex').slice(0, 32)
}

/**
 * Directory holding one project's learned state.
 *
 * @param {string} stateDir Plugin state directory.
 * @param {string} normalizedRoot Normalized project root.
 * @returns {string}
 */
export function projectStateDir(stateDir, normalizedRoot) {
  return path.join(stateDir, 'projects', projectKey(normalizedRoot))
}

/**
 * Symbolic display form of an absolute path for logs and `te status`: never
 * expose the machine home path.
 *
 * @param {string} target Absolute path.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function displayPath(target, env = process.env) {
  const dshHome = resolveDshHome('', env)
  const home = os.homedir()
  const relDsh = safeRelative(target, dshHome)
  if (relDsh !== undefined) return relDsh === '' ? '$DSH_HOME' : `$DSH_HOME/${relDsh}`
  const relHome = safeRelative(target, home)
  if (relHome !== undefined) return relHome === '' ? '~' : `~/${relHome}`
  return target
}

/**
 * @param {string} target
 * @param {string} parent
 * @returns {string|undefined} POSIX-style relative path, '' for the parent
 * itself, or undefined when target is outside parent.
 */
function safeRelative(target, parent) {
  const rel = path.relative(parent, target)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined
  return rel.split(path.sep).join('/')
}
